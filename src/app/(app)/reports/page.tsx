import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { reportFilterSchema, reportScope, runReport } from "@/server/reports";
import { STAGES, STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { INITIATOR_ROLES, ROLE_LABELS, REGIONS } from "@/server/domain/roles";
import { APPLICANT_TYPES, APPLICANT_TYPE_LABELS } from "@/server/domain/application-data";
import { formatKobo } from "@/server/money";
import { formatDateOnly } from "@/server/time";
import { maskWithLast4 } from "@/server/mask";
import { auditOutsideTx } from "@/server/audit";

export const metadata = { title: "Reports" };

export default async function Reports({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session, ctx } = await requireUser();
  const scope = await reportScope(db, session.staffId);
  if (!scope) redirect("/forbidden");
  const sp = await searchParams;
  const parsed = reportFilterSchema.safeParse(sp);
  const filters = parsed.success ? parsed.data : reportFilterSchema.parse({});
  const res = await runReport(db, filters, scope, new Date());
  await auditOutsideTx(ctx, { action: "REPORT_VIEW", details: { filters, rows: res.rows.length } });
  const staff = (await db.query("SELECT id, full_name FROM staff WHERE status = 'ACTIVE' ORDER BY full_name")).rows;
  const qs = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]).toString();
  const sel = (name: string, label: string, options: [string, string][]) => (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <select id={name} name={name} defaultValue={sp[name] ?? ""}>
        <option value="">Any</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
  const date = (name: string, label: string) => (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} type="date" defaultValue={sp[name] ?? ""} />
    </div>
  );
  const t = res.totals;
  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Reporting</p>
          <h1>Reports</h1>
          <p>{scope.regions ? `Scoped to state: ${scope.regions.join(", ")}.` : "Bank-wide."} Exports use exactly these filters and are logged.</p>
        </div>
        <div className="row">
          <a className="btn" href={`/api/reports/export?${qs}${qs ? "&" : ""}format=csv`}>
            Export CSV
          </a>
          <a className="btn btn-primary" href={`/api/reports/export?${qs}${qs ? "&" : ""}format=xlsx`}>
            Export XLSX
          </a>
        </div>
      </div>
      <form className="card" method="get" style={{ marginBottom: 16 }} aria-label="Report filters">
        <div className="grid-3">
          {date("dateFrom", "Date from")}
          {date("dateTo", "Date to")}
          {sel("dateBasis", "Date basis", [["created", "Created"], ["submitted", "Submitted"], ["disbursed", "Disbursed"], ["closed", "Closed"]])}
          {sel("initiatorId", "Initiator", staff.map((s) => [s.id, s.full_name]))}
          <div className="field">
            <label htmlFor="daoCode">DAO code</label>
            <input id="daoCode" name="daoCode" defaultValue={sp.daoCode ?? ""} />
          </div>
          {sel("region", "State", REGIONS.map((r) => [r, r]))}
          {sel("role", "Initiator role", INITIATOR_ROLES.map((r) => [r, ROLE_LABELS[r]]))}
          {sel("assigneeId", "Current assignee", staff.map((s) => [s.id, s.full_name]))}
          {sel("applicantType", "Applicant type", APPLICANT_TYPES.map((a) => [a, APPLICANT_TYPE_LABELS[a]]))}
          {sel("route", "Route", [["1", "Route 1"], ["2", "Route 2"], ["3", "Route 3"]])}
          {sel("stage", "Stage", STAGES.filter((s) => s !== "DRAFT").map((s) => [s, STAGE_LABELS[s]]))}
          {sel("status", "Status", [["IN_PROGRESS", "In progress"], ["BOOKED", "Booked"], ["CLOSED", "Closed"], ["REJECTED", "Rejected"]])}
          <div className="field">
            <label htmlFor="amountMin">Amount from (₦)</label>
            <input id="amountMin" name="amountMin" defaultValue={sp.amountMin ?? ""} inputMode="decimal" />
          </div>
          <div className="field">
            <label htmlFor="amountMax">Amount to (₦)</label>
            <input id="amountMax" name="amountMax" defaultValue={sp.amountMax ?? ""} inputMode="decimal" />
          </div>
          {date("bookingFrom", "Booking date from")}
          {date("bookingTo", "Booking date to")}
          {date("repaymentFrom", "Repayment due from")}
          {date("repaymentTo", "Repayment due to")}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary">Apply filters</button>
          <Link className="btn btn-ghost" href="/reports">
            Reset
          </Link>
        </div>
      </form>
      <div className="metric-grid" style={{ marginBottom: 16 }}>
        <div className="metric"><div className="k">Requests</div><div className="v">{t.requests}</div></div>
        <div className="metric"><div className="k">Approvals (valid)</div><div className="v">{t.approvals}</div></div>
        <div className="metric"><div className="k">Rejections</div><div className="v">{t.rejections}</div></div>
        <div className="metric"><div className="k">Corrections</div><div className="v">{t.corrections}</div></div>
        <div className="metric"><div className="k">Disbursed ({t.disbursedCount})</div><div className="v">{formatKobo(t.disbursedKobo)}</div></div>
        <div className="metric"><div className="k">Outstanding queue items</div><div className="v">{t.outstandingTasks}</div></div>
        <div className="metric"><div className="k">Repayments due in 30 days ({t.upcomingRepaymentsCount})</div><div className="v">{formatKobo(t.upcomingRepaymentsKobo)}</div></div>
      </div>
      <div className="grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <h2>Outstanding queues by stage</h2>
          {res.queues.length === 0 ? <p className="muted">None.</p> : (
            <table className="kv"><tbody>{res.queues.map((q) => <tr key={q.stage}><th>{STAGE_LABELS[q.stage as Stage]}</th><td>{q.n}</td></tr>)}</tbody></table>
          )}
        </div>
        <div className="card">
          <h2>Turnaround time by stage</h2>
          {res.turnaround.length === 0 ? <p className="muted">No completed stages.</p> : (
            <table className="kv"><tbody>{res.turnaround.map((q) => <tr key={q.stage}><th>{STAGE_LABELS[q.stage as Stage]}</th><td>{q.avg_hours} h average ({q.n})</td></tr>)}</tbody></table>
          )}
        </div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <caption className="sr-only">Report preview</caption>
          <thead>
            <tr>
              <th>Request ID</th><th>Customer</th><th>BVN</th><th>Type</th><th>Initiator</th><th>State</th><th>DAO</th><th>Route</th><th>Stage</th><th>Assignee</th>
              <th className="right">Requested</th><th className="right">Disbursed</th><th>Booking</th><th>Next due</th>
            </tr>
          </thead>
          <tbody>
            {res.rows.length === 0 && <tr><td colSpan={14} className="empty">No requests match.</td></tr>}
            {res.rows.slice(0, 200).map((r) => (
              <tr key={r.id}>
                <td className="mono nowrap">{r.ref}</td>
                <td>{r.customer_name}</td>
                <td className="mono small">{r.bvn_last4 ? maskWithLast4(r.bvn_last4) : "—"}</td>
                <td className="small">{APPLICANT_TYPE_LABELS[r.applicant_type as keyof typeof APPLICANT_TYPE_LABELS]}</td>
                <td className="small">{r.initiator_name}<div className="muted">{ROLE_LABELS[r.initiator_role as keyof typeof ROLE_LABELS]}</div></td>
                <td className="small">{r.region ?? "—"}</td>
                <td className="small mono">{r.dao_code ?? "—"}</td>
                <td>{r.route ?? "—"}</td>
                <td className="small">{STAGE_LABELS[r.stage]}</td>
                <td className="small">{r.assignee_name ?? "—"}</td>
                <td className="num">{formatKobo(r.requested_amount_kobo)}</td>
                <td className="num">{r.disbursed_kobo ? formatKobo(r.disbursed_kobo) : "—"}</td>
                <td className="small nowrap">{r.disbursed_on ? formatDateOnly(r.disbursed_on) : "—"}</td>
                <td className="small nowrap">{r.next_due ? formatDateOnly(r.next_due) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {res.rows.length > 200 && <p className="small muted">Preview shows the first 200 of {res.rows.length} rows. Export for the full set.</p>}
    </>
  );
}
