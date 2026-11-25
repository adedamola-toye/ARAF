import Link from "next/link";
import { requireRole } from "../../../_lib/auth";
import { db } from "@/server/db";
import { CX_ACTIONS, CX_ACTIVITY_ROLES, cxReviewerActivity } from "@/server/cx-activity";
import { ACTION_LABELS, type TaskAction } from "@/server/domain/stages";
import { formatDuration, formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "CX reviewer activity" };

type SP = Record<string, string | undefined>;

const ACTION_TONE: Record<string, string> = {
  RECOMMEND: "badge-green",
  APPROVE: "badge-green",
  RETURN: "badge-warn",
  REQUEST_INITIATOR: "badge-warn",
  REJECT: "badge-red",
};

const label = (action: string) => ACTION_LABELS[action as TaskAction] ?? action.replace(/_/g, " ").toLowerCase();

export default async function CxReviewerActivityPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireRole([...CX_ACTIVITY_ROLES]);
  const sp = await searchParams;
  const filter = { from: sp.from ?? null, to: sp.to ?? null, reviewer: sp.reviewer ?? null, action: sp.action ?? null };
  const data = await cxReviewerActivity(db, filter);
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
  const s = data.summary;
  const tiles: [string, string | number, string?][] = [
    ["Reviews", s.total, `${data.from} to ${data.to}`],
    ["Recommended", s.positive],
    ["Returned for correction", s.corrections],
    ["Declined", s.declines],
    ["CX reviewers active", s.reviewers],
    ["Awaiting CX review now", s.open_now],
    ["Average time to decide", s.avg_hours ? `${s.avg_hours} h` : "—"],
  ];
  return (
    <>
      <PageHeader
        eyebrow="Reports"
        title="CX reviewer activity"
        intro="Every decision CX credit reviewers recorded on retail requests: what they recommended, returned or declined, when, and how long the request waited for them. Read-only."
      />
      <form className="filters" method="get" aria-label="CX reviewer activity filters">
        <div className="field">
          <label htmlFor="from">Decided from</label>
          <input id="from" name="from" type="date" defaultValue={data.from} />
        </div>
        <div className="field">
          <label htmlFor="to">to</label>
          <input id="to" name="to" type="date" defaultValue={data.to} />
        </div>
        <div className="field">
          <label htmlFor="reviewer">Reviewer</label>
          <select id="reviewer" name="reviewer" defaultValue={filter.reviewer ?? ""}>
            <option value="">All CX reviewers</option>
            {data.reviewerOptions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="action">Action</label>
          <select id="action" name="action" defaultValue={filter.action ?? ""}>
            <option value="">All actions</option>
            {CX_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {label(a)}
              </option>
            ))}
          </select>
        </div>
        <button className="btn">Apply</button>
        <a className="btn btn-ghost" href={`/api/reports/cx-activity?${qs}`}>
          Export CSV
        </a>
      </form>

      <div className="metric-grid" style={{ marginBottom: "var(--space-4)" }}>
        {tiles.map(([k, v, note]) => (
          <div key={k} className="metric">
            <div className="k">{k}</div>
            <div className="v">{v}</div>
            {note && <div className="small muted">{note}</div>}
          </div>
        ))}
      </div>

      <section className="card" aria-labelledby="cx-by-reviewer">
        <div className="card-head">
          <h2 id="cx-by-reviewer">Activity by reviewer</h2>
        </div>
        <div className="table-wrap">
          <table className="data small">
            <thead>
              <tr>
                <th scope="col">Reviewer</th>
                <th scope="col">Reviews</th>
                <th scope="col">Recommended</th>
                <th scope="col">Returned</th>
                <th scope="col">Declined</th>
                <th scope="col">Average time to decide</th>
              </tr>
            </thead>
            <tbody>
              {data.reviewers.map((r) => (
                <tr key={r.reviewer_id}>
                  <td>
                    {r.reviewer_name}
                    <div className="small muted">{r.reviewer_email}</div>
                  </td>
                  <td>{r.total}</td>
                  <td>{r.positive}</td>
                  <td>{r.corrections}</td>
                  <td>{r.declines}</td>
                  <td>{r.avg_hours ? `${r.avg_hours} h` : "—"}</td>
                </tr>
              ))}
              {!data.reviewers.length && (
                <tr>
                  <td colSpan={6} className="muted">
                    No CX reviewer decisions in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="cx-decisions">
        <div className="card-head">
          <h2 id="cx-decisions">Review decisions</h2>
        </div>
        <div className="table-wrap">
          <table className="data small">
            <thead>
              <tr>
                <th scope="col">Request</th>
                <th scope="col">Customer</th>
                <th scope="col">Product</th>
                <th scope="col">Reviewer</th>
                <th scope="col">Action</th>
                <th scope="col">Reason</th>
                <th scope="col">Decided</th>
                <th scope="col">Time to decide</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.decision_id}>
                  <td>
                    <Link href={`/requests/${r.application_id}`}>{r.ref}</Link>
                  </td>
                  <td>{r.customer_name ?? "—"}</td>
                  <td>{r.product_label ?? r.product_code ?? "—"}</td>
                  <td>{r.reviewer_name}</td>
                  <td>
                    <span className={`badge ${ACTION_TONE[r.action] ?? ""}`}>{label(r.action)}</span>
                  </td>
                  <td className="small">{r.reason ?? "—"}</td>
                  <td>{formatLagos(r.decided_at)}</td>
                  <td>{formatDuration(Number(r.turnaround_ms))}</td>
                  <td>{r.invalidated_at ? <span className="badge badge-warn">Superseded</span> : <span className="badge badge-green">Current</span>}</td>
                </tr>
              ))}
              {!data.rows.length && (
                <tr>
                  <td colSpan={9} className="muted">
                    No CX reviewer decisions in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
