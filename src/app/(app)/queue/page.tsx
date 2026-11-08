import Link from "next/link";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { actionQueue, type QueueSort } from "@/server/domain/views";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { formatKobo } from "@/server/money";
import { formatDuration, formatLagos } from "@/server/time";
import { SortHeader, pageHref } from "@/components/SortHeader";

export const metadata = { title: "My Action Queue" };

export default async function QueuePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session } = await requireUser();
  const sp = await searchParams;
  const q = await actionQueue(db, session.staffId, {
    sort: (sp.sort as QueueSort) ?? "waiting",
    dir: sp.dir === "asc" ? "asc" : "desc",
    stage: sp.stage || null,
    role: sp.role || null,
    q: sp.q || null,
    page: Number(sp.page ?? 1) || 1,
    pageSize: Number(sp.size ?? 20) || 20,
  });
  const now = Date.now();
  const stages = [...new Set(q.facets.map((f) => f.stage))];
  const roles = [...new Set(q.facets.map((f) => f.assignee_role))];
  const filtered = q.total !== q.allTotal;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>My Action Queue</h1>
          <p>
            {q.allTotal} item{q.allTotal === 1 ? "" : "s"} assigned to you across all your roles.
            {filtered && ` Showing ${q.total} matching the filters.`}
          </p>
        </div>
      </div>
      <form className="filters" method="get" role="search" aria-label="Filter queue">
        <div className="field">
          <label htmlFor="q">Search</label>
          <input id="q" name="q" type="search" defaultValue={sp.q ?? ""} placeholder="Request ID or customer" />
        </div>
        <div className="field">
          <label htmlFor="stage">Stage</label>
          <select id="stage" name="stage" defaultValue={sp.stage ?? ""}>
            <option value="">All stages</option>
            {stages.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s as Stage]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="role">Role</label>
          <select id="role" name="role" defaultValue={sp.role ?? ""}>
            <option value="">All my roles</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r as Role] ?? r}
              </option>
            ))}
          </select>
        </div>
        <input type="hidden" name="sort" value={sp.sort ?? "waiting"} />
        <input type="hidden" name="dir" value={sp.dir ?? "desc"} />
        <button className="btn">Apply</button>
        {filtered && (
          <Link className="btn btn-ghost" href="/queue">
            Clear filters
          </Link>
        )}
      </form>
      <div className="table-wrap">
        <table className="data">
          <caption className="sr-only">Items awaiting your action</caption>
          <thead>
            <tr>
              <SortHeader label="Request ID" col="ref" sp={sp} base="/queue" />
              <SortHeader label="Customer" col="customer" sp={sp} base="/queue" />
              <SortHeader label="Requested amount" col="amount" sp={sp} base="/queue" />
              <SortHeader label="Stage" col="stage" sp={sp} base="/queue" />
              <SortHeader label="Assigned" col="assigned" sp={sp} base="/queue" />
              <SortHeader label="Waiting" col="waiting" sp={sp} base="/queue" />
              <th scope="col">Required next action</th>
              <th scope="col">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {q.rows.length === 0 && (
              <tr>
                <td colSpan={8} className="empty">
                  {filtered ? "No items match these filters." : "Nothing is waiting for you. New assignments appear here automatically."}
                </td>
              </tr>
            )}
            {q.rows.map((r) => {
              const href = `/requests/${r.application_id}?task=${r.task_id}`;
              const waited = now - new Date(r.assigned_at).getTime();
              return (
                <tr key={r.task_id} className="clickable">
                  <td className="nowrap">
                    <Link className="row-link mono" href={href}>
                      {r.ref}
                    </Link>
                  </td>
                  <td>{r.customer_name}</td>
                  <td className="num">{formatKobo(r.requested_amount_kobo)}</td>
                  <td>
                    <span className="badge badge-yellow">{STAGE_LABELS[r.stage]}</span>
                    <div className="small muted">as {ROLE_LABELS[r.assignee_role as Role] ?? r.assignee_role}</div>
                  </td>
                  <td className="small nowrap">{formatLagos(r.assigned_at)}</td>
                  <td className="nowrap">
                    <span className={waited > 6 * 3600_000 ? "badge badge-red" : "badge"}>{formatDuration(waited)}</span>
                  </td>
                  <td className="small">{r.required_action}</td>
                  <td className="row-actions">
                    <Link className="btn btn-primary btn-sm" href={href}>
                      Take Action
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <nav className="pagination" aria-label="Queue pages">
        <span className="small muted">
          Page {q.page} of {q.pages}
        </span>
        {q.page > 1 && (
          <Link className="btn btn-sm" href={pageHref("/queue", sp, q.page - 1)}>
            Previous
          </Link>
        )}
        {q.page < q.pages && (
          <Link className="btn btn-sm" href={pageHref("/queue", sp, q.page + 1)}>
            Next
          </Link>
        )}
      </nav>
    </>
  );
}
