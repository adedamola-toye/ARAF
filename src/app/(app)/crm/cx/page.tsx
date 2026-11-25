import Link from "next/link";
import { db } from "@/server/db";
import { crmAnalytics, teamPerformance } from "@/server/crm/analytics";
import { PRIORITY_LABELS, STATUS_LABELS, type Priority, type TicketStatus } from "@/server/crm/core";
import { addDaysToDateString, lagosDate } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { requireOversight } from "../guard";
import { Breakdown, Metric, PeriodForm, dur, pct, periodFrom } from "../ui";

export const metadata = { title: "CX Command Centre" };

export default async function CommandCentre({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  await requireOversight();
  const now = new Date();
  const period = periodFrom(await searchParams, lagosDate(now), addDaysToDateString);
  const a = await crmAnalytics(db, period, now);
  const teams = await teamPerformance(db, period, now);
  const q = `from=${period.from}&to=${period.to}`;
  const P = a.performance;
  return (
    <>
      <PageHeader eyebrow="CRM" title="CX Command Centre" intro="Complaint volumes, SLA compliance and how long each team takes, from live CRM records." actions={<Link className="btn" href={`/crm/reports?${q}`}>Reports and exports</Link>} />
      <PeriodForm from={period.from} to={period.to} />
      <h2 style={{ fontSize: 15 }}>Right now</h2>
      <div className="metric-grid" style={{ marginBottom: "var(--space-4)" }}>
        <Metric k="Open" v={<Link href="/crm/all?status=OPEN">{a.now.open}</Link>} />
        <Metric k="New, never assigned" v={a.now.new_unassigned} />
        <Metric k="Unassigned" v={<Link href="/crm/all?status=UNASSIGNED">{a.now.unassigned}</Link>} />
        <Metric k="In progress" v={a.now.in_progress} />
        <Metric k="Pending information" v={a.now.pending_info} />
        <Metric k="Escalated" v={<Link href="/crm/escalations">{a.now.escalated}</Link>} />
        <Metric k="Overdue" v={<Link href="/crm/sla">{a.now.overdue}</Link>} />
      </div>
      <h2 style={{ fontSize: 15 }}>
        {period.from} to {period.to}
      </h2>
      <div className="metric-grid" style={{ marginBottom: "var(--space-3)" }}>
        <Metric k="Received" v={a.totals.received} />
        <Metric k="Resolved" v={a.totals.resolved} />
        <Metric k="Closed" v={a.totals.closed} />
        <Metric k="Reopened" v={a.totals.reopened} note={`Reopening rate ${pct(P.reopen_rate_pct)}`} />
        <Metric k="Escalated" v={a.totals.escalated} />
        <Metric k="SLA compliance" v={pct(P.sla_compliance_pct)} note={`${P.sla_met} met · ${P.sla_breached} breached (${pct(P.sla_breach_pct)})`} />
      </div>
      <div className="metric-grid" style={{ marginBottom: "var(--space-5)" }}>
        <Metric k="Avg resolution (elapsed)" v={dur(P.avg_resolution_ms)} note={`Median ${dur(P.median_resolution_ms)}`} />
        <Metric k="Avg SLA-adjusted resolution" v={dur(P.avg_sla_resolution_ms)} note="Business time, less paused time" />
        <Metric k="Avg first response" v={dur(P.first_response_avg_ms)} />
        <Metric k="Avg team handling" v={dur(P.avg_team_handling_ms)} note={`Officer ${dur(P.avg_officer_handling_ms)}`} />
        <Metric k="Reassignment rate" v={pct(P.reassignment_rate_pct)} />
        <Metric k="Satisfaction" v={P.satisfaction_avg !== null ? `${P.satisfaction_avg}/5` : "—"} note={`${P.satisfaction_count} rating(s)`} />
      </div>
      <h2 style={{ fontSize: 15 }}>Teams</h2>
      <div className="table-wrap" style={{ marginBottom: "var(--space-5)" }}>
        <table className="data responsive">
          <caption className="sr-only">Team performance</caption>
          <thead>
            <tr>
              <th scope="col">Team</th>
              <th scope="col">Received</th>
              <th scope="col">Resolved</th>
              <th scope="col">Transferred out</th>
              <th scope="col">Pending now</th>
              <th scope="col">Avg handling</th>
              <th scope="col">SLA compliance</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.team_id}>
                <td data-label="Team">
                  <Link href={`/crm/all?teamId=${t.team_id}&status=OPEN`}>{t.team_name}</Link>
                </td>
                <td data-label="Received">{t.received}</td>
                <td data-label="Resolved">{t.resolved}</td>
                <td data-label="Transferred out">{t.transferred_out}</td>
                <td data-label="Pending now">{t.pending_now}</td>
                <td data-label="Avg handling">{dur(t.avg_handling_ms)}</td>
                <td data-label="SLA compliance">{pct(t.sla_compliance_pct)}</td>
              </tr>
            ))}
            {!teams.length && (
              <tr>
                <td colSpan={7} className="muted">
                  No complaints handled in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="grid-2" style={{ marginBottom: "var(--space-5)" }}>
        <Breakdown title="By product" rows={a.byProduct} total={a.totals.received} />
        <Breakdown title="By category" rows={a.byCategory} total={a.totals.received} />
        <Breakdown title="Top recurring issues" rows={a.topIssues} />
        <Breakdown title="By responsible team" rows={a.byTeam} total={a.totals.received} />
        <Breakdown title="By priority" rows={a.byPriority.map((r) => ({ ...r, label: PRIORITY_LABELS[r.label as Priority] ?? r.label }))} total={a.totals.received} />
        <Breakdown title="By officer" rows={a.byOfficer} />
        <Breakdown title="By complainant location" rows={a.byLocation} total={a.totals.received} />
        <Breakdown title="By day" rows={a.byDay} />
      </div>
      <h2 style={{ fontSize: 15 }}>Oldest unresolved complaints</h2>
      <div className="table-wrap">
        <table className="data responsive">
          <caption className="sr-only">Oldest unresolved complaints</caption>
          <thead>
            <tr>
              <th scope="col">Ticket</th>
              <th scope="col">Subject</th>
              <th scope="col">Team</th>
              <th scope="col">Officer</th>
              <th scope="col">Priority</th>
              <th scope="col">Status</th>
              <th scope="col">Age</th>
            </tr>
          </thead>
          <tbody>
            {a.oldestOpen.map((o) => (
              <tr key={o.id}>
                <td data-label="Ticket">
                  <Link href={`/crm/tickets/${o.id}`}>{o.ref}</Link>
                </td>
                <td data-label="Subject">{o.subject}</td>
                <td data-label="Team">{o.team_name}</td>
                <td data-label="Officer">{o.assignee_name ?? "—"}</td>
                <td data-label="Priority">{PRIORITY_LABELS[o.priority as Priority]}</td>
                <td data-label="Status">
                  {STATUS_LABELS[o.status as TicketStatus]} {o.overdue && <span className="badge badge-red">Overdue</span>}
                </td>
                <td data-label="Age">{dur(o.age_ms)}</td>
              </tr>
            ))}
            {!a.oldestOpen.length && (
              <tr>
                <td colSpan={7} className="muted">
                  No open complaints.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
