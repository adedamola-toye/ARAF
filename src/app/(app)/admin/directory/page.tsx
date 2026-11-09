import Link from "next/link";
import { Download } from "lucide-react";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { directoryStats, searchDirectory } from "@/server/domain/directory";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { pageHref } from "@/components/SortHeader";
import { DirectoryUpload } from "./DirectoryUpload";

export const metadata = { title: "Bank directory" };

export default async function Directory({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const stats = await directoryStats(db);
  const { rows, more } = await searchDirectory(db, sp.q ?? "", page);
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Bank directory"
        intro="The verified staff list that provisioning and closure recipient groups are checked against. Upload the bank's export as Excel or CSV; preview the changes before they are saved."
        actions={
          <a className="btn" href="/api/admin/directory-template">
            <Download className="icon" aria-hidden="true" /> Download template (CSV)
          </a>
        }
      />
      <div className="metric-grid" style={{ marginBottom: 16 }}>
        <div className="metric"><div className="k">Entries</div><div className="v">{Number(stats.total).toLocaleString()}</div></div>
        <div className="metric"><div className="k">Active</div><div className="v">{Number(stats.active).toLocaleString()}</div></div>
        <div className="metric"><div className="k">Group mailboxes</div><div className="v">{Number(stats.groups).toLocaleString()}</div></div>
        <div className="metric"><div className="k">Last updated</div><div className="v" style={{ fontSize: "0.95rem" }}>{stats.last_update ? formatLagos(stats.last_update) : "—"}</div></div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Upload directory</h2>
        <DirectoryUpload />
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Directory entries</h2>
          <form method="get" className="row" role="search">
            <label htmlFor="dq" className="sr-only">Search the directory</label>
            <input id="dq" name="q" type="search" defaultValue={sp.q ?? ""} placeholder="Name, email or department" style={{ width: 260 }} />
            <button className="btn btn-sm">Search</button>
          </form>
        </div>
        <div className="table-wrap">
          <table className="data responsive">
            <thead><tr><th>Name</th><th>Email</th><th>Department</th><th>Type</th><th>Status</th><th>Work Desk</th><th>Updated</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} className="empty">No entries{sp.q ? " match this search" : " yet. Upload the bank directory above"}.</td></tr>}
              {rows.map((r) => (
                <tr key={r.email}>
                  <td data-label="Name">{r.full_name}</td>
                  <td className="small" data-label="Email">{r.email}</td>
                  <td className="small" data-label="Department">{r.department ?? "—"}</td>
                  <td className="small" data-label="Type">{r.is_group_mailbox ? "Group mailbox" : "Person"}</td>
                  <td data-label="Status">{r.active ? <span className="badge badge-green">Active</span> : <span className="badge badge-red">Inactive</span>}</td>
                  <td className="small" data-label="Work Desk">{r.staff_id ? <Link href={`/admin/staff/${r.staff_id}`}>Provisioned{r.staff_status === "SUSPENDED" ? " (suspended)" : ""}</Link> : "—"}</td>
                  <td className="small" data-label="Updated">{formatLagos(r.updated_at)}<div className="muted">{r.source}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <nav className="pagination">
          {page > 1 && <Link className="btn btn-sm" href={pageHref("/admin/directory", sp, page - 1)}>Previous</Link>}
          {more && <Link className="btn btn-sm" href={pageHref("/admin/directory", sp, page + 1)}>Next</Link>}
        </nav>
      </div>
    </>
  );
}
