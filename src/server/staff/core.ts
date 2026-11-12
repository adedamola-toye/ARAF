/**
 * Staff Personal Financing: shared core (records, events, access, separation of duties, notifications).
 *
 * Every status change goes through `transition()`, which re-checks the expected status and the
 * optimistic lock inside the caller's transaction and writes both the request's own status history
 * (staff_request_events, append-only) and the platform audit trail (audit_events, append-only).
 */
import type { Db, Tx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { conflict, forbidden, notFound } from "../errors";
import { enqueueEmail } from "../notify/outbox";
import { simpleEmail } from "../notify/templates";
import { config } from "../config";
import { holdsRole } from "../domain/access";
import { STAFF_STATUS_LABELS, STAFF_STATUS_QUEUE, type StaffStatus } from "@/lib/staff-financing";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type StaffRequestRow = Record<string, any> & {
  id: string;
  ref: string;
  applicant_id: string;
  status: StaffStatus;
  lock_version: number;
};

export const DISBURSEMENT_ROLES = ["DISBURSEMENT_OFFICER_1", "DISBURSEMENT_OFFICER_2"] as const;

export interface StaffSettings {
  id: string;
  version: number;
  deduction_rate_bps: number;
  min_amount_kobo: string | null;
  max_amount_kobo: string | null;
  tenor_options_months: number[];
  required_document_types: string[];
  reason: string;
  created_at: Date;
}

export async function currentSettings(q: Db): Promise<StaffSettings> {
  return (await q.query<StaffSettings>("SELECT * FROM staff_financing_settings ORDER BY version DESC LIMIT 1")).rows[0];
}
export async function settingsById(q: Db, id: string): Promise<StaffSettings> {
  return (await q.query<StaffSettings>("SELECT * FROM staff_financing_settings WHERE id = $1", [id])).rows[0];
}

export async function loadRequest(q: Db, id: string): Promise<StaffRequestRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Staff financing request not found.");
  const r = (await q.query<StaffRequestRow>("SELECT * FROM staff_requests WHERE id = $1", [id])).rows[0];
  if (!r) throw notFound("Staff financing request not found.");
  return r;
}
export async function lockRequest(tx: Tx, id: string): Promise<StaffRequestRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Staff financing request not found.");
  const r = (await tx.query<StaffRequestRow>("SELECT * FROM staff_requests WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!r) throw notFound("Staff financing request not found.");
  return r;
}

/** Optimistic lock: the form carried the version it was rendered from. */
export function checkLock(req: StaffRequestRow, lockVersion: number | null | undefined) {
  if (lockVersion !== null && lockVersion !== undefined && Number(lockVersion) !== req.lock_version) {
    throw conflict("This request changed since you opened it. Reload the page to see the latest version.");
  }
}

export function expectStatus(req: StaffRequestRow, allowed: StaffStatus[], what: string) {
  if (!allowed.includes(req.status)) {
    throw conflict(`${what} is not possible while the request is "${STAFF_STATUS_LABELS[req.status]}".`);
  }
}

export interface EventInput {
  action: string;
  to?: StaffStatus | null;
  role?: string | null;
  outcome?: string | null;
  comments?: string | null;
  documentIds?: string[];
  details?: Record<string, unknown>;
  /** Columns to set together with the status change (never the status or lock version). */
  set?: Record<string, unknown>;
}

/**
 * Apply an update + status change (if any) and record it. Increments lock_version. Returns the fresh row.
 */
export async function transition(tx: Tx, ctx: Ctx, req: StaffRequestRow, e: EventInput): Promise<StaffRequestRow> {
  const set: Record<string, unknown> = { ...(e.set ?? {}), updated_at: ctx.now };
  if (e.to) set.status = e.to;
  const cols = Object.keys(set);
  const params = cols.map((c) => set[c]);
  const sql = `UPDATE staff_requests SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, lock_version = lock_version + 1 WHERE id = $1 RETURNING *`;
  const fresh = (await tx.query<StaffRequestRow>(sql, [req.id, ...params])).rows[0];
  await recordEvent(tx, ctx, fresh, { ...e, from: req.status });
  return fresh;
}

export async function recordEvent(tx: Db, ctx: Ctx, req: StaffRequestRow, e: EventInput & { from?: string | null }) {
  const to = e.to ?? null;
  await tx.query(
    `INSERT INTO staff_request_events (request_id, action, from_status, to_status, actor_id, actor_role, queue, outcome, comments, document_ids, details, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      req.id,
      e.action,
      e.from ?? null,
      to,
      ctx.actor?.staffId ?? null,
      e.role ?? null,
      to ? STAFF_STATUS_QUEUE[to] : null,
      e.outcome ?? null,
      e.comments ?? null,
      e.documentIds ?? [],
      JSON.stringify(e.details ?? {}),
      ctx.now,
    ],
  );
  await audit(tx, ctx, {
    action: `STAFF_FIN_${e.action}`,
    actorRole: e.role ?? null,
    staffRequestId: req.id,
    stage: to ?? req.status,
    reason: e.comments ?? null,
    documentId: e.documentIds?.[0] ?? null,
    details: { ref: req.ref, fromStatus: e.from ?? null, toStatus: to, queue: to ? STAFF_STATUS_QUEUE[to] : null, outcome: e.outcome ?? null, ...(e.details ?? {}) },
  });
}

/** Record a refused attempt outside the (rolled back) transaction. */
export async function auditDenied(ctx: Ctx, requestId: string | null, action: string, reason: string) {
  await auditOutsideTx(ctx, { action: `STAFF_FIN_${action}_DENIED`, outcome: "DENIED", staffRequestId: requestId && /^[0-9a-f-]{36}$/i.test(requestId) ? requestId : null, reason });
}

// ------------------------------------------------------------------ people

export async function staffEmail(q: Db, staffId: string): Promise<string | null> {
  return (await q.query<{ email: string }>("SELECT email FROM staff WHERE id = $1", [staffId])).rows[0]?.email ?? null;
}

/** Active staff holding any of the roles (active assignment, staff not suspended). */
export async function roleHolders(q: Db, roles: readonly string[]): Promise<{ id: string; email: string; full_name: string; role: string; business_unit: string | null }[]> {
  return (
    await q.query(
      `SELECT DISTINCT ON (s.id) s.id, s.email, s.full_name, ra.role, coalesce(ra.business_unit, s.business_unit) AS business_unit
         FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id
        WHERE ra.role = ANY($1) AND ra.active AND s.status = 'ACTIVE'
        ORDER BY s.id, ra.granted_at`,
      [roles as string[]],
    )
  ).rows;
}

/** People who have acted on this request in an approval or disbursement capacity. */
export function priorActors(req: StaffRequestRow): string[] {
  return [req.pm_reviewer_id, req.unit_head_id, req.divisional_head_id, req.approved_by, req.disbursement_officer_id].filter(Boolean) as string[];
}

/**
 * Separation of duties: the applicant never acts on their own request, and one person never fills
 * two different approval or disbursement positions on the same request.
 */
export async function requireActor(tx: Tx, ctx: Ctx, req: StaffRequestRow, role: string, opts: { allowSelfIn?: (string | null | undefined)[] } = {}) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (req.applicant_id === actor.staffId) throw forbidden("You cannot review, approve or disburse your own financing request.");
  if (!(await holdsRole(tx, actor.staffId, role))) throw forbidden("Your role assignments do not allow this action.");
  const own = new Set((opts.allowSelfIn ?? []).filter(Boolean));
  for (const p of priorActors(req)) {
    if (p === actor.staffId && !own.has(p)) throw forbidden("Separation of duties: you have already acted on this request in another capacity.");
  }
  return actor;
}

// ------------------------------------------------------------------ access

export type StaffAccessAs = "APPLICANT" | "PRODUCT_MANAGER" | "UNIT_HEAD" | "DIVISIONAL_HEAD" | "DISBURSEMENT" | "LEGAL" | "SHARIAH" | "ADMIN";

export async function requestAccess(q: Db, staffId: string, req: StaffRequestRow): Promise<Set<StaffAccessAs>> {
  const as = new Set<StaffAccessAs>();
  if (req.applicant_id === staffId) as.add("APPLICANT");
  const roles = new Set(
    (await q.query<{ role: string }>("SELECT ra.role FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.staff_id = $1 AND ra.active AND s.status = 'ACTIVE'", [staffId])).rows.map((r) => r.role),
  );
  if (roles.has("SUPER_ADMIN")) as.add("ADMIN");
  if (roles.has("PRODUCT_MANAGER") && req.submission_count > 0) as.add("PRODUCT_MANAGER");
  if (roles.has("UNIT_HEAD")) {
    const acted = await q.query("SELECT 1 FROM staff_request_reviews WHERE request_id = $1 AND actor_id = $2", [req.id, staffId]);
    if (req.unit_head_id === staffId || acted.rowCount) as.add("UNIT_HEAD");
  }
  if (roles.has("DIVISIONAL_HEAD")) {
    const reached = await q.query("SELECT 1 FROM staff_request_reviews WHERE request_id = $1 AND stage = 'UNIT_HEAD' AND action = 'APPROVE'", [req.id]);
    if (reached.rowCount || req.divisional_head_id === staffId) as.add("DIVISIONAL_HEAD");
  }
  if (DISBURSEMENT_ROLES.some((r) => roles.has(r))) {
    const a = await q.query("SELECT 1 FROM staff_request_assignments WHERE request_id = $1 AND officer_id = $2", [req.id, staffId]);
    if (a.rowCount) as.add("DISBURSEMENT");
  }
  if (roles.has("LEGAL_REVIEWER") || roles.has("SHARIAH_REVIEWER")) {
    const h = await q.query("SELECT 1 FROM staff_request_handovers WHERE request_id = $1", [req.id]);
    if (h.rowCount) {
      if (roles.has("LEGAL_REVIEWER")) as.add("LEGAL");
      if (roles.has("SHARIAH_REVIEWER")) as.add("SHARIAH");
    }
  }
  return as;
}

/** Load a request the actor may see, or record the denied attempt and refuse. */
export async function viewableRequest(ctx: Ctx, id: string, q: Db): Promise<{ req: StaffRequestRow; as: Set<StaffAccessAs> }> {
  if (!ctx.actor) throw forbidden();
  const req = await loadRequest(q, id);
  const as = await requestAccess(q, ctx.actor.staffId, req);
  if (as.size === 0) {
    await auditDenied(ctx, req.id, "VIEW", "No access to this staff financing request");
    throw forbidden("You do not have access to this staff financing request.");
  }
  return { req, as };
}

// ------------------------------------------------------------------ notifications (no amounts or account numbers)

export function requestLink(id: string) {
  return `${config.appUrl}/staff-request/${id}`;
}

export async function notify(
  q: Db,
  ctx: Ctx,
  req: StaffRequestRow,
  kind: string,
  recipients: string[],
  subject: string,
  lines: string[],
  dedupeSuffix = "",
) {
  const to = [...new Set(recipients.filter(Boolean).map((e) => e.toLowerCase()))];
  if (!to.length) return null;
  return enqueueEmail(q, ctx.now, {
    kind: `STAFF_FIN_${kind}`,
    dedupeKey: `staff-fin:${kind}:${req.id}:${req.lock_version}:${dedupeSuffix}`,
    staffRequestId: req.id,
    to,
    subject: `[${req.ref}] ${subject}`,
    text: simpleEmail([...lines, "", `Request reference: ${req.ref}`, `Open the request (sign-in required): ${requestLink(req.id)}`]),
  });
}

export async function notifyStaff(q: Db, ctx: Ctx, req: StaffRequestRow, kind: string, staffIds: (string | null | undefined)[], subject: string, lines: string[], dedupeSuffix = "") {
  const ids = [...new Set(staffIds.filter(Boolean) as string[])];
  if (!ids.length) return null;
  const emails = (await q.query<{ email: string }>("SELECT email FROM staff WHERE id = ANY($1) AND status = 'ACTIVE'", [ids])).rows.map((r) => r.email);
  return notify(q, ctx, req, kind, emails, subject, lines, dedupeSuffix);
}

export async function notifyRole(q: Db, ctx: Ctx, req: StaffRequestRow, kind: string, roles: readonly string[], subject: string, lines: string[], exclude: (string | null | undefined)[] = []) {
  const ex = new Set(exclude.filter(Boolean));
  const holders = (await roleHolders(q, roles)).filter((h) => !ex.has(h.id));
  return notify(q, ctx, req, kind, holders.map((h) => h.email), subject, lines, roles.join("+"));
}

/** Operational exception: alert Super Admins (processing exceptions need intervention). */
export async function alertOperations(q: Db, ctx: Ctx, req: StaffRequestRow, kind: string, subject: string, lines: string[], dedupeSuffix = "") {
  const admins = await roleHolders(q, ["SUPER_ADMIN"]);
  return notify(q, ctx, req, `EXCEPTION_${kind}`, admins.map((a) => a.email), subject, lines, dedupeSuffix);
}
