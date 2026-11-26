import { managerOf } from "./org";
import type { Tx } from "../db";
import { notifyExceptionReviewer } from "./credit-exception";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { securePick } from "../crypto";
import { enqueueEmail } from "../notify/outbox";
import { assignmentEmail, simpleEmail } from "../notify/templates";
import { regionScopeValues, zoneForRegion, type Role } from "./roles";
import { REQUIRED_ACTION, STAGE_LABELS, type Stage } from "./stages";
import { creditBandOfApp } from "./approval-workflows";
import { latestAssessment, type AssessmentRow } from "./assessment";
import type { AssessmentSummary } from "../notify/templates";
import type { PricingResult } from "./pricing";
import { PLATFORM_NAME } from "../brand";

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
  initiator_role: "RM" | "ANM" | "MERCHANT_OFFICER" | "MERCHANT_OFFICER_LEAD" | "MERCHANT_OFFICER_HEAD" | "DELIGHT_OFFICER" | "TEAM_LEAD" | "UNIT_HEAD";
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
  workflow: "WAKEELBOOST" | "RETAIL";
  /** Approval policy pinned at first submission (STANDARD = the chain in force before RETAIL_CX_V1). */
  approval_policy?: "STANDARD" | "RETAIL_CX_V1";
  product_code: string | null;
  product_label: string | null;
  product_config_id: string | null;
  customer_profile: string | null;
  financing_structure: string | null;
  team: string | null;
  outlet_location_id: string | null;
  /** Where the request was originated (RM-selected location, or the Delight Officer's outlet); reporting only. */
  origination_location_id?: string | null;
  location_snapshot: Record<string, unknown> | null;
  assigned_rm_id: string | null;
  oss_reviewer_id: string | null;
  team_lead_id: string | null;
  hrs_id: string | null;
  hou_id: string | null;
  mo_head_id?: string | null;
  /** Routing pinned at submission: DBC / NON_DBC (null: unclassified, existing route). */
  routing_segment?: string | null;
  /** The Unit Head resolved at submission (DBC regional Unit Head or the E-commerce Unit Head). */
  routing_unit_head_id?: string | null;
  cx_reviewer_id?: string | null;
  /** Customer repayment account recorded at origination or before offer preparation. */
  repayment_account?: { bankName?: string; accountNumber?: string; accountName?: string; branch?: string; townCity?: string } | null;
  suspended_at: Date | null;
  suspension_reason: string | null;
  business_approved_at?: Date | null;
  /** Approval workflow version recorded at submission (null: submitted before configurable workflows). */
  workflow_version_id?: string | null;
}

export interface EligibleStaff {
  staff_id: string;
  role: Role;
  full_name: string;
  email: string;
}

/**
 * The application column that records who holds a review stage. Automatic routing writes these as it enters
 * a stage; a manual assignment must write the same column so the case shows its reviewer and later stages can
 * exclude them (separation of duties).
 */
export const STAGE_REVIEWER_COLUMN: Partial<Record<Stage, string>> = {
  BUSINESS_ENDORSEMENT: "endorser_id",
  MO_HEAD_REVIEW: "mo_head_id",
  OSS_REVIEW: "oss_reviewer_id",
  TEAM_LEAD_REVIEW: "team_lead_id",
  HRS_REVIEW: "hrs_id",
  HEAD_OF_UNIT_APPROVAL: "hou_id",
  // UNIT_HEAD_REVIEW is the credit Unit Head, not the business Head of Unit: never overwrite hou_id.
  CX_CREDIT_REVIEW: "cx_reviewer_id",
  FIRST_CREDIT_REVIEW: "first_reviewer_id",
  CREDIT_CORRECTION: "first_reviewer_id",
  SECOND_CREDIT_REVIEW: "second_reviewer_id",
  CO3_PACK_REVIEW: "pack_co3_id",
  DISBURSEMENT_CORRECTION: "pack_co3_id",
  COMPLETION: "pack_co3_id",
  DISBURSEMENT_CHECK: "do1_id",
  DISBURSEMENT_BOOKING: "do2_id",
};

