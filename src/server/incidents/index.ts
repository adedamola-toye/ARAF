/**
 * Incident management for genuine technical failures.
 *
 * - Correlation: a failure's fingerprint (where it happened + what kind of error, with every variable
 *   value stripped) joins the open incident with that fingerprint if it last occurred within the
 *   correlation window; otherwise a new incident starts. Unrelated failures never share a fingerprint
 *   just because they share an HTTP status.
 * - Allocation: each incident gets its own shuffle of the five approved messages. The k-th affected user
 *   (k = 0, 1, 2 …) receives message order[k mod 5], so after N users the counts differ by at most one and
 *   which messages carry the extra users varies by incident. The incident row is locked while a user is
 *   assigned, so concurrent requests cannot double-assign or unbalance the counts.
 * - Nothing here stores customer data: messages are sanitised and only error metadata is kept.
 */
import { createHash, randomInt } from "node:crypto";
import { db, withTx, type Db } from "../db";
import { config } from "../config";
import { enqueueEmail } from "../notify/outbox";
import { DomainError } from "../errors";
import { audit } from "../audit";
import type { Ctx } from "../context";
import { holdsRole } from "../domain/access";
import { statusLabel, type IncidentStatus, type IncidentView } from "@/lib/incident-messages";

export type IncidentSource = "render" | "action" | "api" | "client" | "network";
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
const SEVERITY_RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const RANKED: Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export interface IncidentRow {
  id: string;
  ref: string;
  fingerprint: string;
  category: string;
  module: string;
  severity: Severity;
  status: IncidentStatus;
  message_order: number[];
  message_counts: number[];
  affected_users: number;
  occurrences: number;
  diagnostics: Record<string, unknown>;
  first_seen_at: Date;
  last_seen_at: Date;
  routed_at: Date | null;
  alerted_severity: Severity | null;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  closed_at: Date | null;
}

// ------------------------------------------------------------------ classification

const MODULES: [RegExp, string][] = [
  [/^\/(sign-in|session-expired|api\/session)/, "Authentication and sessions"],
  [/^\/dashboard/, "Dashboard"],
  [/^\/requests\/new/, "Customer onboarding"],
  [/^\/requests\/[^/]+\/edit/, "Financing origination"],
  [/^\/api\/documents|\/documents/, "Document uploads"],
  [/^\/requests/, "Financing origination"],
  [/^\/queue/, "Reviews and approvals"],
  [/^\/booked/, "Facility management"],
  [/^\/altphones\/inventory/, "Altphones inventory"],
  [/^\/(altphones\/applications\/[^/]+\/disburse|api\/altphones\/paystack)/, "Payments and disbursement"],
  [/^\/(api\/)?altphones/, "Altphones"],
  [/^\/(api\/)?staff-(financing|request)/, "Staff financing"],
  [/^\/(api\/)?reports/, "Reporting and analytics"],
  [/^\/wallet/, "Request wallet"],
  [/^\/exceptions/, "Exceptions"],
  [/^\/vendors/, "Vendors"],
  [/^\/admin/, "Administration"],
];
const HIGH_IMPACT = new Set(["Payments and disbursement", "Authentication and sessions", "Reviews and approvals"]);

