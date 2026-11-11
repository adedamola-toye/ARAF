/**
 * Retail dashboards and reports, role-scoped and computed server-side. Requested (submitted, from the
 * request ledger), approved (approved assessment principal), booked (facility principal) and successfully
 * disbursed (reconciled payments) amounts are always kept separate.
 */
import type { Db } from "./db";
import { db } from "./db";
import type { Ctx } from "./context";
import { auditOutsideTx } from "./audit";
import { forbidden } from "./errors";
import { activeRoles } from "./domain/access";
import { facilityPosition } from "./domain/retail-ops";
import { STAGE_LABELS, type Stage } from "./domain/stages";
import { addDaysToDateString, fromLagos, lagosDate } from "./time";

export interface RetailScope {
  kind: "ALL" | "SCOPED";
  label: string;
  teams: string[];
  outletIds: string[];
  ownId: string | null;
}

const ALL_ROLES = ["SUPER_ADMIN", "REPORTING_ADMIN", "HEAD_OF_RETAIL_SALES", "HEAD_OF_UNIT", "CREDIT_OFFICER_1", "CREDIT_OFFICER_2", "CREDIT_OFFICER_3", "CREDIT_LEAD_1", "CREDIT_LEAD_2", "UNIT_HEAD", "DIVISIONAL_HEAD", "DISBURSEMENT_OFFICER_1", "DISBURSEMENT_OFFICER_2", "COLLECTIONS_OFFICER"];

/** Organisation-wide for leadership, credit, operations and reporting; team, outlet or own cases otherwise. */
export async function retailScope(q: Db, staffId: string): Promise<RetailScope | null> {
  const roles = await activeRoles(q, staffId);
  if (roles.some((r) => ALL_ROLES.includes(r.role))) return { kind: "ALL", label: "All retail applications", teams: [], outletIds: [], ownId: null };
  const teams = roles.filter((r) => r.role === "TEAM_LEAD").map((r) => (r as { team?: string | null }).team).filter((t): t is string => !!t);
  const teamRows = (await q.query<{ team: string }>("SELECT team FROM role_assignments WHERE staff_id = $1 AND active AND role = 'TEAM_LEAD' AND team IS NOT NULL", [staffId])).rows.map((r) => r.team);
  const outlets = (await q.query<{ id: string }>("SELECT id FROM locations WHERE oss_staff_id = $1", [staffId])).rows.map((r) => r.id);
  const isOss = roles.some((r) => r.role === "OUTLET_SERVICE_SUPERVISOR");
  const isInitiator = roles.some((r) => r.role === "RM" || r.role === "DELIGHT_OFFICER");
  const allTeams = [...new Set([...teams, ...teamRows])];
  if (!allTeams.length && !(isOss && outlets.length) && !isInitiator) return null;
  const parts = [allTeams.length ? `team${allTeams.length > 1 ? "s" : ""} ${allTeams.join(", ")}` : null, isOss && outlets.length ? `${outlets.length} outlet${outlets.length > 1 ? "s" : ""}` : null, isInitiator ? "your own applications" : null].filter(Boolean);
  return { kind: "SCOPED", label: parts.join(" + "), teams: allTeams, outletIds: isOss ? outlets : [], ownId: isInitiator ? staffId : null };
}

export interface RetailFilters {
  from?: string | null;
  to?: string | null;
  product?: string | null;
}

function where(scope: RetailScope, f: RetailFilters, alias = "a") {
  const w = [`${alias}.workflow = 'RETAIL'`];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (scope.kind === "SCOPED") {
    const ors: string[] = [];
    if (scope.teams.length) ors.push(`(${alias}.team = ANY(${p(scope.teams)}::text[]) AND ${alias}.stage <> 'DRAFT')`);
    if (scope.outletIds.length) ors.push(`(${alias}.outlet_location_id = ANY(${p(scope.outletIds)}::uuid[]) AND ${alias}.stage <> 'DRAFT')`);
    if (scope.ownId) ors.push(`(${alias}.initiator_id = ${p(scope.ownId)} OR ${alias}.assigned_rm_id = ${p(scope.ownId)})`);
    w.push(ors.length ? `(${ors.join(" OR ")})` : "false");
  }
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (f.from && re.test(f.from)) {
    const [y, m, d] = f.from.split("-").map(Number);
    w.push(`${alias}.created_at >= ${p(fromLagos(y, m, d))}`);
  }
  if (f.to && re.test(f.to)) {
    const [y, m, d] = addDaysToDateString(f.to, 1).split("-").map(Number);
    w.push(`${alias}.created_at < ${p(fromLagos(y, m, d))}`);
  }
  if (f.product) w.push(`${alias}.product_code = ${p(f.product)}`);
  return { sql: w.join(" AND "), params };
}

