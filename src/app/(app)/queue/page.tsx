import Link from "next/link";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { actionQueue, type QueueSort } from "@/server/domain/views";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { formatKobo } from "@/server/money";
import { formatDuration, formatLagos } from "@/server/time";
import { SortHeader, pageHref } from "@/components/SortHeader";
import { PageHeader } from "@/components/PageHeader";
import { StageChip, WaitChip } from "@/components/Status";
import { ArrowRight, Inbox, Search } from "lucide-react";
import { WalletCard } from "@/components/WalletCard";
import { walletToday } from "@/server/domain/wallet";

export const metadata = { title: "My Action Queue" };

export default async function QueuePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session, roles: myRoles } = await requireUser();
  const sp = await searchParams;
  const wallet = myRoles.includes("RM") ? await walletToday(db, session.staffId, new Date()) : null;
  const rmAssigned = myRoles.includes("RM")
    ? (await db.query(`SELECT a.id, a.ref, a.customer_name, a.product_label, a.stage, s.full_name AS do_name FROM applications a JOIN staff s ON s.id = a.initiator_id WHERE a.assigned_rm_id = $1 AND a.stage IN ('DRAFT','INITIATOR_CORRECTION') ORDER BY a.updated_at DESC`, [session.staffId])).rows
    : [];
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
      <PageHeader
        eyebrow="Work"
        title="My Action Queue"
        intro={
          <>
            {q.allTotal} item{q.allTotal === 1 ? "" : "s"} assigned to you across all your roles.
            {filtered && ` Showing ${q.total} matching the filters.`}
          </>
        }
      />
      {wallet && <WalletCard totalKobo={wallet.totalKobo} count={wallet.count} day={wallet.day} />}
      {rmAssigned.length > 0 && (
        <section className="card" aria-labelledby="h-rm" style={{ margin: "var(--space-4) 0" }}>
          <h2 id="h-rm">Assigned to you as Relationship Manager</h2>
          <p className="small muted" style={{ marginTop: 0 }}>Delight Officer requests waiting for your credit proposal and business-visit evidence.</p>
          <ul className="small">
            {rmAssigned.map((r: { id: string; ref: string; customer_name: string; product_label: string; do_name: string }) => (
              <li key={r.id}>
                <Link href={`/requests/${r.id}/edit`}>{r.ref}</Link> · {r.customer_name} · {r.product_label} · from {r.do_name}
              </li>
            ))}
          </ul>
        </section>
      )}
      <form className="filters" method="get" role="search" aria-label="Filter queue" style={{ marginTop: "var(--space-4)" }}>
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
        <button className="btn"><Search className="icon" aria-hidden="true" />Apply</button>
        {filtered && (
          <Link className="btn btn-ghost" href="/queue">
            Clear filters
          </Link>
        )}
      </form>
      <div className="table-wrap">
        <table className="data responsive">
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
                  <Inbox className="icon" aria-hidden="true" />
                  {filtered ? "No items match these filters." : "Nothing is waiting for you. New assignments appear here automatically."}
                </td>
              </tr>
            )}
            {q.rows.map((r) => {
              const href = `/requests/${r.application_id}?task=${r.task_id}`;
              const waited = now - new Date(r.assigned_at).getTime();
              return (
                <tr key={r.task_id} className="clickable">
                  <td className="nowrap" data-label="Request ID">
                    <Link className="row-link mono" href={href} aria-label={`Open ${r.ref} for ${r.customer_name ?? "customer"}`}>
                      {r.ref}
                    </Link>
                  </td>
                  <td data-label="Customer">
                    {r.customer_name}
                    {r.product_label && <div className="small muted">{r.product_label}</div>}
                    {r.suspended && <span className="badge badge-red">Suspended</span>}
                  </td>
                  <td className="num" data-label="Requested amount">{formatKobo(r.requested_amount_kobo)}</td>
                  <td data-label="Stage">
                    <StageChip stage={r.stage} />
                    <div className="small muted">as {ROLE_LABELS[r.assignee_role as Role] ?? r.assignee_role}</div>
                  </td>
                  <td className="small nowrap" data-label="Assigned">{formatLagos(r.assigned_at)}</td>
                  <td className="nowrap" data-label="Waiting">
                    <WaitChip ms={waited} label={formatDuration(waited)} />
                  </td>
                  <td className="small" data-label="Next action">{r.required_action}</td>
                  <td className="row-actions">
                    <Link className="btn btn-primary btn-sm" href={href}>
                      Take Action <ArrowRight className="icon" aria-hidden="true" />
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
