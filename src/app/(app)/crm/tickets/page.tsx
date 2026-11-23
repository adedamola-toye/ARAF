import Link from "next/link";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { listTickets } from "@/server/crm/tickets";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TicketTable } from "../ui";

export const metadata = { title: "My Tickets" };

const VIEWS: Record<string, string | undefined> = { open: "OPEN", action: undefined, resolved: "RESOLVED", closed: "CLOSED", all: undefined };

export default async function MyTickets({ searchParams }: { searchParams: Promise<{ view?: string; q?: string }> }) {
  const { session } = await requireUser();
  const sp = await searchParams;
  const view = sp.view && sp.view in VIEWS ? sp.view : "open";
  let rows = await listTickets(db, { kind: "CREATOR", staffId: session.staffId }, { status: VIEWS[view], q: sp.q?.slice(0, 60) });
  if (view === "action") rows = rows.filter((r) => r.status === "PENDING_INFO" || r.status === "RESOLVED");
  return (
    <>
      <PageHeader eyebrow="CRM" title="My Tickets" intro="Complaints you raised: where each one is and who has it." actions={<Link className="btn btn-primary" href="/crm/new">Raise a complaint</Link>} />
      <Tabs base="/crm/tickets" current={view} tabs={[["open", "Open"], ["action", "Needs my reply"], ["resolved", "Resolved"], ["closed", "Closed"], ["all", "All"]]} />
      <form className="row" style={{ marginBottom: "var(--space-3)" }} role="search">
        <input type="hidden" name="view" value={view} />
        <label className="sr-only" htmlFor="mt-q">
          Search
        </label>
        <input id="mt-q" name="q" defaultValue={sp.q ?? ""} placeholder="Reference, subject or request reference" style={{ maxWidth: 360 }} />
        <button className="btn">Search</button>
      </form>
      <TicketTable rows={rows} show={["team", "assignee", "updated"]} empty="No tickets here." />
    </>
  );
}
