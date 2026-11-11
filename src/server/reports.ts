import { z } from "zod";
import ExcelJS from "exceljs";
import type { Db } from "./db";
import { db } from "./db";
import type { Ctx } from "./context";
import { auditOutsideTx } from "./audit";
import { forbidden } from "./errors";
import { maskWithLast4 } from "./mask";
import { formatKobo, koboToNairaString, parseNairaToKobo } from "./money";
import { activeRoles } from "./domain/access";
import { STAGE_LABELS, type Stage } from "./domain/stages";
import { expandRegions } from "./domain/roles";
import { addDaysToDateString, fromLagos, lagosDate } from "./time";

const opt = z.string().trim().optional().transform((v) => (v ? v : undefined));
export const reportFilterSchema = z.object({
  dateFrom: opt,
  dateTo: opt,
  dateBasis: z.enum(["created", "submitted", "disbursed", "closed"]).optional().default("created"),
  initiatorId: opt,
  daoCode: opt,
  region: opt,
  role: opt, // initiator role
  assigneeId: opt,
  applicantType: opt,
  route: opt,
  stage: opt,
  status: opt,
  amountMin: opt,
  amountMax: opt,
  bookingFrom: opt,
  bookingTo: opt,
  repaymentFrom: opt,
  repaymentTo: opt,
});
export type ReportFilters = z.infer<typeof reportFilterSchema>;

export interface ReportScope {
  regions: string[] | null; // null = bank-wide
}

