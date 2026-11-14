/**
 * Altphones: shared core — settings, application records, audited status changes, access, separation of
 * duties, route positions and notifications.
 */
import type { Db, Tx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { conflict, forbidden, notFound } from "../errors";
import { enqueueEmail } from "../notify/outbox";
import { simpleEmail } from "../notify/templates";
import { config } from "../config";
import { holdsRole } from "../domain/access";
import { ALT_STATUS_LABELS, type AltStatus, type MarkupBasis, type ShortMonthRule, type WeekendRule } from "@/lib/altphones";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AltApp = Record<string, any> & {
  id: string;
  ref: string;
  kind: "OUTRIGHT" | "CREDIT";
  channel: "DO" | "SA";
  status: AltStatus;
  lock_version: number;
  originator_id: string | null;
};

export interface AltSettings {
  id: string;
  version: number;
  outright_price_kobo: string;
  down_payment_kobo: string;
  tenures: number[];
  markup_rates: Record<string, number>;
  markup_basis: MarkupBasis | null;
  score_pass_min: string | null;
  score_fair_min: string | null;
  weekend_rule: WeekendRule | null;
  short_month_rule: ShortMonthRule | null;
  contract_template: string | null;
  unit_head_staff_id: string | null;
  team_email: string;
  reason: string;
  created_by: string | null;
  created_at: Date;
}

export const ORIGINATOR_ROLES = ["DELIGHT_OFFICER", "SMILE_ASSOCIATE"] as const;
export const CHANNEL_ROLE: Record<"DO" | "SA", "DELIGHT_OFFICER" | "SMILE_ASSOCIATE"> = { DO: "DELIGHT_OFFICER", SA: "SMILE_ASSOCIATE" };
export const PM_ROLE = "ALTPHONES_PRODUCT_MANAGER";
export const BPM_ROLE = "BUSINESS_PERFORMANCE_MANAGER";

export async function currentSettings(q: Db): Promise<AltSettings> {
  return (await q.query<AltSettings>("SELECT * FROM altphones_settings ORDER BY version DESC LIMIT 1")).rows[0];
}
export async function settingsById(q: Db, id: string): Promise<AltSettings> {
  return (await q.query<AltSettings>("SELECT * FROM altphones_settings WHERE id = $1", [id])).rows[0];
}

/** What is missing before credit sales can be originated with these settings (empty when ready). */
export function creditReadiness(s: AltSettings): string[] {
  const out: string[] = [];
  const missing = s.tenures.filter((t) => s.markup_rates?.[String(t)] === undefined || s.markup_rates?.[String(t)] === null);
  if (missing.length || !s.markup_basis) out.push(`Markup rates${missing.length ? ` for ${missing.join(", ")} months` : ""}${!s.markup_basis ? " and the markup basis" : ""} are not configured.`);
  if (s.score_pass_min === null || s.score_fair_min === null) out.push("Seed Score bands (Pass and Fair thresholds) are not configured.");
  if (!s.weekend_rule || !s.short_month_rule) out.push("Repayment-date rules are not configured.");
  if (!s.contract_template?.trim()) out.push("The approved customer contract wording is not loaded.");
  return out;
}

export function isUuid(id: string) {
  return /^[0-9a-f-]{36}$/i.test(id);
}

export async function loadApp(q: Db, id: string): Promise<AltApp> {
  if (!isUuid(id)) throw notFound("Altphones application not found.");
  const r = (await q.query<AltApp>("SELECT * FROM altphones_applications WHERE id = $1", [id])).rows[0];
  if (!r) throw notFound("Altphones application not found.");
  return r;
}
export async function lockApp(tx: Tx, id: string): Promise<AltApp> {
  if (!isUuid(id)) throw notFound("Altphones application not found.");
  const r = (await tx.query<AltApp>("SELECT * FROM altphones_applications WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!r) throw notFound("Altphones application not found.");
  return r;
}

export function checkLock(app: AltApp, lockVersion: number | null | undefined) {
  if (lockVersion !== null && lockVersion !== undefined && Number(lockVersion) !== app.lock_version) {
    throw conflict("This application changed since you opened it. Reload the page to see the latest version.");
  }
}
export function expectStatus(app: AltApp, allowed: AltStatus[], what: string) {
  if (!allowed.includes(app.status)) throw conflict(`${what} is not possible while the application is "${ALT_STATUS_LABELS[app.status]}".`);
}

export interface EventInput {
  action: string;
  to?: AltStatus | null;
  role?: string | null;
  comments?: string | null;
  details?: Record<string, unknown>;
  set?: Record<string, unknown>;
}

/** Update columns and (optionally) the status in one audited step. Increments lock_version. */
export async function transition(tx: Tx, ctx: Ctx, app: AltApp, e: EventInput): Promise<AltApp> {
  const set: Record<string, unknown> = { ...(e.set ?? {}), updated_at: ctx.now };
  if (e.to) set.status = e.to;
  const cols = Object.keys(set);
  const sql = `UPDATE altphones_applications SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, lock_version = lock_version + 1 WHERE id = $1 RETURNING *`;
  const fresh = (await tx.query<AltApp>(sql, [app.id, ...cols.map((c) => set[c])])).rows[0];
  await recordEvent(tx, ctx, fresh, { ...e, from: app.status });
  return fresh;
}

export async function recordEvent(q: Db, ctx: Ctx, app: AltApp, e: EventInput & { from?: string | null }) {
  const to = e.to ?? null;
  await q.query(
    `INSERT INTO altphones_events (application_id, action, from_status, to_status, actor_id, actor_role, comments, details, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [app.id, e.action, e.from ?? null, to, ctx.actor?.staffId ?? null, e.role ?? null, e.comments ?? null, JSON.stringify(e.details ?? {}), ctx.now],
  );
  await audit(q, ctx, {
    action: `ALTPHONES_${e.action}`,
    actorRole: e.role ?? null,
    altphonesApplicationId: app.id,
    stage: to ?? app.status,
    reason: e.comments ?? null,
    details: { ref: app.ref, fromStatus: e.from ?? null, toStatus: to, ...(e.details ?? {}) },
  });
}

export async function auditDenied(ctx: Ctx, appId: string | null, action: string, reason: string) {
  await auditOutsideTx(ctx, { action: `ALTPHONES_${action}_DENIED`, outcome: "DENIED", altphonesApplicationId: appId && isUuid(appId) ? appId : null, reason });
}

// ------------------------------------------------------------------ people and access

export async function activeRoles(q: Db, staffId: string): Promise<Set<string>> {
  return new Set(
    (await q.query<{ role: string }>("SELECT ra.role FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.staff_id = $1 AND ra.active AND s.status = 'ACTIVE'", [staffId])).rows.map((r) => r.role),
  );
}

export async function roleHolders(q: Db, roles: readonly string[]): Promise<{ id: string; email: string; full_name: string }[]> {
  return (
    await q.query(
      `SELECT DISTINCT s.id, s.email, s.full_name FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id
        WHERE ra.role = ANY($1) AND ra.active AND s.status = 'ACTIVE' ORDER BY s.full_name`,
      [roles as string[]],
    )
  ).rows;
}

export type AltAccess = "ORIGINATOR" | "BPM" | "PM" | "UNIT_HEAD" | "ADMIN";

/** Who may open an application: its originator, reviewers of its stages, and Super Admins. */
export async function appAccess(q: Db, staffId: string, app: AltApp): Promise<Set<AltAccess>> {
  const as = new Set<AltAccess>();
  if (app.originator_id === staffId) as.add("ORIGINATOR");
  const roles = await activeRoles(q, staffId);
  if (roles.has("SUPER_ADMIN")) as.add("ADMIN");
  const reviewed = app.submission_count > 0 || app.legacy;
  // SA applications go to the BPM mapped to their operating location (earlier applications: any BPM).
  if (roles.has(BPM_ROLE) && app.channel === "SA" && reviewed && (!app.routed_bpm_id || app.routed_bpm_id === staffId || app.bpm_reviewer_id === staffId)) as.add("BPM");
  if (roles.has(PM_ROLE) && (reviewed || app.kind === "OUTRIGHT")) as.add("PM");
  if (roles.has("UNIT_HEAD") && reviewed) {
    const uh = (await currentSettings(q)).unit_head_staff_id;
    if (app.unit_head_id === staffId || uh === staffId) as.add("UNIT_HEAD");
  }
  return as;
}

export async function viewableApp(ctx: Ctx, q: Db, id: string): Promise<{ app: AltApp; as: Set<AltAccess> }> {
  if (!ctx.actor) throw forbidden();
  const app = await loadApp(q, id);
  const as = await appAccess(q, ctx.actor.staffId, app);
  if (!as.size) {
    await auditDenied(ctx, app.id, "VIEW", "No access to this Altphones application");
    throw forbidden("You do not have access to this Altphones application.");
  }
  return { app, as };
}

/** The originating officer, acting in their channel role. */
export async function requireOriginator(tx: Tx, ctx: Ctx, app: AltApp) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (app.originator_id !== actor.staffId) throw forbidden("Only the officer who originated this application can do this.");
  if (!(await holdsRole(tx, actor.staffId, CHANNEL_ROLE[app.channel]))) throw forbidden("Your role assignments do not allow this action.");
  return actor;
}

/** Separation of duties for reviewers: never the originator, never two stages on one application. */
export async function requireReviewer(tx: Tx, ctx: Ctx, app: AltApp, role: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (app.originator_id === actor.staffId) throw forbidden("You cannot review an application you originated.");
  if (!(await holdsRole(tx, actor.staffId, role))) throw forbidden("Your role assignments do not allow this action.");
  const others = [
    role !== BPM_ROLE ? app.bpm_reviewer_id : null,
    role !== PM_ROLE ? app.pm_reviewer_id : null,
    role !== "UNIT_HEAD" ? app.unit_head_id : null,
  ];
  if (others.includes(actor.staffId)) throw forbidden("Separation of duties: you have already acted on this application at another stage.");
  return actor;
}

export interface RoutePosition {
  id: string | null;
  name: string | null;
  problem: string | null;
}

/** The one Unit Head configured for the Altphones route (must be active and hold the Unit Head role). */
export async function routeUnitHead(q: Db, app?: AltApp | null): Promise<RoutePosition> {
  const s = await currentSettings(q);
  if (!s.unit_head_staff_id) return { id: null, name: null, problem: "No Unit Head is configured for the Altphones route. A Super Admin must set one in Altphones settings." };
  const p = (
    await q.query<{ full_name: string; ok: boolean }>(
      `SELECT s.full_name, (s.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM role_assignments ra WHERE ra.staff_id = s.id AND ra.role = 'UNIT_HEAD' AND ra.active)) AS ok FROM staff s WHERE s.id = $1`,
      [s.unit_head_staff_id],
    )
  ).rows[0];
  if (!p?.ok) return { id: s.unit_head_staff_id, name: p?.full_name ?? null, problem: `The configured Unit Head (${p?.full_name ?? "unknown"}) is not active or no longer holds the Unit Head role.` };
  if (app && [app.originator_id, app.bpm_reviewer_id, app.pm_reviewer_id].includes(s.unit_head_staff_id)) {
    return { id: s.unit_head_staff_id, name: p.full_name, problem: `Separation of duties: the configured Unit Head (${p.full_name}) originated or already reviewed this application.` };
  }
  return { id: s.unit_head_staff_id, name: p.full_name, problem: null };
}

// ------------------------------------------------------------------ notifications

export function appLink(id: string) {
  return `${config.appUrl}/altphones/applications/${id}`;
}

/** Staff notification: reference, step and a sign-in link; no customer financial data. */
export async function notifyStaffIds(q: Db, ctx: Ctx, app: AltApp, kind: string, ids: (string | null | undefined)[], subject: string, lines: string[]) {
  const list = [...new Set(ids.filter(Boolean) as string[])];
  if (!list.length) return null;
  const emails = (await q.query<{ email: string }>("SELECT email FROM staff WHERE id = ANY($1) AND status = 'ACTIVE'", [list])).rows.map((r) => r.email);
  if (!emails.length) return null;
  return enqueueEmail(q, ctx.now, {
    kind: `ALTPHONES_${kind}`,
    dedupeKey: `altphones:${kind}:${app.id}:${app.lock_version}`,
    to: emails,
    subject: `[${app.ref}] ${subject}`,
    text: simpleEmail([...lines, "", `Application reference: ${app.ref}`, `Open the application (sign-in required): ${appLink(app.id)}`]),
  });
}

export async function notifyRole(q: Db, ctx: Ctx, app: AltApp, kind: string, roles: readonly string[], subject: string, lines: string[], exclude: (string | null | undefined)[] = []) {
  const ex = new Set(exclude.filter(Boolean));
  const ids = (await roleHolders(q, roles)).filter((h) => !ex.has(h.id)).map((h) => h.id);
  return notifyStaffIds(q, ctx, app, kind, ids, subject, lines);
}

export async function alertOperations(q: Db, ctx: Ctx, app: AltApp, kind: string, subject: string, lines: string[]) {
  const ids = (await roleHolders(q, ["SUPER_ADMIN"])).map((h) => h.id);
  return notifyStaffIds(q, ctx, app, `EXCEPTION_${kind}`, ids, subject, lines);
}

/** Customer email (copying the Altphones team mailbox). Never carries BVN or full account numbers. */
export async function emailCustomer(q: Db, ctx: Ctx, app: AltApp, kind: string, subject: string, lines: string[], teamEmail: string) {
  if (!app.customer_email) return null;
  return enqueueEmail(q, ctx.now, {
    kind: `ALTPHONES_CUSTOMER_${kind}`,
    dedupeKey: `altphones:customer:${kind}:${app.id}`,
    to: [app.customer_email],
    cc: teamEmail ? [teamEmail] : [],
    subject: `${subject} — ${app.ref}`,
    text: simpleEmail([`Dear ${app.customer_name ?? "Customer"},`, "", ...lines, "", "The Alternative Bank — Altphones"]),
  });
}

export async function nextRef(q: Db, seq: string, prefix: string, now: Date) {
  const n = (await q.query<{ n: string }>(`SELECT nextval('${seq}') AS n`)).rows[0].n;
  return `${prefix}-${now.getUTCFullYear()}-${String(n).padStart(6, "0")}`;
}
