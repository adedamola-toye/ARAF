import Link from "next/link";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { ROLES, ROLE_LABELS, REGIONS, type Role } from "@/server/domain/roles";
import { ProvisionForm } from "../AdminForms";

export const metadata = { title: "Staff & roles" };

export default async function StaffList({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const q = (sp.q ?? "").toLowerCase();
  const rows = (
    await db.query(
      `SELECT s.*, coalesce(json_agg(json_build_object('role', ra.role, 'region', ra.region) ORDER BY ra.role) FILTER (WHERE ra.id IS NOT NULL), '[]') AS roles
         FROM staff s LEFT JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active
        WHERE ($1 = '' OR lower(s.full_name) LIKE '%' || $1 || '%' OR s.email LIKE '%' || $1 || '%')
        GROUP BY s.id ORDER BY s.full_name`,
      [q],
    )
  ).rows;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Staff &amp; roles</h1>
          <p>Provision named staff against verified @altbank.ng directory entries. There is no public registration. Admin status does not grant approval powers.</p>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Provision staff</h2>
        <ProvisionForm regions={[...REGIONS]} roles={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
      </div>
      <form className="filters" method="get">
        <div className="field">
          <label htmlFor="q">Search staff</label>
          <input id="q" name="q" type="search" defaultValue={sp.q ?? ""} />
        </div>
        <button className="btn">Search</button>
      </form>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Status</th><th>State / unit</th><th>Active roles</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="clickable">
                <td><Link className="row-link" href={`/admin/staff/${r.id}`}>{r.full_name}</Link></td>
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
    </>
  );
}