/** Reporting access: Super Admin (bank-wide) or Reporting Admin (bank-wide, or region-scoped when the assignment has a region). */
export async function reportScope(q: Db, staffId: string): Promise<ReportScope | null> {
  const roles = await activeRoles(q, staffId);
  if (roles.some((r) => r.role === "SUPER_ADMIN")) return { regions: null };
  const rep = roles.filter((r) => r.role === "REPORTING_ADMIN");
  if (!rep.length) return null;
  if (rep.some((r) => !r.region)) return { regions: null };
  return { regions: rep.map((r) => r.region!) };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BASIS_COL = { created: "a.created_at", submitted: "a.submitted_at", disbursed: "a.disbursed_at", closed: "a.closed_at" } as const;

function buildWhere(f: ReportFilters, scope: ReportScope) {
  const where: string[] = ["a.status <> 'DRAFT'"];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const col = BASIS_COL[f.dateBasis ?? "created"];
  if (f.dateFrom && DATE_RE.test(f.dateFrom)) where.push(`${col} >= ${p(lagosStart(f.dateFrom))}`);
  if (f.dateTo && DATE_RE.test(f.dateTo)) where.push(`${col} < ${p(lagosStart(addDaysToDateString(f.dateTo, 1)))}`);
  if (f.initiatorId) where.push(`a.initiator_id = ${p(f.initiatorId)}`);
  if (f.daoCode) where.push(`v.data->>'daoCode' = ${p(f.daoCode)}`);
  if (f.region) where.push(`a.region = ${p(f.region)}`);
  if (f.role) where.push(`a.initiator_role = ${p(f.role)}`);
  if (f.assigneeId) where.push(`ot.assignee_id = ${p(f.assigneeId)}`);
  if (f.applicantType) where.push(`a.applicant_type = ${p(f.applicantType)}`);
  if (f.route) where.push(`a.route = ${p(Number(f.route))}`);
  if (f.stage) where.push(`a.stage = ${p(f.stage)}`);
  if (f.status) where.push(`a.status = ${p(f.status)}`);
  const min = f.amountMin ? parseNairaToKobo(f.amountMin) : null;
  const max = f.amountMax ? parseNairaToKobo(f.amountMax) : null;
  if (min !== null) where.push(`a.requested_amount_kobo >= ${p(min)}`);
  if (max !== null) where.push(`a.requested_amount_kobo <= ${p(max)}`);
  if (f.bookingFrom && DATE_RE.test(f.bookingFrom)) where.push(`d.disbursed_on >= ${p(f.bookingFrom)}`);
  if (f.bookingTo && DATE_RE.test(f.bookingTo)) where.push(`d.disbursed_on <= ${p(f.bookingTo)}`);
  if ((f.repaymentFrom && DATE_RE.test(f.repaymentFrom)) || (f.repaymentTo && DATE_RE.test(f.repaymentTo))) {
    const conds = ["ri.application_id = a.id"];
    if (f.repaymentFrom && DATE_RE.test(f.repaymentFrom)) conds.push(`ri.due_date >= ${p(f.repaymentFrom)}`);
    if (f.repaymentTo && DATE_RE.test(f.repaymentTo)) conds.push(`ri.due_date <= ${p(f.repaymentTo)}`);
    where.push(`EXISTS (SELECT 1 FROM repayment_instalments ri WHERE ${conds.join(" AND ")})`);
  }
  if (scope.regions) where.push(`a.region = ANY(${p(expandRegions(scope.regions))}::text[])`);
  return { where: where.join(" AND "), params };
}

function lagosStart(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return fromLagos(y, m, d);
}

const FROM = `FROM applications a
  LEFT JOIN application_versions v ON v.id = a.current_version_id
  LEFT JOIN disbursements d ON d.application_id = a.id
  LEFT JOIN tasks ot ON ot.application_id = a.id AND ot.status = 'OPEN'
  LEFT JOIN staff ini ON ini.id = a.initiator_id
  LEFT JOIN staff asg ON asg.id = ot.assignee_id`;

export interface ReportRow {
  id: string;
  ref: string;
  customer_name: string;
  applicant_type: string;
  initiator_name: string;
  initiator_role: string;
  region: string | null;
  dao_code: string | null;
  route: number | null;
  stage: Stage;
  status: string;
  requested_amount_kobo: string;
  approved_amount_kobo: string | null;
  disbursed_kobo: string | null;
  transaction_ref: string | null;
  disbursed_on: string | null;
  next_due: string | null;
  assignee_name: string | null;
  created_at: Date;
  submitted_at: Date | null;
  closed_at: Date | null;
  bvn_last4: string | null;
  vendor_confirmed_at: Date | null;
}

export async function runReport(q: Db, filters: ReportFilters, scope: ReportScope, now: Date) {
  const { where, params } = buildWhere(filters, scope);
  const rows = (
    await q.query<ReportRow>(
      `SELECT a.id, a.ref, a.customer_name, a.applicant_type, ini.full_name AS initiator_name, a.initiator_role, a.region, v.data->>'daoCode' AS dao_code,
              a.route, a.stage, a.status, a.requested_amount_kobo, d.approved_amount_kobo, d.amount_kobo AS disbursed_kobo, d.transaction_ref,
              to_char(d.disbursed_on, 'YYYY-MM-DD') AS disbursed_on,
              (SELECT to_char(min(ri.due_date), 'YYYY-MM-DD') FROM repayment_instalments ri WHERE ri.application_id = a.id AND ri.due_date >= $${params.length + 1}) AS next_due,
              asg.full_name AS assignee_name, a.created_at, a.submitted_at, a.closed_at, v.bvn_last4, a.vendor_confirmed_at
       ${FROM} WHERE ${where} ORDER BY a.created_at DESC LIMIT 5000`,
      [...params, lagosDate(now)],
    )
  ).rows;
  const ids = rows.map((r) => r.id);
  const today = lagosDate(now);
  const in30 = addDaysToDateString(today, 30);
  const agg = (
    await q.query<{
      approvals: string; rejections: string; corrections: string; open_tasks: string; upcoming_count: string; upcoming_sum: string | null;
    }>(
      `SELECT
         (SELECT count(*) FROM decisions WHERE application_id = ANY($1::uuid[]) AND action IN ('APPROVE','PROCEED','ENDORSE') AND invalidated_at IS NULL) AS approvals,
         (SELECT count(*) FROM applications WHERE id = ANY($1::uuid[]) AND status = 'REJECTED') AS rejections,
         (SELECT count(*) FROM corrections WHERE application_id = ANY($1::uuid[])) AS corrections,
         (SELECT count(*) FROM tasks WHERE application_id = ANY($1::uuid[]) AND status = 'OPEN') AS open_tasks,
         (SELECT count(*) FROM repayment_instalments WHERE application_id = ANY($1::uuid[]) AND due_date BETWEEN $2 AND $3) AS upcoming_count,
         (SELECT sum(amount_kobo) FROM repayment_instalments WHERE application_id = ANY($1::uuid[]) AND due_date BETWEEN $2 AND $3) AS upcoming_sum`,
      [ids, today, in30],
    )
  ).rows[0];
  const queues = (
    await q.query<{ stage: Stage; n: string }>(`SELECT stage, count(*) AS n FROM tasks WHERE application_id = ANY($1::uuid[]) AND status = 'OPEN' GROUP BY stage ORDER BY stage`, [ids])
  ).rows;
  const turnaround = (
    await q.query<{ stage: Stage; n: string; avg_hours: string }>(
      `SELECT stage, count(*) AS n, round(avg(extract(epoch FROM (completed_at - entered_at)) / 3600)::numeric, 1) AS avg_hours
         FROM tasks WHERE application_id = ANY($1::uuid[]) AND status = 'COMPLETED' GROUP BY stage ORDER BY stage`,
      [ids],
    )
  ).rows;
  const totals = {
    requests: rows.length,
    approvals: Number(agg.approvals),
    rejections: Number(agg.rejections),
    corrections: Number(agg.corrections),
    disbursedCount: rows.filter((r) => r.disbursed_kobo).length,
    disbursedKobo: rows.reduce((s, r) => s + Number(r.disbursed_kobo ?? 0), 0),
    requestedKobo: rows.reduce((s, r) => s + Number(r.requested_amount_kobo ?? 0), 0),
    outstandingTasks: Number(agg.open_tasks),
    upcomingRepaymentsCount: Number(agg.upcoming_count),
    upcomingRepaymentsKobo: Number(agg.upcoming_sum ?? 0),
  };
  return { rows, totals, queues, turnaround };
}

export const EXPORT_COLUMNS: { header: string; value: (r: ReportRow) => string | number }[] = [
  { header: "Request ID", value: (r) => r.ref },
  { header: "Customer", value: (r) => r.customer_name ?? "" },
  { header: "Applicant type", value: (r) => r.applicant_type },
  { header: "BVN (masked)", value: (r) => (r.bvn_last4 ? maskWithLast4(r.bvn_last4) : "") },
  { header: "Initiator", value: (r) => r.initiator_name },
  { header: "Initiator role", value: (r) => r.initiator_role },
  { header: "State", value: (r) => r.region ?? "" },
  { header: "DAO code", value: (r) => r.dao_code ?? "" },
  { header: "Route", value: (r) => r.route ?? "" },
  { header: "Stage", value: (r) => STAGE_LABELS[r.stage] ?? r.stage },
  { header: "Status", value: (r) => r.status },
  { header: "Current assignee", value: (r) => r.assignee_name ?? "" },
  { header: "Requested (NGN)", value: (r) => (r.requested_amount_kobo ? koboToNairaString(Number(r.requested_amount_kobo)) : "") },
  { header: "Approved (NGN)", value: (r) => (r.approved_amount_kobo ? koboToNairaString(Number(r.approved_amount_kobo)) : "") },
  { header: "Disbursed (NGN)", value: (r) => (r.disbursed_kobo ? koboToNairaString(Number(r.disbursed_kobo)) : "") },
  { header: "Transaction ref", value: (r) => r.transaction_ref ?? "" },
  { header: "Booking date", value: (r) => r.disbursed_on ?? "" },
  { header: "Next repayment due", value: (r) => r.next_due ?? "" },
  { header: "Vendor confirmed", value: (r) => (r.vendor_confirmed_at ? "Yes" : r.disbursed_kobo ? "Pending" : "") },
  { header: "Created (UTC)", value: (r) => new Date(r.created_at).toISOString() },
  { header: "Submitted (UTC)", value: (r) => (r.submitted_at ? new Date(r.submitted_at).toISOString() : "") },
  { header: "Closed (UTC)", value: (r) => (r.closed_at ? new Date(r.closed_at).toISOString() : "") },
];

function csvCell(v: string | number) {
  let s = String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: ReportRow[]): string {
  const lines = [EXPORT_COLUMNS.map((c) => csvCell(c.header)).join(",")];
  for (const r of rows) lines.push(EXPORT_COLUMNS.map((c) => csvCell(c.value(r))).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export async function toXlsx(rows: ReportRow[], totals: Record<string, number>, filters: ReportFilters): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AltBank Retail Asset Factory";
  const ws = wb.addWorksheet("Requests");
  ws.addRow(EXPORT_COLUMNS.map((c) => c.header)).font = { bold: true };
  for (const r of rows) ws.addRow(EXPORT_COLUMNS.map((c) => c.value(r)));
  ws.columns.forEach((c) => (c.width = 18));
  const t = wb.addWorksheet("Totals");
  t.addRow(["Metric", "Value"]).font = { bold: true };
  for (const [k, v] of Object.entries(totals)) t.addRow([k, k.endsWith("Kobo") ? formatKobo(v) : v]);
  t.addRow([]);
  t.addRow(["Filters", JSON.stringify(filters)]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Export with the same filters and permissions as the screen; every export is audited. */
export async function exportReport(ctx: Ctx, rawFilters: Record<string, string>, format: "csv" | "xlsx") {
  if (!ctx.actor) throw forbidden();
  const scope = await reportScope(db, ctx.actor.staffId);
  if (!scope) {
    await auditOutsideTx(ctx, { action: "REPORT_EXPORT", outcome: "DENIED", details: { format } });
    throw forbidden("Reporting access is required.");
  }
  const filters = reportFilterSchema.parse(rawFilters);
  const res = await runReport(db, filters, scope, ctx.now);
  const body = format === "csv" ? Buffer.from(toCsv(res.rows), "utf8") : await toXlsx(res.rows, res.totals, filters);
  await auditOutsideTx(ctx, { action: "REPORT_EXPORT", details: { format, filters, scope, rowCount: res.rows.length } });
  return { body, rowCount: res.rows.length };
}
