import Link from "next/link";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { ROLES, ROLE_LABELS, REGIONS, type Role } from "@/server/domain/roles";
import { ProvisionForm } from "../AdminForms";
import { BulkAssign, SelectAllStaff, StaffBulkUpload } from "./StaffBulk";

export const metadata = { title: "Staff & roles" };

export default async function StaffList({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const q = (sp.q ?? "").toLowerCase().trim();
  const show = ["noroles", "recent"].includes(sp.show ?? "") ? sp.show! : "all";
  const rows = (
    await db.query(
      `SELECT s.*, coalesce(json_agg(json_build_object('role', ra.role, 'region', ra.region) ORDER BY ra.role) FILTER (WHERE ra.id IS NOT NULL), '[]') AS roles
         FROM staff s LEFT JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active
        WHERE ($1 = '' OR lower(s.full_name) LIKE '%' || $1 || '%' OR s.email LIKE '%' || $1 || '%' OR lower(coalesce(s.business_unit, '')) LIKE '%' || $1 || '%')
          AND ($2 <> 'recent' OR s.created_at > now() - interval '7 days')
        GROUP BY s.id
       HAVING ($2 <> 'noroles' OR count(ra.id) = 0)
        ORDER BY ${show === "recent" ? "s.created_at DESC, " : ""}s.full_name`,
      [q, show],
    )
  ).rows;
  const roleOptions = ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })).sort((a, b) => a.label.localeCompare(b.label));
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Staff &amp; roles</h1>
          <p>Provision named staff against verified @altbank.ng entries in the <Link href="/admin/directory">bank directory</Link>. There is no public registration. Admin status does not grant approval powers.</p>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Provision staff</h2>
        <ProvisionForm regions={[...REGIONS]} roles={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Bulk upload staff</h2>
        <StaffBulkUpload />
      </div>
      <form className="filters" method="get" id="assign">
        <div className="field">
          <label htmlFor="q">Search staff</label>
          <input id="q" name="q" type="search" defaultValue={sp.q ?? ""} placeholder="Name, email or unit" />
        </div>
        <div className="field">
          <label htmlFor="show">Show</label>
          <select id="show" name="show" defaultValue={show}>
            <option value="all">All staff</option>
            <option value="noroles">Without roles</option>
            <option value="recent">Added in the last 7 days</option>
          </select>
        </div>
        <button className="btn">Search</button>
      </form>
      <BulkAssign roles={roleOptions} regions={[...REGIONS]} count={rows.length}>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th scope="col" style={{ width: 36 }}><SelectAllStaff /></th><th>Name</th><th>Email</th><th>Status</th><th>State / unit</th><th>Active roles</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><input type="checkbox" name="staffId" value={r.id} aria-label={`Select ${r.full_name}`} disabled={r.status !== "ACTIVE"} /></td>
                <td><Link href={`/admin/staff/${r.id}`}>{r.full_name}</Link></td>
                <td className="small">{r.email}</td>
                <td><span className={`badge ${r.status === "ACTIVE" ? "badge-green" : "badge-red"}`}>{r.status}</span></td>
                <td className="small">{r.region ?? "—"} {r.business_unit && `· ${r.business_unit}`}</td>
                <td>
                  <div className="row" style={{ gap: 4 }}>
                    {r.roles.map((x: { role: Role; region: string | null }) => (
                      <span key={x.role} className="badge">{ROLE_LABELS[x.role] ?? x.role}{x.region ? ` · ${x.region}` : ""}</span>
                    ))}
                    {r.roles.length === 0 && <span className="small muted">No roles</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </BulkAssign>
    </>
  );
}
