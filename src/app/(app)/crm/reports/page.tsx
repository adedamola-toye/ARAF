import Link from "next/link";
import { db } from "@/server/db";
import { buildCxReport, lastPeriod } from "@/server/crm/reports";
import { addDaysToDateString, formatLagos, lagosDate } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { requireOversight } from "../guard";
import { Breakdown, Metric, OfficerTable, PeriodForm, dur, pct, periodFrom } from "../ui";

export const metadata = { title: "CX Reports" };

export default async function Reports({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; preset?: string }> }) {
  await requireOversight();
  const sp = await searchParams;
  const now = new Date();
  const preset = sp.preset === "DAILY" || sp.preset === "WEEKLY" || sp.preset === "MONTHLY" ? sp.preset : null;
  const period = preset ? lastPeriod(preset, now) : periodFrom(sp, lagosDate(now), addDaysToDateString);
  const r = await buildCxReport(db, preset ?? "ON_DEMAND", now, { from: period.from, to: period.to });
  const runs = (await db.query<{ frequency: string; period_key: string; run_at: Date; recipients: number }>("SELECT * FROM crm_report_runs ORDER BY run_at DESC LIMIT 10")).rows;
  const q = `from=${period.from}&to=${period.to}&title=${preset ?? "ON_DEMAND"}`;
  const a = r.analytics;
  return (
    <>
      <PageHeader
        eyebrow="CRM"
        title={r.title}
        intro={`${period.from} to ${period.to}. Generated ${formatLagos(now)} from CRM records.`}
        actions={
          <>
            <a className="btn" href={`/api/crm/report?format=csv&${q}`}>
              Download CSV
            </a>
            <a className="btn" href={`/api/crm/report?format=pdf&${q}`}>
              Download PDF
            </a>
          </>
        }
      />
      <nav className="tabs" aria-label="Report period">
        {(["DAILY", "WEEKLY", "MONTHLY"] as const).map((f) => (
          <Link key={f} className="tab" href={`/crm/reports?preset=${f}`} aria-current={preset === f ? "page" : undefined}>
            {f === "DAILY" ? "Yesterday" : f === "WEEKLY" ? "Last week" : "Last month"}
          </Link>
        ))}
        <Link className="tab" href="/crm/reports" aria-current={!preset ? "page" : undefined}>
          Custom range
        </Link>
      </nav>
      {!preset && <PeriodForm from={period.from} to={period.to} />}
      <div className="metric-grid" style={{ marginBottom: "var(--space-4)" }}>
        <Metric k="Received" v={a.totals.received} />
        <Metric k="Resolved" v={a.totals.resolved} />
        <Metric k="Unresolved now" v={a.now.open} note={`${a.now.overdue} overdue`} />
        <Metric k="SLA compliance" v={pct(a.performance.sla_compliance_pct)} note={`${a.performance.sla_breached} breach(es)`} />
        <Metric k="Avg resolution" v={dur(a.performance.avg_resolution_ms)} />
        <Metric k="Reassignment rate" v={pct(a.performance.reassignment_rate_pct)} />
      </div>
      {r.opportunities.length > 0 && (
        <div className="card" style={{ marginBottom: "var(--space-4)" }}>
          <h2 style={{ fontSize: 15 }}>Operational improvement opportunities</h2>
          <ul style={{ margin: 0 }}>
            {r.opportunities.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Derived only from the figures in this report.
          </p>
        </div>
      )}
      <h2 style={{ fontSize: 15 }}>Team performance</h2>
      <div className="table-wrap" style={{ marginBottom: "var(--space-4)" }}>
        <table className="data responsive">
          <caption className="sr-only">Teams</caption>
          <thead>
            <tr>
              <th scope="col">Team</th>
              <th scope="col">Received</th>
              <th scope="col">Resolved</th>
              <th scope="col">Transferred out</th>
              <th scope="col">Pending</th>
              <th scope="col">Avg handling</th>
              <th scope="col">SLA compliance</th>
            </tr>
          </thead>
          <tbody>
            {r.teams.map((t) => (
              <tr key={t.team_id}>
                <td data-label="Team">{t.team_name}</td>
                <td data-label="Received">{t.received}</td>
                <td data-label="Resolved">{t.resolved}</td>
                <td data-label="Transferred out">{t.transferred_out}</td>
                <td data-label="Pending">{t.pending_now}</td>
                <td data-label="Avg handling">{dur(t.avg_handling_ms)}</td>
                <td data-label="SLA compliance">{pct(t.sla_compliance_pct)}</td>
              </tr>
            ))}
            {!r.teams.length && (
              <tr>
                <td colSpan={7} className="muted">
                  No team activity in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <h2 style={{ fontSize: 15 }}>Officers</h2>
      <OfficerTable rows={r.officers} />
      <div className="grid-2" style={{ margin: "var(--space-4) 0" }}>
        <Breakdown title="Product-level complaints" rows={a.byProduct} total={a.totals.received} />
        <Breakdown title="Resolution trend (complaints by day)" rows={a.byDay} />
        <Breakdown title="Repeat complaints" rows={r.repeat} />
        <Breakdown title="Top issues" rows={a.topIssues} />
      </div>
      <h2 style={{ fontSize: 15 }}>Scheduled report history</h2>
      {runs.length ? (
        <ul className="small">
          {runs.map((x) => (
            <li key={`${x.frequency}-${x.period_key}`}>
              {x.frequency.toLowerCase()} report for the period starting {x.period_key}: queued {formatLagos(x.run_at)} for {x.recipients} recipient(s)
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">No scheduled report has been queued yet. The Super Admin turns schedules on in CRM configuration → Reports.</p>
      )}
    </>
  );
}
