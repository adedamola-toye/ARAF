import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSuperAdmin } from "../../guard";
import { db } from "@/server/db";
import { ROLES, ROLE_LABELS, REGIONS, SINGLE_HOLDER_ROLES, type Role } from "@/server/domain/roles";
import { formatLagos } from "@/server/time";
import { GrantRoleForm, RevokeRoleButton, StatusButton } from "../../AdminForms";

export const metadata = { title: "Staff member" };

export default async function StaffDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { session } = await requireSuperAdmin();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const s = (await db.query("SELECT * FROM staff WHERE id = $1", [id])).rows[0];
  if (!s) notFound();
  const assignments = (
    await db.query(
      `SELECT ra.*, g.full_name AS granted_by_name, r.full_name AS revoked_by_name FROM role_assignments ra
         LEFT JOIN staff g ON g.id = ra.granted_by LEFT JOIN staff r ON r.id = ra.revoked_by WHERE ra.staff_id = $1 ORDER BY ra.active DESC, ra.granted_at DESC`,
      [id],
    )
  ).rows;
  const holders = (await db.query("SELECT role, staff_id FROM role_assignments WHERE active AND role = ANY($1::text[])", [SINGLE_HOLDER_ROLES])).rows;
  const self = id === session.staffId;
  const open = Number((await db.query("SELECT count(*) AS n FROM tasks WHERE assignee_id = $1 AND status = 'OPEN'", [id])).rows[0].n);
  return (
    <>
      <div className="page-head">
        <div>
          <p className="small muted" style={{ margin: 0 }}><Link href="/admin/staff">Staff &amp; roles</Link></p>
          <h1>{s.full_name}</h1>
          <p>{s.email} · {s.region ?? "No region"} · {s.business_unit ?? "No unit"} · {open} open task(s)</p>
        </div>
        {!self && <StatusButton staffId={id} status={s.status} />}
      </div>
      {sp.created && <div className="alert alert-success" style={{ marginBottom: 12 }}>Staff provisioned. Grant roles below.</div>}
      {self && <div className="alert alert-info" style={{ marginBottom: 12 }}>You cannot change your own role assignments or status (separation of duties).</div>}
      <div className="card">
        <h2>Role assignments</h2>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Role</th><th>Scope</th><th>Granted</th><th>Status</th><th /></tr></thead>
            <tbody>
              {assignments.length === 0 && <tr><td colSpan={5} className="empty">No assignments.</td></tr>}
              {assignments.map((a) => (
                <tr key={a.id}>
                  <td>{ROLE_LABELS[a.role as Role] ?? a.role}</td>
                  <td className="small">{a.region ?? "—"} {a.business_unit && `· ${a.business_unit}`}</td>
                  <td className="small">{formatLagos(a.granted_at)}{a.granted_by_name && <div className="muted">by {a.granted_by_name}</div>}</td>
                  <td>{a.active ? <span className="badge badge-green">Active</span> : <span className="badge">Revoked {formatLagos(a.revoked_at)}{a.revoked_by_name && ` by ${a.revoked_by_name}`}</span>}</td>
                  <td>{a.active && !self && <RevokeRoleButton staffId={id} role={a.role} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {!self && s.status === "ACTIVE" && (
        <div className="card">
          <h2>Grant role</h2>
          <p className="small muted">Credit Lead 1/2 and the North/South ANM Lead positions have a single holder. ANM requires a region. Legal/Shariah reviewers must first be in the approved recipient group.</p>
          <GrantRoleForm
            staffId={id}
            regions={[...REGIONS]}
            roles={ROLES.filter((r) => !assignments.some((a) => a.active && a.role === r)).map((r) => {
              const h = holders.find((x) => x.role === r);
              return { value: r, label: `${ROLE_LABELS[r]}${h ? " (position filled)" : ""}` };
            })}
          />
        </div>
      )}
    </>
  );
}