export async function retailDashboard(q: Db, scope: RetailScope, f: RetailFilters, now: Date) {
  const { sql, params } = where(scope, f);
  const run = async <R extends Record<string, unknown>>(text: string) => (await q.query<R>(text, params)).rows;
  const byGroup = await run<{ product: string; profile: string; channel: string; stage: string; n: string }>(
    `SELECT a.product_label AS product, a.customer_profile AS profile, a.initiator_role AS channel, a.stage, count(*)::text AS n FROM applications a WHERE ${sql} GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`,
  );
  const amounts = (
    await run<{ requested: string; approved: string; booked: string; disbursed: string; submitted: string; business_approved: string; credit_approved: string; booked_n: string; disbursed_n: string; declined: string; withdrawn: string; completed: string }>(
      `SELECT
         coalesce((SELECT sum(l.requested_amount_kobo) FROM request_ledger l JOIN applications a ON a.id = l.application_id WHERE ${sql}),0)::text AS requested,
         coalesce((SELECT sum((ra.inputs->>'principalKobo')::bigint) FROM applications a JOIN decisions d ON d.application_id = a.id AND d.stage = 'FIRST_CREDIT_REVIEW' AND d.action = 'APPROVE' AND d.invalidated_at IS NULL
                     JOIN retail_assessments ra ON ra.id = d.retail_assessment_id WHERE ${sql}),0)::text AS approved,
         coalesce((SELECT sum(fa.principal_kobo) FROM facilities fa JOIN applications a ON a.id = fa.application_id WHERE ${sql}),0)::text AS booked,
         coalesce((SELECT sum(di.amount_kobo) FROM disbursements di JOIN applications a ON a.id = di.application_id WHERE ${sql}),0)::text AS disbursed,
         (SELECT count(*) FROM applications a WHERE ${sql} AND a.submitted_at IS NOT NULL)::text AS submitted,
         (SELECT count(*) FROM applications a WHERE ${sql} AND a.business_approved_at IS NOT NULL)::text AS business_approved,
         (SELECT count(DISTINCT a.id) FROM applications a JOIN decisions d ON d.application_id = a.id AND d.stage = 'DIVISIONAL_HEAD_REVIEW' AND d.action = 'APPROVE' AND d.invalidated_at IS NULL WHERE ${sql})::text AS credit_approved,
         (SELECT count(*) FROM facilities fa JOIN applications a ON a.id = fa.application_id WHERE ${sql})::text AS booked_n,
         (SELECT count(*) FROM disbursements di JOIN applications a ON a.id = di.application_id WHERE ${sql})::text AS disbursed_n,
         (SELECT count(*) FROM applications a WHERE ${sql} AND a.status = 'REJECTED')::text AS declined,
         (SELECT count(*) FROM applications a WHERE ${sql} AND a.status = 'WITHDRAWN')::text AS withdrawn,
         (SELECT count(*) FROM applications a WHERE ${sql} AND a.status = 'COMPLETED')::text AS completed`,
    )
  )[0];
  const declineReasons = await run<{ stage: string; reason: string; n: string }>(
    `SELECT d.stage, d.reason, count(*)::text AS n FROM decisions d JOIN applications a ON a.id = d.application_id WHERE ${sql} AND d.action = 'REJECT' GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 10`,
  );
  const correctionReasons = await run<{ stage: string; reason: string; n: string }>(
    `SELECT c.from_stage AS stage, c.reason, count(*)::text AS n FROM corrections c JOIN applications a ON a.id = c.application_id WHERE ${sql} GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 10`,
  );
  const turnaround = await run<{ stage: string; n: string; avg_hours: string; max_hours: string }>(
    `SELECT t.stage, count(*)::text AS n, round(avg(extract(epoch FROM (t.completed_at - t.entered_at)) / 3600)::numeric, 1)::text AS avg_hours,
            round(max(extract(epoch FROM (t.completed_at - t.entered_at)) / 3600)::numeric, 1)::text AS max_hours
       FROM tasks t JOIN applications a ON a.id = t.application_id WHERE ${sql} AND t.status = 'COMPLETED' GROUP BY 1 ORDER BY 1`,
  );
  const pipeline = await run<{ application_id: string; ref: string; customer_name: string; product: string; stage: string; owner: string | null; owner_role: string; entered_at: Date; required_action: string; requested: string; suspended: boolean }>(
    `SELECT a.id AS application_id, a.ref, a.customer_name, a.product_label AS product, t.stage, s.full_name AS owner, t.assignee_role AS owner_role, t.entered_at, t.required_action,
            a.requested_amount_kobo::text AS requested, a.suspended_at IS NOT NULL AS suspended
       FROM tasks t JOIN applications a ON a.id = t.application_id LEFT JOIN staff s ON s.id = t.assignee_id
      WHERE ${sql} AND t.status = 'OPEN' ORDER BY t.entered_at LIMIT 300`,
  );
  const ageing = { under1d: 0, d1to3: 0, d3to7: 0, over7d: 0, unassigned: 0 };
  for (const r of pipeline) {
    const h = (now.getTime() - new Date(r.entered_at).getTime()) / 3_600_000;
    if (!r.owner) ageing.unassigned++;
    if (h < 24) ageing.under1d++;
    else if (h < 72) ageing.d1to3++;
    else if (h < 168) ageing.d3to7++;
    else ageing.over7d++;
  }
  const dsr = (
    await run<{ fail_prelim: string; fail_final: string; ex_approved: string; ex_declined: string; ex_pending: string }>(
      `SELECT (SELECT count(*) FROM retail_assessments ra JOIN applications a ON a.id = ra.application_id WHERE ${sql} AND ra.kind = 'PRELIMINARY' AND ra.result = 'FAIL')::text AS fail_prelim,
              (SELECT count(*) FROM retail_assessments ra JOIN applications a ON a.id = ra.application_id WHERE ${sql} AND ra.kind = 'FINAL' AND ra.result = 'FAIL')::text AS fail_final,
              (SELECT count(*) FROM policy_exceptions pe JOIN applications a ON a.id = pe.application_id WHERE ${sql} AND pe.status = 'APPROVED')::text AS ex_approved,
              (SELECT count(*) FROM policy_exceptions pe JOIN applications a ON a.id = pe.application_id WHERE ${sql} AND pe.status = 'DECLINED')::text AS ex_declined,
              (SELECT count(*) FROM policy_exceptions pe JOIN applications a ON a.id = pe.application_id WHERE ${sql} AND pe.status = 'REQUESTED')::text AS ex_pending`,
    )
  )[0];
  const exceptionsByType = await run<{ type: string; status: string; n: string }>(`SELECT pe.type, pe.status, count(*)::text AS n FROM policy_exceptions pe JOIN applications a ON a.id = pe.application_id WHERE ${sql} GROUP BY 1,2 ORDER BY 1,2`);
  const outstanding = (
    await run<{ corrections: string; rejected_docs: string; fulfilment_open: string; payments_uncertain: string; suspended: string }>(
      `SELECT (SELECT count(*) FROM applications a WHERE ${sql} AND a.stage = 'INITIATOR_CORRECTION')::text AS corrections,
              (SELECT count(*) FROM documents d JOIN applications a ON a.id = d.application_id WHERE ${sql} AND d.review_status = 'REJECTED' AND d.superseded_at IS NULL)::text AS rejected_docs,
              (SELECT count(*) FROM fulfilment_tasks ft JOIN applications a ON a.id = ft.application_id WHERE ${sql} AND ft.status = 'OPEN')::text AS fulfilment_open,
              (SELECT count(*) FROM facilities fa JOIN applications a ON a.id = fa.application_id WHERE ${sql} AND fa.payment_status IN ('PENDING','PARTIAL','FAILED','REVERSED'))::text AS payments_uncertain,
              (SELECT count(*) FROM applications a WHERE ${sql} AND a.suspended_at IS NOT NULL)::text AS suspended`,
    )
  )[0];
  const paymentStatus = await run<{ payment_status: string; fulfilment_status: string; n: string }>(`SELECT fa.payment_status, fa.fulfilment_status, count(*)::text AS n FROM facilities fa JOIN applications a ON a.id = fa.application_id WHERE ${sql} GROUP BY 1,2 ORDER BY 1,2`);
  const pos = await run<{ status: string; n: string }>(`SELECT ft.status, count(*)::text AS n FROM fulfilment_tasks ft JOIN applications a ON a.id = ft.application_id WHERE ${sql} AND ft.kind = 'POS_DEPLOYMENT' GROUP BY 1`);
  const facs = await run<{ id: string; status: string; ref: string; customer_name: string; application_id: string }>(`SELECT fa.id, fa.status, a.ref, a.customer_name, a.id AS application_id FROM facilities fa JOIN applications a ON a.id = fa.application_id WHERE ${sql}`);
  const today = lagosDate(now);
  const in30 = addDaysToDateString(today, 30);
  let outstandingTotal = 0;
  let overdueTotal = 0;
  let due30 = 0;
  const overdueList: { ref: string; customer: string; overdueKobo: number; dpd: number; applicationId: string }[] = [];
  const byStatus: Record<string, number> = {};
  for (const fa of facs) {
    byStatus[fa.status] = (byStatus[fa.status] ?? 0) + 1;
    if (["CLOSED", "CANCELLED", "BOOKED"].includes(fa.status)) continue;
    const p = await facilityPosition(q, fa.id, today);
    outstandingTotal += p.outstandingKobo;
    overdueTotal += p.overdueKobo;
    const inst = (await q.query<{ amount_kobo: string }>("SELECT amount_kobo FROM repayment_instalments WHERE facility_id = $1 AND due_date > $2 AND due_date <= $3", [fa.id, today, in30])).rows;
    due30 += inst.reduce((s, i) => s + Number(i.amount_kobo), 0);
    if (p.overdueKobo > 0) overdueList.push({ ref: fa.ref, customer: fa.customer_name, overdueKobo: p.overdueKobo, dpd: p.daysPastDue, applicationId: fa.application_id });
  }
  return {
    byGroup,
    amounts,
    declineReasons,
    correctionReasons,
    turnaround: turnaround.map((t) => ({ ...t, label: STAGE_LABELS[t.stage as Stage] ?? t.stage })),
    pipeline,
    ageing,
    dsr,
    exceptionsByType,
    outstanding,
    paymentStatus,
    pos,
    portfolio: { byStatus, outstandingTotal, overdueTotal, due30, overdueList: overdueList.sort((a, b) => b.dpd - a.dpd).slice(0, 20) },
  };
}

