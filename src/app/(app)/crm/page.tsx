import Link from "next/link";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { crmNavCounts, crmPrincipal, isOversight, OPEN_STATUSES } from "@/server/crm/core";
import { listTickets } from "@/server/crm/tickets";
import { PageHeader } from "@/components/PageHeader";
import { Metric, TicketTable } from "./ui";

export const metadata = { title: "CRM" };

export default async function CrmHome() {
  const { session } = await requireUser();
  const p = await crmPrincipal(db, session.staffId);
  const counts = await crmNavCounts(db, p);
  const mine = await listTickets(db, { kind: "CREATOR", staffId: session.staffId }, {}, new Date(), 8);
  const myOpen = mine.filter((t) => OPEN_STATUSES.includes(t.status)).length;
  const awaitingMe = mine.filter((t) => t.status === "RESOLVED" || t.status === "PENDING_INFO").length;
  return (
    <>
      <PageHeader
        eyebrow="CRM"
        title="Complaints and resolution"
        intro="Report a problem with ARAF, a financing request or a process. Every complaint gets a reference, a responsible team and a clear trail until it is resolved."
        actions={
          <Link className="btn btn-primary" href="/crm/new">
            Raise a complaint
          </Link>
        }
      />
      <div className="metric-grid" style={{ marginBottom: "var(--space-5)" }}>
        <Metric k="My open complaints" v={myOpen} />
        <Metric k="Waiting for my reply" v={awaitingMe} note="Information requested or resolution to confirm" />
        {p.officerTeams.length > 0 && <Metric k="Assigned to me" v={<Link href="/crm/work">{counts.assigned}</Link>} />}
        {p.leadTeams.length > 0 && <Metric k="Unassigned in my teams" v={<Link href="/crm/team?view=unassigned">{counts.unassigned}</Link>} />}
        {isOversight(p) && <Metric k="Escalated (all teams)" v={<Link href="/crm/escalations">{counts.escalated}</Link>} />}
      </div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ fontSize: 17 }}>My recent complaints</h2>
        <Link href="/crm/tickets" className="small">
          All my tickets →
        </Link>
      </div>
      <TicketTable rows={mine} show={["team", "updated"]} empty="You have not raised any complaints." />
    </>
  );
}
