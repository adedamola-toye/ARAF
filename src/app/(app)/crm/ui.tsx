import Link from "next/link";
import { PRIORITY_LABELS, STATUS_LABELS, OPEN_STATUSES, type Priority, type TicketStatus } from "@/server/crm/core";
import type { TicketListRow } from "@/server/crm/tickets";
import type { officerPerformance } from "@/server/crm/analytics";
import { formatDuration, formatLagos } from "@/server/time";

export function StatusBadge({ status, escalated }: { status: TicketStatus; escalated?: boolean }) {
  const cls = status === "CLOSED" ? "badge-green" : status === "RESOLVED" ? "badge-blue" : status === "UNASSIGNED" || status === "REOPENED" ? "badge-warn" : status === "PENDING_INFO" ? "badge-yellow" : "";
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      <span className={`badge ${cls}`}>{STATUS_LABELS[status]}</span>
      {escalated && OPEN_STATUSES.includes(status) && <span className="badge badge-red">Escalated</span>}
    </span>
  );
}

export function PriorityBadge({ p }: { p: Priority }) {
  const cls = p === "CRITICAL" ? "badge-red" : p === "HIGH" ? "badge-warn" : p === "LOW" ? "" : "badge-blue";
  return <span className={`badge ${cls}`}>{PRIORITY_LABELS[p]}</span>;
}

/** Time left or overdue against the resolution target; "No target" when none is configured. */
export function SlaCell({ due, status, now, paused }: { due: Date | null; status: TicketStatus; now: number; paused?: boolean }) {
  if (!due) return <span className="muted small">No target</span>;
  if (!OPEN_STATUSES.includes(status)) return <span className="small">{formatLagos(due)}</span>;
  if (paused) return <span className="badge badge-yellow">Paused</span>;
  const left = new Date(due).getTime() - now;
  if (left < 0) return <span className="badge badge-red">Overdue {formatDuration(-left)}</span>;
  return <span className={`badge ${left < 2 * 3_600_000 ? "badge-warn" : ""}`}>{formatDuration(left)} left</span>;
}

