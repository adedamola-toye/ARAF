import { db } from "@/server/db";
import { officerPerformance, teamPerformance } from "@/server/crm/analytics";
import { addDaysToDateString, lagosDate } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { requireOversight } from "../guard";
import { OfficerTable, PeriodForm, dur, pct, periodFrom } from "../ui";

export const metadata = { title: "Team Performance" };

export default async function Performance({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  await requireOversight();
  const now = new Date();
  const period = periodFrom(await searchParams, lagosDate(now), addDaysToDateString);
  const teams = await teamPerformance(db, period, now);
  const officers = await officerPerformance(db, period, now);
  return (
    <>
      <PageHeader
        eyebrow="CRM"
        title="Team and officer performance"
        intro="Handling time is the time a ticket spent with each team or officer, from the hand-off history. A ticket that passed through three teams counts each team's own time. Resolved includes tickets finished by an officer and tickets closed directly by the CX Head or Super Admin. All active team members are listed, including those with no tickets yet."
      />
      <PeriodForm from={period.from} to={period.to} />
      <div className="table-wrap" style={{ marginBottom: "var(--space-5)" }}>
        <table className="data responsive">
          <caption className="sr-only">Team performance</caption>
          <thead>
            <tr>
              <th scope="col">Team</th>
              <th scope="col">Received</th>
              <th scope="col">Assigned</th>
              <th scope="col">Resolved</th>
              <th scope="col">Transferred out</th>
              <th scope="col">Pending now</th>
              <th scope="col">Avg handling</th>
              <th scope="col">Median</th>
              <th scope="col">Max</th>
              <th scope="col">Business-hours total</th>
              <th scope="col">SLA met / breached</th>
              <th scope="col">Compliance</th>
              <th scope="col">Backlog &lt;1d · 1–3d · 3–7d · &gt;7d</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.team_id}>
                <td data-label="Team">{t.team_name}</td>
                <td data-label="Received">{t.received}</td>
                <td data-label="Assigned">{t.assigned}</td>
                <td data-label="Resolved">{t.resolved}</td>
                <td data-label="Transferred out">{t.transferred_out}</td>
                <td data-label="Pending now">{t.pending_now}</td>
                <td data-label="Avg handling">{dur(t.avg_handling_ms)}</td>
                <td data-label="Median">{dur(t.median_handling_ms)}</td>
                <td data-label="Max">{dur(t.max_handling_ms)}</td>
                <td data-label="Business-hours total">{dur(t.handling_business_ms_total)}</td>
                <td data-label="SLA met / breached">
                  {t.sla_met} / {t.sla_breached}
                </td>
                <td data-label="Compliance">{pct(t.sla_compliance_pct)}</td>
                <td data-label="Backlog">
                  {t.backlog.under_1d} · {t.backlog.d1_3} · {t.backlog.d3_7} · {t.backlog.over_7d}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 style={{ fontSize: 16 }}>Officers</h2>
      <OfficerTable rows={officers} />
    </>
  );
}