export async function eligibleStaff(
  tx: Tx,
  roles: readonly Role[],
  exclude: readonly (string | null)[],
  scope: { team?: string | null; only?: (string | null)[] | null; region?: string | null } = {},
): Promise<EligibleStaff[]> {
  const ex = exclude.filter((x): x is string => !!x);
  const only = scope.only ? scope.only.filter((x): x is string => !!x) : null;
  // A state and its legacy zone (SOUTH/NORTH) must match each other; see regionScopeValues.
  const regions = scope.region ? regionScopeValues(scope.region) : null;
  const r = await tx.query<EligibleStaff>(
    `SELECT ra.staff_id, ra.role, s.full_name, s.email
       FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id
      WHERE ra.active AND s.status = 'ACTIVE' AND ra.role = ANY($1::text[])
        AND NOT (ra.staff_id = ANY($2::uuid[]))
        AND ($3::text IS NULL OR regexp_replace(upper(coalesce(ra.team, '')), '[^A-Z0-9]', '', 'g') = regexp_replace(upper($3), '[^A-Z0-9]', '', 'g'))
        AND ($4::uuid[] IS NULL OR ra.staff_id = ANY($4::uuid[]))
        AND ($5::text[] IS NULL OR ra.region = ANY($5::text[]))
      ORDER BY ra.role, s.full_name`,
    [roles, ex, scope.team ?? null, only, regions],
  );
  return r.rows;
}

/** Staff that have taken a decision on any credit/approval stage of the case (separation of duties). */
async function priorApprovers(tx: Tx, appId: string): Promise<string[]> {
  const r = await tx.query<{ actor_id: string }>(
    `SELECT DISTINCT actor_id FROM decisions WHERE application_id = $1 AND invalidated_at IS NULL
       AND stage IN ('BUSINESS_ENDORSEMENT','MO_HEAD_REVIEW','CX_CREDIT_REVIEW','FIRST_CREDIT_REVIEW','SECOND_CREDIT_REVIEW','UNIT_HEAD_REVIEW','DIVISIONAL_HEAD_REVIEW',
                     'OSS_REVIEW','TEAM_LEAD_REVIEW','HRS_REVIEW','HEAD_OF_UNIT_APPROVAL')`,
    [appId],
  );
  return r.rows.map((x) => x.actor_id);
}

/** Non-DBC RBE stage: only the RBE pinned on the request (the RM's assigned RBE); never another RBE. */
function rbeSpec(app: AppRow): AssignmentSpec {
  return { roles: ["RBE"], exclude: [app.initiator_id], only: [app.selected_rbe_id], scopeNote: app.selected_rbe_id ? "The RM's assigned Regional Business Executive" : "The RM has no assigned Regional Business Executive" };
}
/** CX credit review on the Non-DBC route: any CX Credit Reviewer not involved earlier on the request. */
async function cxSpec(tx: Tx, app: AppRow): Promise<AssignmentSpec> {
  return { roles: ["CX_CREDIT_REVIEWER"], exclude: [app.initiator_id, app.selected_rbe_id, app.endorser_id, ...(await priorApprovers(tx, app.id)).filter((x) => x !== app.cx_reviewer_id)], scopeNote: "CX Credit Reviewer (not involved earlier on this request)" };
}
export interface InitiatorScope {
  region: string | null;
  team: string | null;
  businessUnit: string | null;
}

/**
 * The state/team that owns a request's business review.
 *
 * A request keeps a scope snapshot from when it was created, but that snapshot goes stale when the
 * initiator's role assignment is moved to another state/team (a correction to their record). Routing must
 * follow the initiator's CURRENT active assignment (or the originating outlet for a Delight Officer), otherwise
 * a resubmission can send the case back to a reviewer in the state the initiator has left.
 *
 * Falls back to the stored snapshot when no active assignment/outlet can be read, so an in-flight case is
 * never stranded by a missing record.
 */
export async function currentInitiatorScope(tx: Tx, app: AppRow): Promise<InitiatorScope> {
  const fallback: InitiatorScope = { region: app.region, team: app.team, businessUnit: app.business_unit };
  if (app.initiator_role === "DELIGHT_OFFICER" && app.workflow === "RETAIL") {
    if (!app.outlet_location_id) return fallback;
    const loc = (
      await tx.query<{ state: string | null; team: string | null; business_unit: string | null }>(
        "SELECT state, team, business_unit FROM locations WHERE id = $1",
        [app.outlet_location_id],
      )
    ).rows[0];
    return loc ? { region: loc.state, team: loc.team, businessUnit: loc.business_unit } : fallback;
  }
  const ra = (
    await tx.query<{ region: string | null; team: string | null; business_unit: string | null }>(
      `SELECT ra.region, ra.team, ra.business_unit
         FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id
        WHERE ra.staff_id = $1 AND ra.role = $2 AND ra.active AND s.status = 'ACTIVE'
        ORDER BY ra.granted_at DESC LIMIT 1`,
      [app.initiator_id, app.initiator_role],
    )
  ).rows[0];
  return ra ? { region: ra.region, team: ra.team, businessUnit: ra.business_unit } : fallback;
}

