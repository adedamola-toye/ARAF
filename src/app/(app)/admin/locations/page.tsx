import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { listLocations, OUTLET_TYPE_LABELS } from "@/server/domain/locations";
import { REGIONS } from "@/server/domain/roles";
import { PageHeader } from "@/components/PageHeader";
import { LocationForm } from "../RetailAdminForms";

export const metadata = { title: "Outlet locations" };

export default async function LocationsAdmin() {
  await requireSuperAdmin();
  const locations = await listLocations(db);
  const supervisors = (await db.query("SELECT s.id, s.full_name FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.role = 'OUTLET_SERVICE_SUPERVISOR' AND ra.active AND s.status = 'ACTIVE' ORDER BY s.full_name")).rows.map((s: { id: string; full_name: string }) => ({ id: s.id, label: s.full_name }));
  const states = [...REGIONS];
  return (
    <>
      <PageHeader eyebrow="Administration" title="Outlet locations" intro="State → town or city → outlet type → outlet. Each outlet maps to its Outlet Service Supervisor and team, which drive Delight Officer routing and access. Submitted applications keep a snapshot of the outlet as it was." />
      <section className="card" aria-labelledby="h-new">
        <h2 id="h-new">Add a location</h2>
        <LocationForm value={{ state: "", city: "", outletType: "ALTBOX", name: "", address: "", ossStaffId: "", team: "", active: true }} states={states} supervisors={supervisors} label="Add location" />
      </section>
      <div className="stack" style={{ marginTop: "var(--space-4)" }}>
        {locations.map((l) => (
          <details key={l.id} className="card">
            <summary style={{ cursor: "pointer" }}>
              <strong>{l.name}</strong> · {OUTLET_TYPE_LABELS[l.outlet_type]} · {l.city}, {l.state} · supervisor {l.oss_name ?? <span className="badge badge-red">none</span>} · team {l.team ?? "—"} {l.active ? "" : <span className="badge">inactive</span>}
            </summary>
            <div style={{ marginTop: 10 }}>
              <LocationForm value={{ id: l.id, state: l.state, city: l.city, outletType: l.outlet_type, name: l.name, address: l.address ?? "", ossStaffId: l.oss_staff_id ?? "", team: l.team ?? "", active: l.active }} states={states} supervisors={supervisors} label="Save changes" />
            </div>
          </details>
        ))}
      </div>
    </>
  );
}
