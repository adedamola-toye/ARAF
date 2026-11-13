import Link from "next/link";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { listIncidents } from "@/server/incidents";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { Distribution, SeverityBadge, StatusBadge } from "./ui";

export const metadata = { title: "Incidents" };

export default async function Incidents({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireSuperAdmin();
  const tab = (await searchParams).tab === "resolved" ? "resolved" : "active";
  const rows = await listIncidents(db, tab, 100);
  const totals = (
    await db.query<{ active: number; resolved: number; affected: number }>(
      `SELECT count(*) FILTER (WHERE status IN ('DETECTED','INVESTIGATING'))::int AS active,
              count(*) FILTER (WHERE status IN ('RESOLVED','CLOSED') AND resolved_at > now() - interval '30 days')::int AS resolved,
              coalesce(sum(affected_users) FILTER (WHERE status IN ('DETECTED','INVESTIGATING')), 0)::int AS affected
         FROM incidents`,
    )
  ).rows[0];
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Incidents"
        intro="Technical failures, grouped by cause. Everyone affected by one incident shares its reference; the five approved messages are shared out evenly between them. Acknowledge an incident to tell affected users the team is investigating."
      />
      <div className="metric-grid" style={{ marginBottom: "var(--space-4)" }}>
        <div className="metric">
          <div className="k">Active incidents</div>
          <div className="v">{totals.active}</div>
        </div>
        <div className="metric">
          <div className="k">Users affected (active)</div>
          <div className="v">{totals.affected.toLocaleString()}</div>
        </div>
        <div className="metric">
          <div className="k">Resolved (30 days)</div>
          <div className="v">{totals.resolved}</div>
        </div>
      </div>
      <nav className="tabs" aria-label="Incident status">
        <Link className="tab" href="?tab=active" aria-current={tab === "active" ? "page" : undefined}>
          Active
        </Link>
        <Link className="tab" href="?tab=resolved" aria-current={tab === "resolved" ? "page" : undefined}>
          Resolved and closed
        </Link>
      </nav>
      {rows.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            {tab === "active" ? "No active incidents. Everything is running." : "No resolved incidents yet."}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Where</th>
                <th scope="col">Severity</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Users
                </th>
                <th scope="col">Messages</th>
                <th scope="col">First seen</th>
                <th scope="col">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">
                    <Link className="mono" href={`/admin/incidents/${r.id}`}>
                      {r.ref}
                    </Link>
                  </td>
                  <td className="small">
                    {r.module}
                    <div className="muted">{r.category.charAt(0) + r.category.slice(1).toLowerCase()} · {r.occurrences.toLocaleString()} occurrence{r.occurrences === 1 ? "" : "s"}</div>
                  </td>
                  <td>
                    <SeverityBadge s={r.severity} />
                  </td>
                  <td>
                    <StatusBadge s={r.status} />
                    {r.status === "DETECTED" && <div className="small muted">{r.routed_at ? "Alert sent" : "Not routed"}</div>}
                  </td>
                  <td className="num">{r.affected_users.toLocaleString()}</td>
                  <td style={{ minWidth: 180 }}>
                    <Distribution counts={r.message_counts} compact />
                  </td>
                  <td className="small nowrap">{formatLagos(r.first_seen_at)}</td>
                  <td className="small nowrap">{formatLagos(r.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
