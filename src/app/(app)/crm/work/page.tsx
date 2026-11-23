import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { crmPrincipal } from "@/server/crm/core";
import { listTickets } from "@/server/crm/tickets";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TicketTable } from "../ui";

export const metadata = { title: "Assigned to Me" };

export default async function AssignedToMe({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { session } = await requireUser();
  const p = await crmPrincipal(db, session.staffId);
  if (!p.officerTeams.length) redirect("/crm");
  const sp = await searchParams;
  const all = await listTickets(db, { kind: "ASSIGNEE", staffId: session.staffId }, {});
  const groups: Record<string, typeof all> = {
    assigned: all.filter((t) => t.status === "ASSIGNED" || t.status === "REOPENED"),
    progress: all.filter((t) => t.status === "IN_PROGRESS"),
    pending: all.filter((t) => t.status === "PENDING_INFO"),
    resolved: all.filter((t) => t.status === "RESOLVED" || t.status === "CLOSED"),
  };
  const view = sp.view && sp.view in groups ? sp.view : "assigned";
  return (
    <>
      <PageHeader eyebrow="CRM" title="Assigned to Me" intro="Your tickets, most urgent first. Start work, update the complainant and resolve with a summary of what you did." />
      <Tabs
        base="/crm/work"
        current={view}
        tabs={[
          ["assigned", "New to me", groups.assigned.length],
          ["progress", "In Progress", groups.progress.length],
          ["pending", "Pending Information", groups.pending.length],
          ["resolved", "Resolved", groups.resolved.length],
        ]}
      />
      <TicketTable rows={groups[view]} show={view === "resolved" ? ["creator", "team", "updated"] : ["creator", "team", "owner", "sla"]} empty="Nothing here." />
    </>
  );
}