/** Bring the request's stored scope in step with the initiator's current assignment/outlet. */
export async function refreshInitiatorScope(tx: Tx, app: AppRow): Promise<void> {
  const scope = await currentInitiatorScope(tx, app);
  app.region = scope.region;
  app.team = scope.team;
  app.business_unit = scope.businessUnit;
}

/** Unit Head stage when the request's routing pinned a Unit Head (DBC regional Unit Head or E-commerce Unit Head). */
function pinnedUnitHead(app: AppRow, exclude: (string | null)[]): AssignmentSpec | null {
  if (!app.routing_segment) return null;
  const who = app.routing_segment === "NON_DBC" ? "E-commerce Unit Head" : "DBC Unit Head for the RM's region";
  return { roles: ["UNIT_HEAD"], exclude, only: [app.routing_unit_head_id ?? null], scopeNote: app.routing_unit_head_id ? `The configured ${who}` : `No ${who} is configured (Configuration centre → RM classification and routing)` };
}

export interface AssignmentSpec {
  roles: Role[];
  exclude: (string | null)[];
  team?: string | null;
  only?: (string | null)[] | null;
  /** State/region scope (e.g. the Team Lead of the request's state). */
  region?: string | null;
  /** Why the pool may be empty (shown on the assignment exception). */
  scopeNote?: string;
}

/** Retail routing: business review by team / outlet / organisation scope, independent credit review. */
async function retailSpec(tx: Tx, app: AppRow, stage: Stage): Promise<AssignmentSpec | null> {
  const base = [app.initiator_id, app.assigned_rm_id, app.mo_head_id ?? null];
  switch (stage) {
    case "OSS_REVIEW": {
      const loc = app.outlet_location_id ? (await tx.query<{ oss_staff_id: string | null; active: boolean }>("SELECT oss_staff_id, active FROM locations WHERE id = $1", [app.outlet_location_id])).rows[0] : null;
      return { roles: ["OUTLET_SERVICE_SUPERVISOR"], exclude: base, only: [loc?.oss_staff_id ?? null], scopeNote: loc?.oss_staff_id ? "Outlet Service Supervisor mapped to the originating outlet" : "No Outlet Service Supervisor is mapped to the originating outlet" };
    }
    case "TEAM_LEAD_REVIEW": {
      // The Team Lead who owns the initiator's CURRENT team, inside their CURRENT state. Team codes are compared
      // with punctuation removed (RETAIL KANO / RETAIL-KANO), not by guessing that two different codes are the
      // same team. If the request has no team, the state's Team Lead is the only safe scope, and the reverse is
      // true when no state was recorded.
      const scope = await currentInitiatorScope(tx, app);
      const exclude = [...base, app.oss_reviewer_id];
      if (scope.region && scope.team)
        return { roles: ["TEAM_LEAD"], exclude, region: scope.region, team: scope.team, scopeNote: `Team Lead for team ${scope.team} in ${scope.region}` };
      if (scope.region) return { roles: ["TEAM_LEAD"], exclude, region: scope.region, scopeNote: `Team Lead in ${scope.region}` };
      if (!scope.team) return { roles: ["TEAM_LEAD"], exclude, only: [], scopeNote: "The request has no state or team, so no Team Lead is in scope" };
      return { roles: ["TEAM_LEAD"], exclude, team: scope.team, scopeNote: `Team Lead for team ${scope.team}` };
    }
    case "HRS_REVIEW":
      return { roles: ["HEAD_OF_RETAIL_SALES"], exclude: [...base, app.oss_reviewer_id, app.team_lead_id], scopeNote: "Head of Retail Sales (organisation)" };
    case "HEAD_OF_UNIT_APPROVAL":
      return { roles: ["HEAD_OF_UNIT"], exclude: [...base, app.oss_reviewer_id, app.team_lead_id, app.hrs_id, ...(await priorApprovers(tx, app.id))], scopeNote: "Head of Unit (must not have already decided on this request)" };
    case "FIRST_CREDIT_REVIEW":
    case "CREDIT_CORRECTION": {
      const prior = (await priorApprovers(tx, app.id)).filter((x) => x !== app.first_reviewer_id);
      if (app.approval_policy === "RETAIL_CX_V1")
        return { roles: ["CX_CREDIT_REVIEWER"], exclude: [...base, app.oss_reviewer_id, app.team_lead_id, app.hrs_id, app.hou_id, ...prior], scopeNote: "CX Credit Reviewer (not involved earlier on this request)" };
      const route = await creditBandOfApp(tx, app);
      if (!route) throw new Error("Route not set");
      return { roles: route.firstReviewRoles as Role[], exclude: [...base, app.oss_reviewer_id, app.team_lead_id, app.hrs_id, app.hou_id, ...prior] };
    }
    case "SECOND_CREDIT_REVIEW": {
      const route = await creditBandOfApp(tx, app);
      if (!route) throw new Error("Route not set");
      return { roles: route.secondReviewRoles as Role[], exclude: [...base, app.oss_reviewer_id, app.team_lead_id, app.hrs_id, app.hou_id, app.first_reviewer_id, app.cx_reviewer_id ?? null, app.endorser_id] };
    }
    case "BUSINESS_ENDORSEMENT":
      return rbeSpec(app);
    case "CX_CREDIT_REVIEW":
      return cxSpec(tx, app);
    case "UNIT_HEAD_REVIEW": {
      const ex = [...base, app.oss_reviewer_id, app.team_lead_id, app.hrs_id, app.hou_id, app.first_reviewer_id, app.second_reviewer_id, app.cx_reviewer_id ?? null, app.endorser_id];
      return pinnedUnitHead(app, ex) ?? { roles: ["UNIT_HEAD"], exclude: ex };
    }
    case "DIVISIONAL_HEAD_REVIEW":
      return { roles: ["DIVISIONAL_HEAD"], exclude: [...base, app.oss_reviewer_id, app.team_lead_id, app.hrs_id, app.hou_id, app.first_reviewer_id, app.second_reviewer_id, ...(await priorApprovers(tx, app.id))] };
    case "PAYMENT_RECONCILIATION":
      return { roles: ["DISBURSEMENT_OFFICER_1"], exclude: [...base, app.pack_co3_id, app.do2_id] };
    case "DISBURSEMENT_CHECK":
      return { roles: ["DISBURSEMENT_OFFICER_1"], exclude: [...base, app.pack_co3_id] };
    case "DISBURSEMENT_BOOKING":
      return { roles: ["DISBURSEMENT_OFFICER_2"], exclude: [...base, app.pack_co3_id, app.do1_id] };
    case "FULFILMENT":
      return { roles: [app.initiator_role], exclude: [], only: [app.initiator_id], scopeNote: "The initiator (fulfilment is confirmed on the request they raised)" };
    default:
      return null;
  }
}

