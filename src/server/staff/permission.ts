/**
 * Staff Financing permission: the single, server-side source of truth for who may use Staff Financing.
 *
 * Decided from the verified profile in the database (staff status and active role assignments), never
 * from what the browser shows or sends. Every Staff Financing entry point calls `requireStaffFinancing`;
 * pages and navigation use `staffFinancingAccess` only to decide what to display.
 *
 * Rules, in order:
 *  1. No signed-in user → denied (background jobs run with a system context and are not users).
 *  2. Staff record missing or not active → denied.
 *  3. Holding an active Smile Associate role → denied, even alongside other roles (explicit restriction).
 *  4. No active role at all (unprofiled) → denied.
 *  5. Otherwise allowed: every other profiled role keeps the access it has today (the ARAF role-access
 *     matrix), with each workflow step still checking its own role and separation of duties.
 */
import { db, type Db } from "../db";
import type { Ctx } from "../context";
import { auditOutsideTx } from "../audit";
import { DomainError } from "../errors";

/** Roles that may never use Staff Financing, whatever else the person holds. */
export const STAFF_FINANCING_RESTRICTED_ROLES = ["SMILE_ASSOCIATE"] as const;

export const STAFF_FINANCING_RESTRICTED_MESSAGE = "Your current profile does not authorise you to access Staff Salary Advance. Please contact your administrator if you believe your access should be reviewed.";

export type StaffFinancingDenial = "UNAUTHENTICATED" | "INACTIVE" | "RESTRICTED_ROLE" | "UNPROFILED" | "RETIRED";

/**
 * Staff Salary Advance is retired: no new requests, reviews, approvals, offers or register changes.
 * Pending requests were closed as WITHDRAWN by migration 058. What remains open is limited to keeping
 * records and finishing money already in motion: reading existing records and documents, completing a
 * disbursement that was already started, recording repayments on advances already paid, and the
 * archive / Legal and Shariah handover of completed facilities.
 */
let retired = true;
export function staffAdvanceRetired(): boolean {
  return retired;
}
/** Tests only: exercise the retained workflow code as it ran before retirement. */
export function setStaffAdvanceRetiredForTests(v: boolean) {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) throw new Error("Test-only switch.");
  retired = v;
}
export const STAFF_SALARY_ADVANCE_RETIRED_MESSAGE = "Staff Salary Advance has been retired. New requests, reviews and approvals are no longer available; existing records are kept for reference.";
export const RETIRED_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  "VIEW_REQUEST",
  "VIEW_MY_REQUESTS",
  "VIEW_QUEUES",
  "VIEWABLE_REQUEST",
  "READ_STAFF_DOCUMENT",
  "READ_ARCHIVE",
  "SCAN_STAFF_DOCUMENT",
  "COMPLETE_DISBURSEMENT",
  "UPLOAD_STAFF_DOCUMENT", // limited to disbursement evidence while retired (staff/documents.ts)
  "REASSIGN_DISBURSEMENT_OFFICER",
  "RETRY_DOCUMENTATION_NOW",
  "COMPLETE_HANDOVER_REVIEW",
  "CONFIRM_HANDOVER_RECEIPT",
]);
export type StaffFinancingAccess = { allowed: true; roles: string[] } | { allowed: false; reason: StaffFinancingDenial; roles: string[] };

export async function staffFinancingAccess(q: Db, staffId: string | null | undefined): Promise<StaffFinancingAccess> {
  if (!staffId) return { allowed: false, reason: "UNAUTHENTICATED", roles: [] };
  const s = (await q.query<{ status: string }>("SELECT status FROM staff WHERE id = $1", [staffId])).rows[0];
  if (!s || s.status !== "ACTIVE") return { allowed: false, reason: "INACTIVE", roles: [] };
  const roles = [...new Set((await q.query<{ role: string }>("SELECT role FROM role_assignments WHERE staff_id = $1 AND active", [staffId])).rows.map((r) => r.role))].sort();
  if (roles.some((r) => (STAFF_FINANCING_RESTRICTED_ROLES as readonly string[]).includes(r))) return { allowed: false, reason: "RESTRICTED_ROLE", roles };
  if (roles.length === 0) return { allowed: false, reason: "UNPROFILED", roles };
  if (staffAdvanceRetired()) return { allowed: false, reason: "RETIRED", roles };
  return { allowed: true, roles };
}

/**
 * Guard for every Staff Financing operation. Denials are recorded in the security audit log (user, roles,
 * active role, attempted action, target, time) and raised as FORBIDDEN, which API routes return as 403.
 */
export async function requireStaffFinancing(ctx: Ctx, action: string, target?: string | null): Promise<void> {
  if (ctx.system && !ctx.actor) return; // background job (worker), not a person
  const access = await staffFinancingAccess(db, ctx.actor?.staffId);
  if (access.allowed) return;
  // Retired: records and money already in motion only. Each step still checks its own role and status.
  if (access.reason === "RETIRED" && RETIRED_ALLOWED_ACTIONS.has(action)) return;
  await auditOutsideTx(ctx, {
    action: "STAFF_FINANCING_ACCESS_DENIED",
    outcome: "DENIED",
    reason: access.reason,
    staffRequestId: target && /^[0-9a-f-]{36}$/i.test(target) ? await existingRequest(target) : null,
    details: { attemptedAction: action, target: target ?? null, roles: access.roles, activeRole: ctx.actor?.activeRole ?? null },
  }).catch((e) => console.error("[staff-financing] could not audit a denied attempt", (e as Error).message));
  throw new DomainError("FORBIDDEN", access.reason === "RETIRED" ? STAFF_SALARY_ADVANCE_RETIRED_MESSAGE : STAFF_FINANCING_RESTRICTED_MESSAGE);
}

async function existingRequest(id: string): Promise<string | null> {
  return (await db.query<{ id: string }>("SELECT id FROM staff_requests WHERE id = $1", [id])).rows[0]?.id ?? null;
}
