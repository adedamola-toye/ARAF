import Link from "next/link";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { listLocations, locationActivity, OUTLET_TYPE_LABELS, OUTLET_TYPES, type OutletType } from "@/server/domain/locations";
import { REGIONS } from "@/server/domain/roles";
import { formatKobo } from "@/server/money";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { LocationForm } from "../RetailAdminForms";

export const metadata = { title: "Locations" };
const SHOWN = 100;

export default async function LocationsAdmin({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const f = {
    q: (sp.q ?? "").trim().slice(0, 60).toLowerCase(),
    state: (REGIONS as readonly string[]).includes(sp.state ?? "") ? sp.state! : "",
    type: (OUTLET_TYPES as readonly string[]).includes(sp.type ?? "") ? (sp.type as OutletType) : "",
    status: ["active", "inactive"].includes(sp.status ?? "") ? sp.status! : "",
    rm: sp.rm === "1",
  };
  const all = await listLocations(db);
  const matching = all.filter(
    (l) =>
      (!f.q || l.name.toLowerCase().includes(f.q) || l.city.toLowerCase().includes(f.q)) &&
      (!f.state || l.state === f.state) &&
      (!f.type || l.outlet_type === f.type) &&
      (!f.status || (f.status === "active") === l.active) &&
      (!f.rm || l.rm_origination),
  );
  const open = sp.location ? all.find((l) => l.id === sp.location) : null;
  const activity = open ? await locationActivity(db, open.id) : null;
  const supervisors = (await db.query("SELECT s.id, s.full_name FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.role = 'OUTLET_SERVICE_SUPERVISOR' AND ra.active AND s.status = 'ACTIVE' ORDER BY s.full_name")).rows.map((s: { id: string; full_name: string }) => ({ id: s.id, label: s.full_name }));
  const states = [...REGIONS];
  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ ...(f.q ? { q: f.q } : {}), ...(f.state ? { state: f.state } : {}), ...(f.type ? { type: f.type } : {}), ...(f.status ? { status: f.status } : {}), ...(f.rm ? { rm: "1" } : {}), ...extra });
    return `?${p.toString()}`;
  };
  const valueOf = (l: (typeof all)[number]) => ({ id: l.id, state: l.state, city: l.city, outletType: l.outlet_type, name: l.name, address: l.address ?? "", ossStaffId: l.oss_staff_id ?? "", team: l.team ?? "", businessUnit: l.business_unit ?? "", rmOrigination: !!l.rm_origination, active: l.active });

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Locations"
        intro="Every Branch, AltLounge, Altshop and Altbox. Relationship Managers choose from the locations marked selectable; inactive locations stay on past requests and in reports but cannot be chosen. Locations are never deleted, and every change is audited."
      />
      <div className="metric-grid" style={{ marginBottom: "var(--space-4)" }}>
        {(
          [
            ["Locations", all.length],
            ["Active", all.filter((l) => l.active).length],
            ["Selectable by RMs", all.filter((l) => l.active && l.rm_origination).length],
            ["Inactive", all.filter((l) => !l.active).length],
          ] as [string, number][]
        ).map(([k, v]) => (
          <div key={k} className="metric">
            <div className="k">{k}</div>
            <div className="v">{v.toLocaleString("en-NG")}</div>
          </div>
        ))}
      </div>

      {open && activity && (
        <section className="card action-panel" aria-labelledby="h-open">
          <div className="card-head">
            <h2 id="h-open">{open.name}</h2>
            <Link href={qs({})} className="btn btn-ghost btn-sm">
              Close
            </Link>
          </div>
          <p className="small muted" style={{ marginTop: 0 }}>
            {OUTLET_TYPE_LABELS[open.outlet_type]} · {open.city}, {open.state}
            {open.business_unit ? ` · ${open.business_unit}` : ""} · created {open.created_at ? formatLagos(open.created_at) : "—"}
            {open.created_by_name ? ` by ${open.created_by_name}` : ""} · last changed {formatLagos(open.updated_at)}
            {open.updated_by_name ? ` by ${open.updated_by_name}` : ""}
          </p>
          <LocationForm value={valueOf(open)} states={states} supervisors={supervisors} label="Save changes" />
          <div className="grid-2" style={{ marginTop: "var(--space-4)" }}>
            <div>
              <h3>Relationship Managers ({activity.rms.length})</h3>
              {activity.rms.length ? (
                <ul className="plain-list small">
                  {activity.rms.map((r) => (
                    <li key={r.id}>
                      {r.full_name} · {r.requests} request{r.requests === 1 ? "" : "s"}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">No RM has originated a request here yet.</p>
              )}
            </div>
            <div>
              <h3>Change history</h3>
              {activity.history.length ? (
                <ul className="plain-list small">
                  {activity.history.map((h, i) => (
                    <li key={i}>
                      {formatLagos(h.occurred_at)} · {h.actor ?? "system"} · {h.action === "LOCATION_CREATED" ? "created" : "changed"}
                      {h.details?.before &&
                        ` (${Object.keys(h.details.after ?? {})
                          .filter((k) => JSON.stringify(h.details.before[k]) !== JSON.stringify(h.details.after[k]))
                          .map((k) => `${k}: ${String(h.details.before[k] ?? "—")} → ${String(h.details.after[k] ?? "—")}`)
                          .join("; ")})`}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">No recorded changes (created before change history, or by a data load).</p>
              )}
            </div>
          </div>
          <h3 style={{ marginTop: "var(--space-4)" }}>Requests ({activity.applications.length})</h3>
          {activity.applications.length ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Request</th>
                    <th scope="col">Product</th>
                    <th scope="col">Originator</th>
                    <th scope="col" className="num">
                      Amount
                    </th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.applications.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link href={`/requests/${a.id}`} className="mono">
                          {a.ref}
                        </Link>
                      </td>
                      <td>{a.product_label ?? "WakeelBoost"}</td>
                      <td>{a.initiator}</td>
                      <td className="num">{a.requested_amount_kobo ? formatKobo(Number(a.requested_amount_kobo)) : "—"}</td>
                      <td className="small">{a.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="small muted">No requests are linked to this location.</p>
          )}
        </section>
      )}

      <section className="card" aria-labelledby="h-new">
        <h2 id="h-new">Add a location</h2>
        <LocationForm value={{ state: "", city: "", outletType: "ALTLOUNGE", name: "", address: "", ossStaffId: "", team: "", businessUnit: "Retail", rmOrigination: true, active: true }} states={states} supervisors={supervisors} label="Add location" />
      </section>

      <section className="card" aria-labelledby="h-list">
        <div className="card-head">
          <h2 id="h-list">All locations</h2>
          <span className="small muted">
            {matching.length.toLocaleString("en-NG")} match{matching.length > SHOWN ? ` · first ${SHOWN} shown` : ""}
          </span>
        </div>
        <form className="filters" method="get">
          <div className="field">
            <label htmlFor="l-q">Search</label>
            <input id="l-q" name="q" defaultValue={f.q} placeholder="Name or town" />
          </div>
          <div className="field">
            <label htmlFor="l-state">State</label>
            <select id="l-state" name="state" defaultValue={f.state}>
              <option value="">All states</option>
              {states.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="l-type">Type</label>
            <select id="l-type" name="type" defaultValue={f.type}>
              <option value="">All types</option>
              {OUTLET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {OUTLET_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="l-status">Status</label>
            <select id="l-status" name="status" defaultValue={f.status}>
              <option value="">Any</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
          <label className="check" style={{ alignSelf: "end" }}>
            <input type="checkbox" name="rm" value="1" defaultChecked={f.rm} /> Selectable by RMs
          </label>
          <button type="submit" className="btn">
            Filter
          </button>
        </form>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Location</th>
                <th scope="col">Type</th>
                <th scope="col">State</th>
                <th scope="col">Business unit</th>
                <th scope="col">RMs can select</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {matching.slice(0, SHOWN).map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link href={qs({ location: l.id })}>{l.name}</Link>
                    <div className="small muted">{l.city}</div>
                  </td>
                  <td>{OUTLET_TYPE_LABELS[l.outlet_type]}</td>
                  <td>{l.state}</td>
                  <td>{l.business_unit ?? "—"}</td>
                  <td>{l.rm_origination ? <span className="badge badge-green">Yes</span> : "—"}</td>
                  <td>{l.active ? "Active" : <span className="badge">Inactive</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
