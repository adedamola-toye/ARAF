import Link from "next/link";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { formatLagos } from "@/server/time";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { pageHref } from "@/components/SortHeader";

export const metadata = { title: "System audit" };

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (sp.ref) add("upper(a.ref) = upper(?)", sp.ref.trim());
  if (sp.customer) add("e.customer_id::text = ?", sp.customer.trim());
  if (sp.actor) add("lower(coalesce(e.actor_email,'')) LIKE '%' || lower(?) || '%'", sp.actor.trim());
  if (sp.action) add("e.action ILIKE '%' || ? || '%'", sp.action.trim());
  if (sp.outcome) add("e.outcome = ?", sp.outcome);
  if (sp.from) add("e.occurred_at >= ?::date - interval '1 hour'", sp.from);
  if (sp.to) add("e.occurred_at < ?::date + interval '23 hours'", sp.to);
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const size = 50;
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = (
    await db.query(
      `SELECT e.*, a.ref, c.display_name AS customer_name FROM audit_events e LEFT JOIN applications a ON a.id = e.application_id
         LEFT JOIN customers c ON c.id = e.customer_id ${w} ORDER BY e.id DESC LIMIT ${size + 1} OFFSET ${(page - 1) * size}`,
      params,
    )
  ).rows;
  const more = rows.length > size;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>System audit</h1>
          <p>Append-only. Per-request and per-customer trails: filter by request ID or customer ID. Client IP (server-observed via trusted proxy configuration) and device metadata are recorded separately.</p>
        </div>
      </div>
      <form className="filters" method="get">
        <div className="field"><label htmlFor="ref">Request ID</label><input id="ref" name="ref" defaultValue={sp.ref ?? ""} /></div>
        <div className="field"><label htmlFor="customer">Customer ID</label><input id="customer" name="customer" defaultValue={sp.customer ?? ""} /></div>
        <div className="field"><label htmlFor="actor">Actor email</label><input id="actor" name="actor" defaultValue={sp.actor ?? ""} /></div>
        <div className="field"><label htmlFor="action">Action</label><input id="action" name="action" defaultValue={sp.action ?? ""} placeholder="e.g. LOGIN, DOCUMENT" /></div>
        <div className="field"><label htmlFor="outcome">Outcome</label><select id="outcome" name="outcome" defaultValue={sp.outcome ?? ""}><option value="">Any</option><option>SUCCESS</option><option>DENIED</option><option>FAILURE</option></select></div>
        <div className="field"><label htmlFor="from">From</label><input id="from" name="from" type="date" defaultValue={sp.from ?? ""} /></div>
        <div className="field"><label htmlFor="to">To</label><input id="to" name="to" type="date" defaultValue={sp.to ?? ""} /></div>
        <button className="btn">Filter</button>
      </form>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Time (WAT)</th><th>Actor</th><th>Role</th><th>Action</th><th>Outcome</th><th>Request / customer</th><th>Stage</th><th>Reason / details</th><th>Client IP</th><th>Device</th><th>Correlation ID</th></tr>
          </thead>
          <tbody>
            {rows.slice(0, size).map((e) => (
              <tr key={e.id}>
                <td className="small nowrap">{formatLagos(e.occurred_at)}</td>
                <td className="small">{e.actor_email ?? "system"}</td>
                <td className="small">{e.actor_role ? ROLE_LABELS[e.actor_role as Role] ?? e.actor_role : "—"}</td>
                <td className="small mono">{e.action}{e.document_version ? ` v${e.document_version}` : ""}</td>
                <td><span className={`badge ${e.outcome === "SUCCESS" ? "badge-green" : "badge-red"}`}>{e.outcome}</span></td>
                <td className="small">{e.ref ? <Link href={`/admin/audit?ref=${e.ref}`} className="mono">{e.ref}</Link> : "—"}{e.customer_id && <div><Link className="muted" href={`/admin/audit?customer=${e.customer_id}`}>{e.customer_name ?? "customer"}</Link></div>}</td>
                <td className="small">{e.stage ? STAGE_LABELS[e.stage as Stage] ?? e.stage : "—"}</td>
                <td className="small" style={{ maxWidth: 260, wordBreak: "break-word" }}>{e.reason}{Object.keys(e.details ?? {}).length > 0 && <div className="muted mono" style={{ fontSize: 11 }}>{JSON.stringify(e.details).slice(0, 220)}</div>}</td>
                <td className="small mono">{e.client_ip ?? "—"}</td>
                <td className="small">{e.device ?? "—"}</td>
                <td className="small mono" style={{ fontSize: 11 }}>{e.correlation_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav className="pagination">
        {page > 1 && <Link className="btn btn-sm" href={pageHref("/admin/audit", sp, page - 1)}>Newer</Link>}
        {more && <Link className="btn btn-sm" href={pageHref("/admin/audit", sp, page + 1)}>Older</Link>}
      </nav>
    </>
  );
}