/** Route with every identifier replaced, so /requests/9f1…/edit and /requests/3ab…/edit correlate. */
export function normaliseRoute(path: string | null | undefined): string {
  const p = (path ?? "/").split(/[?#]/)[0] || "/";
  return (
    p
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
      .replace(/\/[A-Z]{2,5}-\d{4}-\d+/g, "/:ref")
      .replace(/\/\d+(?=\/|$)/g, "/:n")
      .slice(0, 200) || "/"
  );
}

export function moduleForRoute(route: string): string {
  for (const [re, name] of MODULES) if (re.test(route)) return name;
  return "Application";
}

/** Strip anything that could identify a person, account or secret from an error message. */
export function sanitiseMessage(msg: string | null | undefined): string {
  return String(msg ?? "")
    .replace(/[\w.+'-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/(sk|pk)_(live|test)_\w+/gi, "<key>")
    .replace(/(bearer|token|key|secret|password)([=:\s"]+)[^\s",;]+/gi, "$1$2<redacted>")
    .replace(/(?:file:\/\/)?(?:[A-Za-z]:)?(?:[\\/][^\s\\/"'<>]+){2,}/g, "<path>")
    .replace(/\(([^()]{0,80})\)=\(([^()]*)\)/g, "($1)=(<value>)") // Postgres "Key (col)=(value)"
    .replace(/"[^"]{0,200}"/g, '"<value>"')
    .replace(/\d{4,}/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

const INFRA_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "57P01", "57P03", "53300", "08000", "08001", "08003", "08006"]);

export interface FailureInput {
  source: IncidentSource;
  route?: string | null;
  error?: unknown;
  /** For browser-reported errors: the error's name and message as the browser saw them (untrusted). */
  name?: string | null;
  message?: string | null;
  digest?: string | null;
}

export interface Classified {
  fingerprint: string;
  category: string;
  module: string;
  baseSeverity: Severity;
  diagnostics: Record<string, unknown>;
}

export function classify(f: FailureInput): Classified {
  const e = (f.error ?? {}) as { name?: string; message?: string; code?: string | number; stack?: string; cause?: { code?: string } };
  const name = String(f.name ?? e.name ?? "Error").replace(/[^\w.]/g, "").slice(0, 60) || "Error";
  const code = String(e.code ?? e.cause?.code ?? "").replace(/[^\w]/g, "").slice(0, 20);
  const message = sanitiseMessage(f.message ?? e.message);
  const route = normaliseRoute(f.route);
  const area = moduleForRoute(route);
  const infrastructure = INFRA_CODES.has(code) || /connect(ion)? (refused|terminated|timeout)|too many clients/i.test(message);
  const category = infrastructure ? "DATABASE" : f.source === "network" ? "NETWORK" : f.source === "client" ? "CLIENT" : f.source === "api" ? "API" : f.source === "action" ? "ACTION" : "RENDER";
  // An infrastructure outage is one incident whichever screen it surfaces on; anything else is keyed to
  // where it happened and what failed, so unrelated failures stay apart.
  const parts = infrastructure ? ["infra", code || name] : [category, route, name, code, message.replace(/<[a-z]+>/g, "_")];
  const fingerprint = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
  const frames = String(e.stack ?? "")
    .split("\n")
    .slice(1, 6)
    // Keep the function name and file:line only; drop every directory (server paths are never stored).
    .map((l) => l.trim().replace(/(?<=[\s(])(?:file:\/\/)?(?:[A-Za-z]:)?[\\/]\S*[\\/]([^\\/\s]+?:\d+)(?::\d+)?/g, "$1"))
    .filter(Boolean);
  return {
    fingerprint,
    category,
    module: area,
    baseSeverity: infrastructure ? "CRITICAL" : HIGH_IMPACT.has(area) ? "HIGH" : "MEDIUM",
    diagnostics: { source: f.source, route, errorName: name, code: code || null, message, frames, baseSeverity: infrastructure ? "CRITICAL" : HIGH_IMPACT.has(area) ? "HIGH" : "MEDIUM" },
  };
}

function severityFor(base: Severity, affected: number): Severity {
  const bump = affected >= 50 ? 2 : affected >= 10 ? 1 : 0;
  return RANKED[Math.min(3, SEVERITY_RANK[base] + bump)];
}

/** A fresh Fisher–Yates shuffle of the five message numbers (server-side, cryptographic randomness). */
export function shuffledOrder(): number[] {
  const a = [1, 2, 3, 4, 5];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ------------------------------------------------------------------ recording and assignment

function log(event: string, i: Pick<IncidentRow, "ref" | "category" | "module" | "severity" | "status" | "fingerprint" | "affected_users" | "occurrences">) {
  // Structured, sanitised: no messages, stacks, customer data or secrets.
  console.error(JSON.stringify({ event, ref: i.ref, category: i.category, module: i.module, severity: i.severity, status: i.status, fingerprint: i.fingerprint, affectedUsers: i.affected_users, occurrences: i.occurrences, at: new Date().toISOString() }));
}

async function lockOpen(tx: Db, fingerprint: string): Promise<IncidentRow | undefined> {
  return (await tx.query<IncidentRow>("SELECT * FROM incidents WHERE fingerprint = $1 AND status IN ('DETECTED','INVESTIGATING') FOR UPDATE", [fingerprint])).rows[0];
}

/** The open incident for this failure (creating it if needed), locked for the rest of the transaction. */
async function openIncident(tx: Db, c: Classified, now: Date): Promise<{ inc: IncidentRow; created: boolean }> {
  const windowMs = config.incidentCorrelationMinutes * 60_000;
  let inc = await lockOpen(tx, c.fingerprint);
  if (inc && inc.status === "DETECTED" && now.getTime() - new Date(inc.last_seen_at).getTime() > windowMs) {
    // Nobody picked it up and it stopped recurring: it no longer describes a live failure.
    await tx.query("UPDATE incidents SET status = 'RESOLVED', resolved_at = $2, resolution_note = $3 WHERE id = $1", [inc.id, now, `No recurrence within ${config.incidentCorrelationMinutes} minutes (automatic).`]);
    inc = undefined;
  }
  if (inc) return { inc, created: false };
  const year = now.getUTCFullYear();
  const ins = await tx.query<IncidentRow>(
    `INSERT INTO incidents (ref, fingerprint, category, module, severity, message_order, diagnostics, first_seen_at, last_seen_at)
     VALUES ('ARAF-' || $1 || '-' || lpad(nextval('incident_ref_seq')::text, 4, '0'), $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (fingerprint) WHERE status IN ('DETECTED','INVESTIGATING') DO NOTHING RETURNING *`,
    [year, c.fingerprint, c.category, c.module, c.baseSeverity, shuffledOrder(), JSON.stringify(c.diagnostics), now],
  );
  if (ins.rows[0]) {
    return { inc: ins.rows[0], created: true };
  }
  // Another request created it a moment ago: join it.
  return { inc: (await lockOpen(tx, c.fingerprint))!, created: false };
}

/** Assign (or return) this user's message on a locked incident row. Never assigns on a closed incident. */
async function assignLocked(tx: Db, inc: IncidentRow, subject: string, now: Date): Promise<number | null> {
  const existing = (await tx.query<{ message_no: number }>("SELECT message_no FROM incident_assignments WHERE incident_id = $1 AND subject = $2", [inc.id, subject])).rows[0];
  if (existing) return existing.message_no;
  if (inc.status !== "DETECTED" && inc.status !== "INVESTIGATING") return null;
  const seq = inc.affected_users;
  const messageNo = inc.message_order[seq % 5];
  await tx.query("INSERT INTO incident_assignments (incident_id, subject, seq, message_no, assigned_at) VALUES ($1,$2,$3,$4,$5)", [inc.id, subject, seq, messageNo, now]);
  inc.affected_users = seq + 1;
  inc.message_counts = inc.message_counts.map((n, i) => (i + 1 === messageNo ? n + 1 : n));
  await tx.query(`UPDATE incidents SET affected_users = $2, message_counts[$3] = message_counts[$3] + 1 WHERE id = $1`, [inc.id, inc.affected_users, messageNo]);
  return messageNo;
}

async function maybeAlert(tx: Db, inc: IncidentRow, now: Date) {
  const to = config.incidentAlertEmails;
  if (!to.length) return;
  if (inc.alerted_severity && SEVERITY_RANK[inc.severity] <= SEVERITY_RANK[inc.alerted_severity]) return; // already told at this level
  const recent = Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM notification_outbox WHERE kind = 'INCIDENT_ALERT' AND created_at > $1", [new Date(now.getTime() - 3_600_000)])).rows[0].n);
  if (recent >= config.incidentAlertsPerHour) return; // throttled; the dashboard still shows it
  const d = inc.diagnostics as { route?: string; errorName?: string; code?: string | null };
  await enqueueEmail(tx, now, {
    kind: "INCIDENT_ALERT",
    dedupeKey: `incident:${inc.ref}:${inc.severity}`,
    to,
    subject: `[${inc.severity}] ${inc.ref} — ${inc.module}`,
    text: [
      `Incident ${inc.ref} (${inc.category}, ${inc.severity}) in ${inc.module}.`,
      `Where: ${d.route ?? "—"} · ${d.errorName ?? "Error"}${d.code ? ` (${d.code})` : ""}`,
      `First seen ${new Date(inc.first_seen_at).toISOString()}; ${inc.occurrences} occurrence(s), ${inc.affected_users} affected user(s).`,
      `Acknowledge it in ARAF: ${config.appUrl}/admin/incidents/${inc.id}`,
    ].join("\n"),
  });
  await tx.query("UPDATE incidents SET routed_at = coalesce(routed_at, $2), alerted_severity = $3 WHERE id = $1", [inc.id, now, inc.severity]);
  inc.routed_at = inc.routed_at ?? now;
  inc.alerted_severity = inc.severity;
}

export function viewOf(inc: Pick<IncidentRow, "ref" | "status" | "routed_at">, messageNo: number): IncidentView {
  const routed = !!inc.routed_at;
  return { ref: inc.ref, messageNo: messageNo as IncidentView["messageNo"], status: inc.status, statusLabel: statusLabel(inc.status, routed), routed };
}

/** Stable message for someone viewing an incident that no longer takes assignments. */
const stableNo = (subject: string) => (Number.parseInt(createHash("sha256").update(subject).digest("hex").slice(0, 8), 16) % 5) + 1;

/**
 * Record a technical failure: join or open its incident, count the occurrence, map the digest, assign the
 * user's message (when known) and route an alert when warranted. Returns the user's view.
 */
export async function recordFailure(f: FailureInput & { subject?: string | null; now?: Date }): Promise<{ incident: IncidentRow; view: IncidentView | null }> {
  const now = f.now ?? new Date();
  const c = classify(f);
  return withTx(async (tx) => {
    const { inc, created } = await openIncident(tx, c, now);
    inc.occurrences += 1;
    inc.last_seen_at = now;
    let messageNo: number | null = null;
    if (f.subject) messageNo = await assignLocked(tx, inc, f.subject, now);
    const sev = severityFor(c.baseSeverity, inc.affected_users);
    if (SEVERITY_RANK[sev] > SEVERITY_RANK[inc.severity]) inc.severity = sev;
    await tx.query("UPDATE incidents SET occurrences = $2, last_seen_at = $3, severity = $4 WHERE id = $1", [inc.id, inc.occurrences, now, inc.severity]);
    if (f.digest) await tx.query("INSERT INTO incident_digests (digest, incident_id, created_at) VALUES ($1,$2,$3) ON CONFLICT (digest) DO NOTHING", [f.digest.slice(0, 64), inc.id, now]);
    await maybeAlert(tx, inc, now);
    if (created) log("araf.incident.opened", inc);
    return { incident: inc, view: f.subject ? viewOf(inc, messageNo ?? stableNo(f.subject)) : null };
  });
}

/** Assign a user to an existing incident (by id), e.g. tests and the digest lookup. */
export async function assignUser(incidentId: string, subject: string, now = new Date()): Promise<IncidentView | null> {
  return withTx(async (tx) => {
    const inc = (await tx.query<IncidentRow>("SELECT * FROM incidents WHERE id = $1 FOR UPDATE", [incidentId])).rows[0];
    if (!inc) return null;
    const no = await assignLocked(tx, inc, subject, now);
    if (no !== null) {
      const sev = severityFor((inc.diagnostics as { baseSeverity?: Severity }).baseSeverity ?? "MEDIUM", inc.affected_users);
      if (SEVERITY_RANK[sev] > SEVERITY_RANK[inc.severity]) {
        inc.severity = sev;
        await tx.query("UPDATE incidents SET severity = $2 WHERE id = $1", [inc.id, sev]);
        await maybeAlert(tx, inc, now);
      }
    }
    return viewOf(inc, no ?? stableNo(subject));
  });
}

/** The incident behind a Next.js error digest (recorded by the server hook), with this user's message. */
export async function viewForDigest(digest: string, subject: string, now = new Date()): Promise<IncidentView | null> {
  const row = (await db.query<{ incident_id: string }>("SELECT incident_id FROM incident_digests WHERE digest = $1", [digest.slice(0, 64)])).rows[0];
  if (!row) return null;
  return assignUser(row.incident_id, subject, now);
}

// ------------------------------------------------------------------ lifecycle (Super Admin)

const TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  DETECTED: ["INVESTIGATING", "RESOLVED"],
  INVESTIGATING: ["RESOLVED"],
  RESOLVED: ["CLOSED", "INVESTIGATING"],
  CLOSED: [],
};
export const canTransition = (from: IncidentStatus, to: IncidentStatus) => TRANSITIONS[from].includes(to);

export async function transitionIncident(ctx: Ctx, id: string, to: IncidentStatus, note: string): Promise<void> {
  await withTx(async (tx) => {
    if (!ctx.actor || !(await holdsRole(tx, ctx.actor.staffId, "SUPER_ADMIN"))) throw new DomainError("FORBIDDEN", "Only a Super Admin can manage incidents.");
    const inc = (await tx.query<IncidentRow>("SELECT * FROM incidents WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!inc) throw new DomainError("NOT_FOUND", "Incident not found.");
    if (!canTransition(inc.status, to)) throw new DomainError("CONFLICT", `An incident that is ${inc.status.toLowerCase()} cannot become ${to.toLowerCase()}.`);
    const clean = note.trim().slice(0, 1000);
    if (to === "RESOLVED" && clean.length < 3) throw new DomainError("VALIDATION", "Say what fixed it.", { note: "Required" });
    if (to === "INVESTIGATING" && inc.status === "RESOLVED") {
      // Reopening: the open slot for this fingerprint may already be taken by a newer incident.
      const other = (await tx.query("SELECT ref FROM incidents WHERE fingerprint = $1 AND status IN ('DETECTED','INVESTIGATING') AND id <> $2", [inc.fingerprint, id])).rows[0];
      if (other) throw new DomainError("CONFLICT", `This failure is already tracked as ${other.ref}.`);
    }
    if (to === "INVESTIGATING")
      await tx.query("UPDATE incidents SET status = $2, acknowledged_by = $3, acknowledged_at = coalesce(acknowledged_at, $4), resolved_at = NULL, resolved_by = NULL WHERE id = $1", [id, to, ctx.actor.staffId, ctx.now]);
    else if (to === "RESOLVED") await tx.query("UPDATE incidents SET status = $2, resolved_by = $3, resolved_at = $4, resolution_note = $5 WHERE id = $1", [id, to, ctx.actor.staffId, ctx.now, clean]);
    else await tx.query("UPDATE incidents SET status = $2, closed_at = $3 WHERE id = $1", [id, to, ctx.now]);
    await audit(tx, ctx, { action: `INCIDENT_${to}`, details: { ref: inc.ref, from: inc.status, note: clean || undefined } });
    log(`araf.incident.${to.toLowerCase()}`, { ...inc, status: to });
  });
}

export async function listIncidents(q: Db, which: "active" | "resolved", limit = 50): Promise<IncidentRow[]> {
  const st = which === "active" ? ["DETECTED", "INVESTIGATING"] : ["RESOLVED", "CLOSED"];
  return (await q.query<IncidentRow>("SELECT * FROM incidents WHERE status = ANY($1) ORDER BY last_seen_at DESC LIMIT $2", [st, limit])).rows;
}