export function TicketTable({ rows, show, empty = "No tickets." }: { rows: TicketListRow[]; show: ("creator" | "team" | "assignee" | "owner" | "sla" | "updated")[]; empty?: string }) {
  const now = Date.now();
  const has = (k: (typeof show)[number]) => show.includes(k);
  const cols = 5 + show.length;
  return (
    <div className="table-wrap">
      <table className="data responsive">
        <caption className="sr-only">Complaint tickets</caption>
        <thead>
          <tr>
            <th scope="col">Ticket</th>
            <th scope="col">Subject</th>
            <th scope="col">Product · issue</th>
            <th scope="col">Priority</th>
            <th scope="col">Status</th>
            {has("creator") && <th scope="col">Raised by</th>}
            {has("team") && <th scope="col">Team</th>}
            {has("assignee") && <th scope="col">Officer</th>}
            {has("owner") && <th scope="col">With current owner</th>}
            {has("sla") && <th scope="col">Resolution target</th>}
            {has("updated") && <th scope="col">Updated</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td data-label="Ticket">
                <Link href={`/crm/tickets/${r.id}`}>
                  <strong>{r.ref}</strong>
                </Link>
                <div className="small muted">{formatLagos(r.created_at)}</div>
              </td>
              <td data-label="Subject" style={{ maxWidth: 280 }}>
                {r.subject}
              </td>
              <td data-label="Product · issue">
                <div>{r.product_name}</div>
                <div className="small muted">
                  {r.category_name} — {r.subcategory_name}
                </div>
              </td>
              <td data-label="Priority">
                <PriorityBadge p={r.priority} />
              </td>
              <td data-label="Status">
                <StatusBadge status={r.status} escalated={r.escalated} />
              </td>
              {has("creator") && <td data-label="Raised by">{r.creator_name}</td>}
              {has("team") && <td data-label="Team">{r.team_name}</td>}
              {has("assignee") && <td data-label="Officer">{r.assignee_name ?? <span className="muted">Unassigned</span>}</td>}
              {has("owner") && <td data-label="With current owner">{r.owner_since ? formatDuration(now - new Date(r.owner_since).getTime()) : "—"}</td>}
              {has("sla") && (
                <td data-label="Resolution target">
                  <SlaCell due={r.resolution_due} status={r.status} now={now} />
                </td>
              )}
              {has("updated") && <td data-label="Updated">{formatLagos(r.updated_at)}</td>}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={cols} className="muted">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({ base, current, tabs, extra = "" }: { base: string; current: string; tabs: [string, string, number?][]; extra?: string }) {
  return (
    <nav className="tabs" aria-label="Views">
      {tabs.map(([k, label, n]) => (
        <Link key={k} className="tab" href={`${base}?view=${k}${extra}`} aria-current={current === k ? "page" : undefined}>
          {label}
          {n ? ` (${n})` : ""}
        </Link>
      ))}
    </nav>
  );
}

export function Metric({ k, v, note }: { k: string; v: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="metric">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {note && <div className="small muted">{note}</div>}
    </div>
  );
}

export function Breakdown({ title, rows, total }: { title: string; rows: { label: string; count: number }[]; total?: number }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="card">
      <h2 style={{ fontSize: 15 }}>{title}</h2>
      {rows.length ? (
        <table className="data">
          <caption className="sr-only">{title}</caption>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td style={{ width: "45%" }}>{r.label}</td>
                <td style={{ width: "45%" }}>
                  <div aria-hidden="true" style={{ height: 8, borderRadius: 4, background: "var(--accent)", width: `${Math.max(4, (r.count / max) * 100)}%` }} />
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {r.count}
                  {total ? <span className="muted small"> · {Math.round((r.count / total) * 100)}%</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">No complaints in this period.</p>
      )}
    </div>
  );
}

export const dur = (ms: number | null | undefined) => (ms === null || ms === undefined ? "—" : formatDuration(ms));
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v}%`);

export function OfficerTable({ rows }: { rows: Awaited<ReturnType<typeof officerPerformance>> }) {
  return (
    <div className="table-wrap">
      <table className="data responsive">
        <caption className="sr-only">Officer performance</caption>
        <thead>
          <tr>
            <th scope="col">Officer</th>
            <th scope="col">Tickets handled</th>
            <th scope="col">Resolved</th>
            <th scope="col">Handed on</th>
            <th scope="col">Open now</th>
            <th scope="col">Avg handling</th>
            <th scope="col">Median</th>
            <th scope="col">Max</th>
            <th scope="col">SLA met / breached</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.officer_id}>
              <td data-label="Officer">{o.officer_name}</td>
              <td data-label="Tickets handled">{o.received}</td>
              <td data-label="Resolved">{o.resolved}</td>
              <td data-label="Handed on">{o.transferred_out}</td>
              <td data-label="Open now">{o.pending_now}</td>
              <td data-label="Avg handling">{dur(o.avg_handling_ms)}</td>
              <td data-label="Median">{dur(o.median_handling_ms)}</td>
              <td data-label="Max">{dur(o.max_handling_ms)}</td>
              <td data-label="SLA met / breached">
                {o.sla_met} / {o.sla_breached}
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={9} className="muted">
                No officer handled tickets in this period.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Period from ?from&to (Lagos dates), defaulting to the last 30 days. */
export function periodFrom(sp: { from?: string; to?: string }, today: string, addDays: (d: string, n: number) => string) {
  const ok = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const to = ok(sp.to) ? sp.to! : today;
  const from = ok(sp.from) ? sp.from! : addDays(to, -29);
  return from <= to ? { from, to } : { from: to, to: from };
}

export function PeriodForm({ from, to, children }: { from: string; to: string; children?: React.ReactNode }) {
  return (
    <form className="row" style={{ marginBottom: "var(--space-4)", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor="pf-from">From</label>
        <input id="pf-from" type="date" name="from" defaultValue={from} />
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor="pf-to">To</label>
        <input id="pf-to" type="date" name="to" defaultValue={to} />
      </div>
      {children}
      <button className="btn">Apply</button>
    </form>
  );
}
