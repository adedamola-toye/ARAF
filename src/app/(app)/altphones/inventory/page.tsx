import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { ActionForm, SubmitButton } from "@/components/forms";
import { db } from "@/server/db";
import { formatLagos } from "@/server/time";
import { altphonesAccess, pendingReplenishments } from "@/server/altphones/views";
import { stockOverview } from "@/server/altphones/stock";
import { listModels } from "@/server/altphones/catalogue";
import { isUuid } from "@/server/altphones/core";
import { decideStockAction, replenishAction } from "../actions";

export const metadata = { title: "Altphones inventory" };

const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-NG");

export default async function AltInventory({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { session } = await requireUser();
  const access = await altphonesAccess(db, session.staffId);
  if (!access.inventory) redirect("/altphones");
  const locId = sp.location && isUuid(sp.location) ? sp.location : null;
  const [rows, repl, models, locations] = await Promise.all([
    stockOverview(db),
    pendingReplenishments(db),
    listModels(db),
    db.query<{ id: string; name: string; outlet_type: string; state: string; city: string }>("SELECT id, name, outlet_type, state, city FROM locations WHERE active AND outlet_type IN ('BRANCH','ALTSHOP') ORDER BY state, city, name").then((r) => r.rows),
  ]);
  const shown = locId ? rows.filter((r) => r.location_id === locId) : rows;
  const devices = locId
    ? (
        await db.query(
          `SELECT d.imei, d.status, d.legacy, m.name AS model, a.ref, a.id AS app_id, d.registered_at, d.issued_at
             FROM altphones_devices d JOIN altphones_models m ON m.id = d.model_id LEFT JOIN altphones_applications a ON a.id = d.application_id
            WHERE d.location_id = $1 ORDER BY (d.status = 'ISSUED'), m.name, d.imei LIMIT 500`,
          [locId],
        )
      ).rows
    : [];
  const ledger = locId
    ? (
        await db.query(
          `SELECT g.movement, g.physical_delta, g.reserved_delta, g.reference, g.legacy, g.note, g.occurred_at, m.name AS model, s.full_name AS actor
             FROM altphones_stock_ledger g JOIN altphones_models m ON m.id = g.model_id LEFT JOIN staff s ON s.id = g.actor_id
            WHERE g.location_id = $1 ORDER BY g.occurred_at DESC LIMIT 100`,
          [locId],
        )
      ).rows
    : [];
  const pending = repl.filter((r) => r.status === "PENDING");
  const totals = rows.reduce((a, r) => ({ physical: a.physical + r.physical, reserved: a.reserved + r.reserved, available: a.available + r.available }), { physical: 0, reserved: 0, available: 0 });
  const locName = locId ? (locations.find((l) => l.id === locId)?.name ?? "Location") : null;
  return (
    <>
      <PageHeader
        eyebrow="Altphones"
        title={locName ? `Inventory — ${locName}` : "Inventory"}
        intro="Stock is held by Branches and Shops only. Every change is a ledger entry; additions need Super Admin approval."
        crumbs={locId ? [{ href: "/altphones/inventory", label: "Inventory" }, { label: locName! }] : undefined}
      />
      <div className="metric-grid" style={{ marginBottom: "var(--space-4)" }}>
        {(
          [
            ["Physical stock", n(totals.physical)],
            ["Reserved", n(totals.reserved)],
            ["Available to sell", n(totals.available)],
            ["Stock requests pending", n(pending.length)],
          ] as [string, string][]
        ).map(([k, v]) => (
          <div key={k} className="metric">
            <div className="k">{k}</div>
            <div className="v">{v}</div>
          </div>
        ))}
      </div>

      {access.admin && pending.length > 0 && (
        <section className="card action-panel" aria-labelledby="h-appr">
          <h2 id="h-appr">Stock requests awaiting your approval</h2>
          <div className="stack">
            {pending.map((r) => (
              <div key={r.id} className="alt-repl">
                <div>
                  <strong>
                    {r.quantity} × {r.model_name}
                  </strong>{" "}
                  to {r.location_name} <span className="badge">{r.kind === "OPENING" ? "Opening stock" : "Receipt"}</span>
                  <div className="small muted">
                    <span className="mono">{r.ref}</span> · {r.requested_by_name} · {formatLagos(r.requested_at)} · {r.imeis.length} IMEI{r.imeis.length === 1 ? "" : "s"} listed
                  </div>
                  <div className="small">{r.reason}</div>
                </div>
                {r.requested_by === session.staffId ? (
                  <span className="small muted">Requested by you — another Super Admin must decide.</span>
                ) : (
                  <ActionForm action={decideStockAction} className="alt-repl-form">
                    <input type="hidden" name="id" value={r.id} />
                    <input name="comment" placeholder="Comment (required to reject)" aria-label="Comment" />
                    <div className="action-bar">
                      <SubmitButton name="decision" value="APPROVE">
                        Approve
                      </SubmitButton>
                      <SubmitButton name="decision" value="REJECT" className="btn btn-danger">
                        Reject
                      </SubmitButton>
                    </div>
                  </ActionForm>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="h-stock">
        <div className="card-head">
          <h2 id="h-stock">Stock by location</h2>
          {locId && (
            <Link className="small" href="/altphones/inventory">
              All locations
            </Link>
          )}
        </div>
        {shown.length === 0 ? (
          <p className="muted small">No stock recorded yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Location</th>
                  <th scope="col">Phone</th>
                  <th scope="col" className="num">Opening</th>
                  <th scope="col" className="num">Received</th>
                  <th scope="col" className="num">Physical</th>
                  <th scope="col" className="num">Reserved</th>
                  <th scope="col" className="num">Available</th>
                  <th scope="col" className="num">Sales</th>
                  <th scope="col" className="num">Credit</th>
                  <th scope="col" className="num">Remaining</th>
                  <th scope="col" className="num">IMEIs</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={`${r.location_id}-${r.model_id}`}>
                    <td>
                      <Link href={`/altphones/inventory?location=${r.location_id}`}>{r.location_name}</Link>
                      <div className="small muted">
                        {r.outlet_type === "BRANCH" ? "Branch" : "Shop"} · {r.city}
                      </div>
                    </td>
                    <td>{r.model_name}</td>
                    <td className="num">{n(r.opening)}</td>
                    <td className="num">{n(r.received)}</td>
                    <td className="num">{n(r.physical)}</td>
                    <td className="num">{n(r.reserved)}</td>
                    <td className="num">
                      <strong>{n(r.available)}</strong>
                    </td>
                    <td className="num">{n(r.sales)}</td>
                    <td className="num">{n(r.disbursements)}</td>
                    <td className={`num ${r.remaining !== r.physical ? "err" : ""}`} title={r.remaining !== r.physical ? "Ledger and balance differ" : undefined}>
                      {n(r.remaining)}
                    </td>
                    <td className="num">{n(r.imeis_in_stock)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ marginBottom: 0 }}>
          Available = physical − reserved. Remaining is recomputed from the ledger and always equals physical stock. Legacy adjustments are included.
        </p>
      </section>

      {locId && (
        <div className="grid-2 alt-reports">
          <section className="card" aria-labelledby="h-imei">
            <h2 id="h-imei">IMEI records</h2>
            {devices.length === 0 ? (
              <p className="muted small">No IMEIs registered here.</p>
            ) : (
              <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">IMEI</th>
                    <th scope="col">Phone</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((d) => (
                    <tr key={d.imei}>
                      <td className="mono">{d.imei}</td>
                      <td>{d.model}</td>
                      <td>
                        <span className={`badge ${d.status === "IN_STOCK" ? "badge-green" : d.status === "RESERVED" ? "badge-warn" : ""}`}>{d.status === "IN_STOCK" ? "In stock" : d.status === "RESERVED" ? "Reserved" : "Issued"}</span>
                        {d.legacy && <span className="badge badge-dark">Legacy</span>}
                        {d.app_id && (
                          <Link className="small mono" href={`/altphones/applications/${d.app_id}`}>
                            {" "}
                            {d.ref}
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </section>
          <section className="card" aria-labelledby="h-ledger">
            <h2 id="h-ledger">Stock ledger</h2>
            <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Movement</th>
                  <th scope="col" className="num">Physical</th>
                  <th scope="col" className="num">Reserved</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((g, i) => (
                  <tr key={i}>
                    <td className="small">
                      {formatLagos(g.occurred_at)}
                      <div className="muted">{g.actor ?? "System"}</div>
                    </td>
                    <td className="small">
                      {g.movement.replace("_", " ").toLowerCase()} · {g.model}
                      {g.legacy && <span className="badge badge-dark">Legacy</span>}
                      <div className="muted mono">{g.reference}</div>
                    </td>
                    <td className="num">{g.physical_delta > 0 ? `+${g.physical_delta}` : g.physical_delta}</td>
                    <td className="num">{g.reserved_delta > 0 ? `+${g.reserved_delta}` : g.reserved_delta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>
        </div>
      )}

      {access.pm && (
        <section className="card" aria-labelledby="h-req">
          <h2 id="h-req">Request stock</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            Opening stock and deliveries are added only after a Super Admin approves them.
          </p>
          <ActionForm action={replenishAction} className="stack" resetOnSuccess>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="locationId">Branch or Shop</label>
                <select id="locationId" name="locationId" required defaultValue={locId ?? ""}>
                  <option value="">Choose</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} ({l.outlet_type === "BRANCH" ? "Branch" : "Shop"}) — {l.city}, {l.state}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="modelId">Phone</label>
                <select id="modelId" name="modelId" required>
                  <option value="">Choose</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.active ? "" : " (inactive)"}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="kind">Type</label>
                <select id="kind" name="kind" defaultValue="RECEIPT">
                  <option value="RECEIPT">Stock received</option>
                  <option value="OPENING">Opening stock</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="quantity">Units</label>
                <input id="quantity" name="quantity" type="number" min={1} max={100000} required />
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label htmlFor="imeis">IMEIs (optional)</label>
                <textarea id="imeis" name="imeis" rows={3} className="mono" placeholder="One 15-digit IMEI per line" />
                <span className="hint">IMEIs not listed now can be captured at handover.</span>
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label htmlFor="reason">Source</label>
                <input id="reason" name="reason" required placeholder="Delivery note, supplier invoice or transfer reference" />
              </div>
            </div>
            <div className="action-bar">
              <SubmitButton>Send for approval</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}

      <section className="card" aria-labelledby="h-hist">
        <h2 id="h-hist">Stock requests</h2>
        {repl.length === 0 ? (
          <p className="muted small">None yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Request</th>
                  <th scope="col">Location</th>
                  <th scope="col" className="num">Units</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {repl.slice(0, 50).map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="mono">{r.ref}</span>
                      <div className="small muted">
                        {r.requested_by_name} · {formatLagos(r.requested_at)}
                      </div>
                    </td>
                    <td>
                      {r.location_name}
                      <div className="small muted">{r.model_name}</div>
                    </td>
                    <td className="num">{n(r.quantity)}</td>
                    <td>
                      <span className={`badge ${r.status === "APPROVED" ? "badge-green" : r.status === "REJECTED" ? "badge-red" : "badge-warn"}`}>{r.status === "PENDING" ? "Awaiting Super Admin" : r.status === "APPROVED" ? "Approved" : "Rejected"}</span>
                      {r.decided_by_name && (
                        <div className="small muted">
                          {r.decided_by_name}
                          {r.decision_comment ? ` — ${r.decision_comment}` : ""}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
