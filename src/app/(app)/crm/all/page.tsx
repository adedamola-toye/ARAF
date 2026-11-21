import { db } from "@/server/db";
import { listTickets } from "@/server/crm/tickets";
import { crmCatalogue, crmProducts, PRIORITIES, PRIORITY_LABELS, STATUSES, STATUS_LABELS } from "@/server/crm/core";
import { PageHeader } from "@/components/PageHeader";
import { requireOversight } from "../guard";
import { TicketTable } from "../ui";

export const metadata = { title: "All Complaints" };

type SP = { q?: string; product?: string; categoryId?: string; status?: string; priority?: string; teamId?: string; assigneeId?: string; from?: string; to?: string; escalated?: string; overdue?: string };

export default async function AllComplaints({ searchParams }: { searchParams: Promise<SP> }) {
  await requireOversight();
  const sp = await searchParams;
  const status = sp.status === "OPEN" || (STATUSES as readonly string[]).includes(sp.status ?? "") ? sp.status : undefined;
  const priority = (PRIORITIES as readonly string[]).includes(sp.priority ?? "") ? sp.priority : undefined;
  const rows = await listTickets(db, { kind: "ALL" }, { q: sp.q?.slice(0, 60), product: sp.product || undefined, categoryId: sp.categoryId, status, priority, teamId: sp.teamId, assigneeId: sp.assigneeId, from: sp.from, to: sp.to, escalated: sp.escalated === "1", overdue: sp.overdue === "1" }, new Date(), 500);
  const products = await crmProducts(db, { includeInactive: true });
  const { categories } = await crmCatalogue(db, { includeInactive: true });
  const teams = (await db.query<{ id: string; name: string }>("SELECT id, name FROM crm_teams ORDER BY name")).rows;
  const officers = (await db.query<{ id: string; name: string }>("SELECT DISTINCT s.id, s.full_name AS name FROM crm_team_members m JOIN staff s ON s.id = m.staff_id ORDER BY 2")).rows;
  const sel = (name: keyof SP, label: string, opts: [string, string][]) => (
    <div className="field" style={{ margin: 0 }}>
      <label htmlFor={`f-${name}`}>{label}</label>
      <select id={`f-${name}`} name={name} defaultValue={sp[name] ?? ""}>
        <option value="">Any</option>
        {opts.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
  const title = sp.escalated === "1" ? "Escalations" : sp.overdue === "1" ? "SLA monitoring: overdue complaints" : "All Complaints";
  return (
    <>
      <PageHeader eyebrow="CRM" title={title} intro="Search and filter every complaint. Open a ticket to see its full history, override routing or request action from a team." />
      <form className="card" style={{ marginBottom: "var(--space-4)" }} role="search">
        <div className="grid-4">
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="f-q">Search</label>
            <input id="f-q" name="q" defaultValue={sp.q ?? ""} placeholder="Ticket or request reference, subject" />
          </div>
          {sel("product", "Product", products.map((p) => [p.code, p.name]))}
          {sel("categoryId", "Category", categories.map((c) => [c.id, c.name]))}
          {sel("status", "Status", [["OPEN", "Any open"], ...STATUSES.filter((x) => x !== "NEW").map((x) => [x, STATUS_LABELS[x]] as [string, string])])}
          {sel("priority", "Priority", PRIORITIES.map((x) => [x, PRIORITY_LABELS[x]]))}
          {sel("teamId", "Responsible team", teams.map((t) => [t.id, t.name]))}
          {sel("assigneeId", "Assigned officer", officers.map((o) => [o.id, o.name]))}
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="f-from">Created from</label>
            <input id="f-from" type="date" name="from" defaultValue={sp.from ?? ""} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="f-to">Created to</label>
            <input id="f-to" type="date" name="to" defaultValue={sp.to ?? ""} />
          </div>
          <label className="check" style={{ alignSelf: "end" }}>
            <input type="checkbox" name="escalated" value="1" defaultChecked={sp.escalated === "1"} /> Escalated only
          </label>
          <label className="check" style={{ alignSelf: "end" }}>
            <input type="checkbox" name="overdue" value="1" defaultChecked={sp.overdue === "1"} /> Overdue only
          </label>
          <div style={{ alignSelf: "end" }}>
            <button className="btn btn-primary">Filter</button>
          </div>
        </div>
      </form>
      <p className="small muted">{rows.length === 500 ? "Showing the first 500 matches; narrow the filters to see more." : `${rows.length} ticket(s).`}</p>
      <TicketTable rows={rows} show={["creator", "team", "assignee", "owner", "sla"]} empty="No complaints match these filters." />
    </>
  );
}