/** Which roles may hold a stage for a case, and who is excluded (separation of duties). */
export async function assignmentSpec(tx: Tx, app: AppRow, stage: Stage): Promise<AssignmentSpec> {
  if (app.workflow === "RETAIL") {
    const r = await retailSpec(tx, app, stage);
    if (r) return r;
  }
  const route = ["FIRST_CREDIT_REVIEW", "CREDIT_CORRECTION", "SECOND_CREDIT_REVIEW"].includes(stage) ? await creditBandOfApp(tx, app) : null;
  switch (stage) {
    case "BUSINESS_ENDORSEMENT": {
      if (app.initiator_role === "RM") return app.routing_segment === "NON_DBC" ? rbeSpec(app) : { roles: ["RBE"], exclude: [app.initiator_id] };
      if (app.initiator_role === "MERCHANT_OFFICER") {
        // The officer's own Lead when a reporting line is set; otherwise any Merchant Officer Lead.
        const lead = await managerOf(tx, app.initiator_id, "MO_LEAD");
        return lead
          ? { roles: ["MERCHANT_OFFICER_LEAD"], exclude: [app.initiator_id], only: [lead], scopeNote: "The Merchant Officer's Lead (reporting line)" }
          : { roles: ["MERCHANT_OFFICER_LEAD"], exclude: [app.initiator_id] };
      }
      // ANM routing is zone-scoped: follow the initiator's current state, not the state captured at creation.
      const scope = await currentInitiatorScope(tx, app);
      const zone = zoneForRegion(scope.region);
      if (zone === "NORTH") return { roles: ["ANM_LEAD_NORTH"], exclude: [app.initiator_id] };
      if (zone === "SOUTH") return { roles: ["ANM_LEAD_SOUTH"], exclude: [app.initiator_id] };
      return { roles: [], exclude: [] }; // ANM without a configured state -> unstaffed
    }
    case "MO_HEAD_REVIEW": {
      // The Head of the Lead in the chain (the endorsing Lead, or the originating Lead); otherwise any Head.
      const lead = app.initiator_role === "MERCHANT_OFFICER_LEAD" ? app.initiator_id : app.endorser_id;
      const head = await managerOf(tx, lead, "MO_HEAD");
      return head
        ? { roles: ["MERCHANT_OFFICER_HEAD"], exclude: [app.initiator_id, app.endorser_id], only: [head], scopeNote: "The Lead's Merchant Officer Head (reporting line)" }
        : { roles: ["MERCHANT_OFFICER_HEAD"], exclude: [app.initiator_id, app.endorser_id] };
    }
    case "CX_CREDIT_REVIEW":
      return cxSpec(tx, app);
    case "DRAFT":
    case "INITIATOR_CORRECTION":
    case "OFFER_PREPARATION":
    case "VENDOR_CONFIRMATION":
      // These stages return the case to the person who raised it. Never offer another holder of the same role.
      return { roles: [app.initiator_role], exclude: [], only: [app.initiator_id], scopeNote: "The initiator (the case must return to the officer who raised it)" };
    case "FIRST_CREDIT_REVIEW":
    case "CREDIT_CORRECTION":
      if (!route) throw new Error("Route not set");
      return { roles: route.firstReviewRoles as Role[], exclude: [app.initiator_id, app.endorser_id, app.mo_head_id ?? null, app.cx_reviewer_id ?? null] };
    case "SECOND_CREDIT_REVIEW":
      if (!route) throw new Error("Route not set");
      return { roles: route.secondReviewRoles as Role[], exclude: [app.initiator_id, app.endorser_id, app.first_reviewer_id, app.mo_head_id ?? null, app.cx_reviewer_id ?? null] };
    case "UNIT_HEAD_REVIEW": {
      const ex = [app.initiator_id, app.endorser_id, app.first_reviewer_id, app.second_reviewer_id, app.cx_reviewer_id ?? null, app.mo_head_id ?? null];
      return pinnedUnitHead(app, ex) ?? { roles: ["UNIT_HEAD"], exclude: ex };
    }
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
  scopeNote?: string;
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
  if (["INITIATOR_CORRECTION", "OFFER_PREPARATION", "VENDOR_CONFIRMATION", "FULFILMENT"].includes(stage)) {
    const pool = await eligibleStaff(tx, spec.roles, spec.exclude, { team: spec.team, only: spec.only, region: spec.region });
    const me = pool.find((p) => p.staff_id === app.initiator_id);
    return me
      ? { staffId: me.staff_id, role: me.role, method: "INITIATOR", pool }
      : { staffId: null, role: app.initiator_role, method: "NO_ELIGIBLE", pool };
  }
  const pool = spec.roles.length && !(spec.only && spec.only.filter(Boolean).length === 0) ? await eligibleStaff(tx, spec.roles, spec.exclude, { team: spec.team, only: spec.only, region: spec.region }) : [];
  if (opts.preferred) {
    const p = pool.find((x) => x.staff_id === opts.preferred);
    if (p) return { staffId: p.staff_id, role: p.role, method: opts.random ? "RETAINED" : "ROUTED", pool };
    if (opts.requirePreferred) return { staffId: null, role: fallbackRole, method: "NO_ELIGIBLE", pool, scopeNote: spec.scopeNote };
  }
  if (pool.length === 0) return { staffId: null, role: fallbackRole, method: "NO_ELIGIBLE", pool, scopeNote: spec.scopeNote };
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
    [app.id, stage, chosen.role, chosen.staffId, app.current_version_id, REQUIRED_ACTION[stage], note ?? (chosen.staffId ? null : (chosen.scopeNote ?? null)), ctx.now, chosen.staffId ? ctx.now : null],
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
    await notifyExceptionReviewer(tx, ctx, app, taskId, stage, chosen.staffId);
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

export async function notifyAdminsUnassigned(tx: Tx, ctx: Ctx, app: AppRow, taskId: string, stage: Stage, role: Role) {
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
    subject: `${PLATFORM_NAME} ${app.ref}: no eligible assignee for ${STAGE_LABELS[stage]}`,
    text: simpleEmail([
      `Request ${app.ref} has reached "${STAGE_LABELS[stage]}" but no active, eligible staff member holds the required role (${role}) within the request's scope.`,
      "The stage cannot be skipped. Provision or assign an eligible officer in Admin → Assignment exceptions.",
    ]),
  });
}
