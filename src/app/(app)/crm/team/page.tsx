import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { crmPrincipal, OPEN_STATUSES } from "@/server/crm/core";
import { listTickets } from "@/server/crm/tickets";
import { officerPerformance, teamPerformance } from "@/server/crm/analytics";
import { addDaysToDateString, lagosDate } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { Metric, OfficerTable, Tabs, TicketTable, dur, pct } from "../ui";

export const metadata = { title: "Team Queue" };

export default async function TeamQueue({ searchParams }: { searchParams: Promise<{ view?: string; team?: string }> }) {
  const { session } = await requireUser();
  const p = await crmPrincipal(db, session.staffId);
  if (!p.leadTeams.length) redirect("/crm");
  const sp = await searchParams;
  const teams = (await db.query<{ id: string; name: string }>("SELECT id, name FROM crm_teams WHERE id = ANY($1::uuid[]) ORDER BY name", [p.leadTeams])).rows;
  const teamIds = sp.team && p.leadTeams.includes(sp.team) ? [sp.team] : p.leadTeams;
  const view = ["unassigned", "queue", "assignments", "performance"].includes(sp.view ?? "") ? sp.view! : "unassigned";
  const all = await listTickets(db, { kind: "TEAMS", teamIds }, { status: "OPEN" });
  const unassigned = all.filter((t) => t.status === "UNASSIGNED");
  const extra = sp.team ? `&team=${sp.team}` : "";
  const now = new Date();
  const period = { from: addDaysToDateString(lagosDate(now), -29), to: lagosDate(now) };
  return (
    <>
      <PageHeader eyebrow="CRM" title="Team Queue" intro="Assign new complaints to your officers, watch ageing and SLA targets, and move misrouted tickets to the right team." />
      {teams.length > 1 && (
        <form className="row" style={{ marginBottom: "var(--space-3)" }}>
          <input type="hidden" name="view" value={view} />
          <label htmlFor="tq-team" className="small">
            Team
          </label>
          <select id="tq-team" name="team" defaultValue={sp.team ?? ""}>
            <option value="">All my teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button className="btn">Show</button>
        </form>
      )}
      <Tabs
        base="/crm/team"
        current={view}
        extra={extra}
        tabs={[
          ["unassigned", "Unassigned", unassigned.length],
          ["queue", "Team queue", all.length],
          ["assignments", "Assignment management"],
          ["performance", "Team performance"],
        ]}
      />
      {view === "unassigned" && <TicketTable rows={unassigned} show={["creator", "team", "owner", "sla"]} empty="No tickets waiting for assignment." />}
      {view === "queue" && <TicketTable rows={all} show={["team", "assignee", "owner", "sla"]} empty="No open tickets." />}
      {view === "assignments" && <Workload teamIds={teamIds} />}
      {view === "performance" && <TeamPerf teamIds={teamIds} period={period} now={now} />}
      <p className="small muted" style={{ marginTop: 12 }}>
        Open a ticket to assign it. <Link href="/crm/kb">Resolution guidance</Link>
      </p>
    </>
  );
}

async function Workload({ teamIds }: { teamIds: string[] }) {
  const rows = (
    await db.query<{ team: string; name: string; role: string; open: string; in_progress: string; pending: string }>(
      `SELECT tm.name AS team, s.full_name AS name, m.member_role AS role,
              count(t.id) FILTER (WHERE t.status = ANY($2)) AS open,
              count(t.id) FILTER (WHERE t.status = 'IN_PROGRESS') AS in_progress,
              count(t.id) FILTER (WHERE t.status = 'PENDING_INFO') AS pending
         FROM crm_team_members m JOIN crm_teams tm ON tm.id = m.team_id JOIN staff s ON s.id = m.staff_id
         LEFT JOIN crm_tickets t ON t.assignee_id = m.staff_id AND t.team_id = m.team_id
        WHERE m.team_id = ANY($1::uuid[]) AND m.active GROUP BY tm.name, s.full_name, m.member_role ORDER BY tm.name, m.member_role DESC, s.full_name`,
      [teamIds, OPEN_STATUSES],
    )
  ).rows;
  return (
    <div className="table-wrap">
      <table className="data responsive">
        <caption className="sr-only">Officer workload</caption>
        <thead>
          <tr>
            <th scope="col">Team</th>
            <th scope="col">Member</th>
            <th scope="col">Open tickets</th>
            <th scope="col">In progress</th>
            <th scope="col">Pending information</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.team}-${r.name}`}>
              <td data-label="Team">{r.team}</td>
              <td data-label="Member">
                {r.name} {r.role === "LEAD" && <span className="badge">Team Lead</span>}
              </td>
              <td data-label="Open tickets">{r.open}</td>
              <td data-label="In progress">{r.in_progress}</td>
              <td data-label="Pending information">{r.pending}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function TeamPerf({ teamIds, period, now }: { teamIds: string[]; period: { from: string; to: string }; now: Date }) {
  const teams = (await teamPerformance(db, period, now)).filter((t) => teamIds.includes(t.team_id));
  const officers = await officerPerformance(db, period, now, teamIds);
  return (
    <div className="stack">
      <p className="small muted">Last 30 days ({period.from} to {period.to}). Handling time is the time each ticket spent with the team or officer.</p>
      {teams.map((t) => (
        <div key={t.team_id} className="metric-grid">
          <Metric k={t.team_name} v={`${t.received} received`} note={`${t.resolved} resolved · ${t.transferred_out} transferred out`} />
          <Metric k="Pending now" v={t.pending_now} note={`Backlog: ${t.backlog.under_1d} <1d · ${t.backlog.d1_3} 1–3d · ${t.backlog.d3_7} 3–7d · ${t.backlog.over_7d} >7d`} />
          <Metric k="Average handling" v={dur(t.avg_handling_ms)} note={`median ${dur(t.median_handling_ms)} · max ${dur(t.max_handling_ms)}`} />
          <Metric k="SLA compliance" v={pct(t.sla_compliance_pct)} note={`${t.sla_met} met · ${t.sla_breached} breached`} />
        </div>
      ))}
      <OfficerTable rows={officers} />
    </div>
  );
}
