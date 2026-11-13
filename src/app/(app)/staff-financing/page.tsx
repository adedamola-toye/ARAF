import Link from "next/link";
import { redirect } from "next/navigation";
import { Inbox, Search } from "lucide-react";
import { requireUser } from "../../_lib/auth";
import { staffFinancingGate } from "../../_lib/staff-access";
import { AccessRestricted } from "@/components/AccessRestricted";
import { PageHeader } from "@/components/PageHeader";
import { db } from "@/server/db";
import { formatLagos } from "@/server/time";
import { heldRoles, queueMetrics, queueRows, viewsFor, QUEUE_LABELS, type QueueView } from "@/server/staff/views";
import { formatNairaKobo, STAFF_STATUSES, STAFF_STATUS_LABELS, STAFF_STATUS_QUEUE, type StaffStatus } from "@/lib/staff-financing";
import { DocumentationBadge, StaffStatusBadge } from "../staff-request/StatusBadge";

export const metadata = { title: "Staff financing queues" };

const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-NG");
const hrs = (v: unknown) => (v === null || v === undefined ? "—" : `${v} h`);

export default async function StaffFinancingQueues({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const a = await requireUser();
  const home = await staffFinancingGate(a, "VIEW_QUEUES");
  if (home) return <AccessRestricted product="Staff Financing" dashboardHref={home} />;
  const { session } = a;
  const roles = await heldRoles(db, session.staffId);
  const views = viewsFor(roles);
  if (!views.length) redirect("/staff-request");
  const view = (views.includes(sp.view as QueueView) ? sp.view : views[0]) as QueueView;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const [m, list] = await Promise.all([queueMetrics(db, view, session.staffId), queueRows(db, view, session.staffId, { q: sp.q, status: sp.status, page })]);
  const tiles: [string, string][] =
    view === "pm"
      ? [["Awaiting review", n(m.awaiting)], ["Reviewed by you", n(m.reviewed)], ["Returned by you", n(m.returned)], ["Checklists completed", n(m.checklists)], ["Average review time", hrs(m.avg_hours)]]
      : view === "uh"
        ? [["Awaiting your decision", n(m.awaiting)], ["Approved", n(m.approved)], ["Returned", n(m.returned)], ["Declined", n(m.declined)], ["Average decision time", hrs(m.avg_hours)]]
        : view === "dh"
          ? [["Final approvals awaiting", n(m.awaiting)], ["Total requested value", formatNairaKobo(m.requested_kobo)], ["Approved value", formatNairaKobo(m.approved_kobo)], ["Declined value", formatNairaKobo(m.declined_kobo)], ["Decision turnaround", hrs(m.avg_hours)]]
          : view === "do"
            ? [["Assigned to you", n(m.assigned)], ["Awaiting processing", n(m.awaiting)], ["Completed disbursements", n(m.completed)], ["Net value disbursed", formatNairaKobo(m.net_kobo)], ["Processing exceptions", n(m.exceptions)]]
            : view === "docs"
              ? [["Sent for review", n(m.sent)], ["Received", n(m.received)], ["Review completed", n(m.completed)]]
              : [["Offers blocked", n(m.offers_blocked)], ["Awaiting officer assignment", n(m.unassigned)], ["Documentation failures", n(m.doc_failures)], ["Awaiting signed offer", n(m.awaiting_signature)]];
  const qs = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ view, q: sp.q, status: sp.status, ...o })) if (v !== undefined && v !== "") p.set(k, String(v));
    return `?${p.toString()}`;
  };
  return (
    <>
      <PageHeader eyebrow="Staff Personal Financing" title="Staff financing queues" intro="Requests that need your decision come first. You see only the requests your roles allow." />
      {views.length > 1 && (
        <nav className="tabs" aria-label="Queues">
          {views.map((v) => (
            <Link key={v} className="tab" href={`?view=${v}`} aria-current={v === view ? "page" : undefined}>
              {QUEUE_LABELS[v]}
            </Link>
          ))}
        </nav>
      )}
      <div className="metric-grid" style={{ marginBottom: "var(--space-4)" }}>
        {tiles.map(([k, v]) => (
          <div key={k} className="metric">
            <div className="k">{k}</div>
            <div className="v">{v}</div>
          </div>
        ))}
      </div>
      <form className="filters" role="search" aria-label="Filter requests">
        <input type="hidden" name="view" value={view} />
        <div className="field">
          <label htmlFor="q">Search</label>
          <input id="q" name="q" type="search" defaultValue={sp.q} placeholder="Reference, staff name or staff ID" />
        </div>
        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={sp.status ?? ""}>
            <option value="">All statuses</option>
            {STAFF_STATUSES.filter((s) => s !== "DRAFT").map((s) => (
              <option key={s} value={s}>
                {STAFF_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <button className="btn">
          <Search className="icon" aria-hidden="true" /> Apply
        </button>
      </form>
      {list.rows.length === 0 ? (
        <div className="card">
          <div className="empty">
            <Inbox className="icon" aria-hidden="true" />
            <strong>Nothing here</strong>
            <p>{sp.q || sp.status ? "No requests match these filters." : "No staff financing requests are in this queue yet. New items appear here automatically."}</p>
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data responsive">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Staff</th>
                <th className="num">Gross</th>
                <th className="num">Deduction</th>
                <th className="num">Net</th>
                <th>Status</th>
                <th>Queue</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                <tr key={r.id} className={`clickable ${r.needs_action ? "selected-row" : ""}`}>
                  <td data-label="Reference">
                    <Link className="row-link" href={`/staff-request/${r.id}`}>
                      {r.ref}
                    </Link>
                    {r.needs_action && <div className="small"><span className="badge badge-yellow">Your action</span></div>}
                  </td>
                  <td data-label="Staff">
                    {r.full_name}
                    <div className="small muted">{[r.staff_number, r.unit].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td className="num" data-label="Gross">{formatNairaKobo(r.gross_kobo)}</td>
                  <td className="num" data-label="Deduction">{formatNairaKobo(r.deduction_kobo)}</td>
                  <td className="num" data-label="Net"><strong>{formatNairaKobo(r.net_kobo)}</strong></td>
                  <td data-label="Status">
                    <StaffStatusBadge status={r.status} />
                    {r.status === "COMPLETED" && (
                      <div style={{ marginTop: 4 }}>
                        <DocumentationBadge status={r.documentation_status} />
                      </div>
                    )}
                    {view === "ops" && r.offer_blocked_reason && <div className="small err">{r.offer_blocked_reason}</div>}
                    {view === "ops" && r.doc_last_error && <div className="small err">{r.doc_last_error}</div>}
                  </td>
                  <td data-label="Queue" className="small">{STAFF_STATUS_QUEUE[r.status as StaffStatus]}</td>
                  <td data-label="Updated" className="small">{formatLagos(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav className="pagination" aria-label="Pages">
        <span className="small muted">
          {list.total} request{list.total === 1 ? "" : "s"} · page {list.page} of {list.pages}
        </span>
        {list.page > 1 && (
          <Link className="btn btn-sm" href={qs({ page: list.page - 1 })}>
            Previous
          </Link>
        )}
        {list.page < list.pages && (
          <Link className="btn btn-sm" href={qs({ page: list.page + 1 })}>
            Next
          </Link>
        )}
      </nav>
    </>
  );
}