export const RETAIL_EXPORT_COLUMNS = ["Reference", "Product", "Profile", "Channel", "Customer", "Stage", "Status", "Requested (submitted)", "Approved", "Booked", "Disbursed", "Submitted (Lagos)", "Owner", "Team"];

/** CSV export with the same scope and calculation rules as the dashboard; audited. */
export async function exportRetail(ctx: Ctx, f: RetailFilters) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const scope = await retailScope(db, actor.staffId);
  if (!scope) {
    await auditOutsideTx(ctx, { action: "RETAIL_REPORT_EXPORTED", outcome: "DENIED" });
    throw forbidden("You do not have a reporting scope for retail applications.");
  }
  const { sql, params } = where(scope, f);
  const rows = (
    await db.query(
      `SELECT a.ref, a.product_label, a.customer_profile, a.initiator_role, a.customer_name, a.stage, a.status,
              l.requested_amount_kobo, (SELECT (ra.inputs->>'principalKobo') FROM decisions d JOIN retail_assessments ra ON ra.id = d.retail_assessment_id WHERE d.application_id = a.id AND d.stage = 'FIRST_CREDIT_REVIEW' AND d.action = 'APPROVE' AND d.invalidated_at IS NULL ORDER BY d.seq DESC LIMIT 1) AS approved,
              fa.principal_kobo AS booked, di.amount_kobo AS disbursed, to_char(a.submitted_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD HH24:MI') AS submitted, s.full_name AS owner, a.team
         FROM applications a LEFT JOIN request_ledger l ON l.application_id = a.id LEFT JOIN facilities fa ON fa.application_id = a.id LEFT JOIN disbursements di ON di.application_id = a.id
         LEFT JOIN tasks t ON t.application_id = a.id AND t.status = 'OPEN' LEFT JOIN staff s ON s.id = t.assignee_id
        WHERE ${sql} ORDER BY a.created_at DESC LIMIT 10000`,
      params,
    )
  ).rows;
  const naira = (k: unknown) => (k === null || k === undefined ? "" : (Number(k) / 100).toFixed(2));
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
  };
  const lines = [RETAIL_EXPORT_COLUMNS.join(","), ...rows.map((r) => [r.ref, r.product_label, r.customer_profile, r.initiator_role, r.customer_name, r.stage, r.status, naira(r.requested_amount_kobo), naira(r.approved), naira(r.booked), naira(r.disbursed), r.submitted, r.owner, r.team].map(esc).join(","))];
  await auditOutsideTx(ctx, { action: "RETAIL_REPORT_EXPORTED", details: { rows: rows.length, scope: scope.label, filters: f } });
  return lines.join("\n");
}
