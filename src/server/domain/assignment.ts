import type { Tx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { securePick } from "../crypto";
import { enqueueEmail } from "../notify/outbox";
import { assignmentEmail, simpleEmail } from "../notify/templates";
import { zoneForRegion, type Role } from "./roles";
import { REQUIRED_ACTION, STAGE_LABELS, type Stage } from "./stages";
import { getRoute } from "./routing";
import { latestAssessment, type AssessmentRow } from "./assessment";
import type { AssessmentSummary } from "../notify/templates";
import type { PricingResult } from "./pricing";

/** Attach the first reviewer's DSR exception justification (if the approval used one). */
async function withException(tx: Tx, appId: string, s: AssessmentSummary): Promise<AssessmentSummary> {
  if (!s.pricing || s.pricing.result !== "EXCEEDS_THRESHOLD") return s;
  const d = (
    await tx.query<{ reason: string | null }>(
      `SELECT reason FROM decisions WHERE application_id = $1 AND stage = 'FIRST_CREDIT_REVIEW' AND action = 'APPROVE' AND invalidated_at IS NULL ORDER BY seq DESC LIMIT 1`,
      [appId],
    )
  ).rows[0];
  return d?.reason ? { ...s, pricing: { ...s.pricing, dsrException: d.reason.replace(/^DSR exception: /, "") } } : s;
}

export function assessmentSummary(a: AssessmentRow): AssessmentSummary {
  const o = a.outputs as { pricing?: PricingResult; explanation?: string };
  const p = o.pricing;
  return {
    aprPercent: a.apr_percent,
    dsrPercent: a.dsr_percent,
    pricing: p
      ? {
          turnoverUsedKobo: p.turnover.monthlyTurnoverUsedKobo,
          turnoverBasis: p.turnover.basis,
          monthlyRepaymentKobo: p.facility.monthlyRepaymentKobo,
          totalDsrPercent: p.capacity.totalDsrPercent,
          thresholdPercent: p.capacity.thresholdPercent,
          result: p.capacity.result,
          excessKobo: p.capacity.excessKobo,
          flatMarkupRatePercent: p.facility.flatMarkupRatePercent,
          tenorMonths: p.facility.tenorMonths,
          explanation: o.explanation ?? "",
          repaymentFrequency: p.facility.repaymentFrequency,
          instalmentKobo: p.facility.instalmentKobo,
        }
      : undefined,
  };
}

export interface AppRow {
  id: string;
  ref: string;
  customer_id: string | null;
  applicant_type: "INDIVIDUAL" | "ENTERPRISE" | "LIMITED";
  initiator_id: string;
  initiator_role: "RM" | "ANM" | "MERCHANT_OFFICER";
  region: string | null;
  business_unit: string | null;
  status: string;
  stage: Stage;
  route: number | null;
  current_version_id: string | null;
  requested_amount_kobo: string | number | null;
  customer_name: string | null;
  selected_rbe_id: string | null;
  endorser_id: string | null;
  first_reviewer_id: string | null;
  second_reviewer_id: string | null;
  pack_co3_id: string | null;
  do1_id: string | null;
  do2_id: string | null;
  active_correction_id: string | null;
  lock_version: number;
  created_at: Date;
  submitted_at: Date | null;
  disbursed_at: Date | null;
  vendor_confirmed_at: Date | null;
  process_completed_at: Date | null;
  repayment_prompts_active_at: Date | null;
  closed_at: Date | null;
}

export interface EligibleStaff {
  staff_id: string;
  role: Role;
  full_name: string;
  email: string;
}

export async function eligibleStaff(tx: Tx, roles: readonly Role[], exclude: readonly (string | null)[]): Promise<EligibleStaff[]> {
  const ex = exclude.filter((x): x is string => !!x);
  const r = await tx.query<EligibleStaff>(
    `SELECT ra.staff_id, ra.role, s.full_name, s.email
       FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id
      WHERE ra.active AND s.status = 'ACTIVE' AND ra.role = ANY($1::text[])
        AND NOT (ra.staff_id = ANY($2::uuid[]))
      ORDER BY ra.role, s.full_name`,
    [roles, ex],
  );
  return r.rows;
}

/** Staff that have taken a decision on any credit/approval stage of the case (separation of duties). */
async function priorApprovers(tx: Tx, appId: string): Promise<string[]> {
  const r = await tx.query<{ actor_id: string }>(
    `SELECT DISTINCT actor_id FROM decisions WHERE application_id = $1
       AND stage IN ('BUSINESS_ENDORSEMENT','FIRST_CREDIT_REVIEW','SECOND_CREDIT_REVIEW','UNIT_HEAD_REVIEW','DIVISIONAL_HEAD_REVIEW')`,
    [appId],
  );
  return r.rows.map((x) => x.actor_id);
}

export interface AssignmentSpec {
  roles: Role[];
  exclude: (string | null)[];
}

/** Which roles may hold a stage for a case, and who is excluded (separation of duties). */
export async function assignmentSpec(tx: Tx, app: AppRow, stage: Stage): Promise<AssignmentSpec> {
  const route = getRoute(app.route);
  switch (stage) {
    case "BUSINESS_ENDORSEMENT": {
      if (app.initiator_role === "RM") return { roles: ["RBE"], exclude: [app.initiator_id] };
      if (app.initiator_role === "MERCHANT_OFFICER") return { roles: ["MERCHANT_OFFICER_LEAD"], exclude: [app.initiator_id] };
      const zone = zoneForRegion(app.region);
      if (zone === "NORTH") return { roles: ["ANM_LEAD_NORTH"], exclude: [app.initiator_id] };
      if (zone === "SOUTH") return { roles: ["ANM_LEAD_SOUTH"], exclude: [app.initiator_id] };
      return { roles: [], exclude: [] }; // ANM without a configured state -> unstaffed
    }
    case "DRAFT":
    case "INITIATOR_CORRECTION":
    case "OFFER_PREPARATION":
    case "VENDOR_CONFIRMATION":
      return { roles: [app.initiator_role], exclude: [] };
    case "FIRST_CREDIT_REVIEW":
    case "CREDIT_CORRECTION":
      if (!route) throw new Error("Route not set");
      return { roles: route.firstReviewRoles, exclude: [app.initiator_id, app.endorser_id] };
    case "SECOND_CREDIT_REVIEW":
      if (!route) throw new Error("Route not set");
      return { roles: route.secondReviewRoles, exclude: [app.initiator_id, app.endorser_id, app.first_reviewer_id] };
    case "UNIT_HEAD_REVIEW":
      return { roles: ["UNIT_HEAD"], exclude: [app.initiator_id, app.endorser_id, app.first_reviewer_id, app.second_reviewer_id] };
    case "DIVISIONAL_HEAD_REVIEW":
      return {
        roles: ["DIVISIONAL_HEAD"],
        exclude: [app.initiator_id, app.endorser_id, app.first_reviewer_id, app.second_reviewer_id, ...(await priorApprovers(tx, app.id))],
      };
    case "CO3_PACK_REVIEW":
    case "DISBURSEMENT_CORRECTION":
    case "COMPLETION":
      return { roles: ["CREDIT_OFFICER_3"], exclude: [app.initiator_id] };
    case "DISBURSEMENT_CHECK":
      return { roles: ["DISBURSEMENT_OFFICER_1"], exclude: [app.initiator_id, app.pack_co3_id] };
    case "DISBURSEMENT_BOOKING":
      return { roles: ["DISBURSEMENT_OFFICER_2"], exclude: [app.initiator_id, app.pack_co3_id, app.do1_id] };
    default:
      return { roles: [], exclude: [] };
  }
}

export interface Chosen {
  staffId: string | null;
  role: Role;
  method: "ROUTED" | "RANDOM" | "RETAINED" | "INITIATOR" | "NO_ELIGIBLE";
  pool: EligibleStaff[];
}

/**
 * Choose an assignee for a stage.
 *  - `preferred`: keep a specific person if they are still eligible (e.g. the RBE selected by the RM,
 *    the original first reviewer, the reviewer who requested a correction).
 *  - `random`: select uniformly among eligible roles, then uniformly among people in that role
 *    (secure RNG). The choice is stored once on the task inside the transition transaction.
 *  - When nobody is eligible the task is created unassigned and surfaced to Super Admin;
 *    the stage can never be skipped.
 */
export async function chooseAssignee(
  tx: Tx,
  app: AppRow,
  stage: Stage,
  opts: { preferred?: string | null; random?: boolean; requirePreferred?: boolean } = {},
): Promise<Chosen> {
  const spec = await assignmentSpec(tx, app, stage);
  const fallbackRole = (spec.roles[0] ?? app.initiator_role) as Role;
  if (["INITIATOR_CORRECTION", "OFFER_PREPARATION", "VENDOR_CONFIRMATION"].includes(stage)) {
    const pool = await eligibleStaff(tx, spec.roles, []);
    const me = pool.find((p) => p.staff_id === app.initiator_id);
    return me
      ? { staffId: me.staff_id, role: me.role, method: "INITIATOR", pool }
      : { staffId: null, role: app.initiator_role, method: "NO_ELIGIBLE", pool };
  }
  const pool = spec.roles.length ? await eligibleStaff(tx, spec.roles, spec.exclude) : [];
  if (opts.preferred) {
    const p = pool.find((x) => x.staff_id === opts.preferred);
    if (p) return { staffId: p.staff_id, role: p.role, method: opts.random ? "RETAINED" : "ROUTED", pool };
    if (opts.requirePreferred) return { staffId: null, role: fallbackRole, method: "NO_ELIGIBLE", pool };
  }
  if (pool.length === 0) return { staffId: null, role: fallbackRole, method: "NO_ELIGIBLE", pool };
  const rolesWithStaff = [...new Set(pool.map((p) => p.role))];
  const role = securePick(rolesWithStaff);
  const person = securePick(pool.filter((p) => p.role === role));
  return { staffId: person.staff_id, role, method: opts.random ? "RANDOM" : "ROUTED", pool };
}

/** Create the next open task (one open task per case is enforced by a unique index). */
export async function openTask(
  tx: Tx,
  ctx: Ctx,
  app: AppRow,
  stage: Stage,
  chosen: Chosen,
  note?: string,
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO tasks (application_id, stage, assignee_role, assignee_id, version_id, required_action, assignment_note, entered_at, assigned_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [app.id, stage, chosen.role, chosen.staffId, app.current_version_id, REQUIRED_ACTION[stage], note ?? null, ctx.now, chosen.staffId ? ctx.now : null],
  );
  const taskId = r.rows[0].id;
  await tx.query(
    `INSERT INTO assignment_changes (task_id, from_staff_id, to_staff_id, method, eligible_pool, changed_by, changed_at)
     VALUES ($1,NULL,$2,$3,$4,$5,$6)`,
    [taskId, chosen.staffId, chosen.method, JSON.stringify(chosen.pool.map((p) => ({ id: p.staff_id, role: p.role }))), ctx.actor?.staffId ?? null, ctx.now],
  );
  await audit(tx, ctx, {
    action: chosen.staffId ? "TASK_ASSIGNED" : "TASK_UNASSIGNED_NO_ELIGIBLE_STAFF",
    outcome: chosen.staffId ? "SUCCESS" : "FAILURE",
    applicationId: app.id,
    stage,
    assignmentTo: chosen.staffId,
    details: { method: chosen.method, role: chosen.role, eligibleCount: chosen.pool.length, taskId },
  });
  if (chosen.staffId) {
    await notifyAssignment(tx, ctx, app, taskId, stage, chosen.staffId);
  } else {
    await notifyAdminsUnassigned(tx, ctx, app, taskId, stage, chosen.role);
  }
  return taskId;
}

export async function notifyAssignment(tx: Tx, ctx: Ctx, app: AppRow, taskId: string, stage: Stage, staffId: string, suffix = "") {
  const s = await tx.query<{ email: string }>("SELECT email FROM staff WHERE id = $1", [staffId]);
  const a = await latestAssessment(tx, app.id);
  const amount = app.requested_amount_kobo === null ? null : Number(app.requested_amount_kobo);
  const msg = assignmentEmail({
    ref: app.ref,
    applicationId: app.id,
    taskId,
    stage,
    customerName: app.customer_name ?? "",
    amountKobo: amount,
    assessment: a ? await withException(tx, app.id, assessmentSummary(a)) : null,
    assignedAt: ctx.now,
  });
  await enqueueEmail(tx, ctx.now, {
    kind: "ASSIGNMENT",
    dedupeKey: `assign:${taskId}:${staffId}${suffix}`,
    applicationId: app.id,
    to: [s.rows[0].email],
    subject: msg.subject,
    text: msg.text,
  });
}

async function notifyAdminsUnassigned(tx: Tx, ctx: Ctx, app: AppRow, taskId: string, stage: Stage, role: Role) {
  const admins = await tx.query<{ email: string }>(
    `SELECT s.email FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id
      WHERE ra.active AND ra.role = 'SUPER_ADMIN' AND s.status = 'ACTIVE'`,
  );
  if (admins.rows.length === 0) return;
  await enqueueEmail(tx, ctx.now, {
    kind: "ASSIGNMENT_EXCEPTION",
    dedupeKey: `unassigned:${taskId}`,
    applicationId: app.id,
    to: admins.rows.map((r) => r.email),
    subject: `WakeelBoost ${app.ref}: no eligible assignee for ${STAGE_LABELS[stage]}`,
    text: simpleEmail([
      `Request ${app.ref} has reached "${STAGE_LABELS[stage]}" but no active, eligible staff member holds the required role (${role}).`,
      "The stage cannot be skipped. Provision or assign an eligible officer in Admin → Assignment exceptions.",
    ]),
  });
}
