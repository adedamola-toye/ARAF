import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { ActionForm, SubmitButton } from "@/components/forms";
import { db } from "@/server/db";
import { formatLagos } from "@/server/time";
import { altphonesAccess, pendingReplenishments } from "@/server/altphones/views";
import { listStockCounts, locationStock, poolModelId, stockOverview } from "@/server/altphones/stock";
import { REGIONS } from "@/server/domain/roles";
import { listModels } from "@/server/altphones/catalogue";
import { isUuid } from "@/server/altphones/core";
import { decideStockAction, decideStockCountAction, replenishAction, stockCountAction } from "../actions";

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
  const f = { state: (REGIONS as readonly string[]).includes(sp.state ?? "") ? sp.state! : "", type: ["BRANCH", "ALTSHOP"].includes(sp.type ?? "") ? sp.type! : "", stock: ["zero", "instock"].includes(sp.stock ?? "") ? sp.stock! : "", q: (sp.q ?? "").slice(0, 60) };
  const [locRows, allLocs, counts, pool] = await Promise.all([locId ? Promise.resolve([]) : locationStock(db, f), locationStock(db), listStockCounts(db, { locationId: locId }), poolModelId(db)]);
  const pendingCounts = counts.filter((c) => c.status === "SUBMITTED");
  const poolName = pool ? ((await db.query<{ name: string }>("SELECT name FROM altphones_models WHERE id = $1", [pool])).rows[0]?.name ?? null) : null;
  const requestModels = [...models.map((m) => ({ id: m.id, name: m.name + (m.active ? "" : " (inactive)") })), ...(pool && poolName ? [{ id: pool, name: poolName }] : [])];
  // Count lines: every phone held here, plus colour-not-recorded units, plus the catalogue colours.
  const countLines = locId
    ? [...new Map([...shown.map((r) => [r.model_id, { id: r.model_id, name: r.model_name, physical: r.physical, reserved: r.reserved }] as const), ...(pool && poolName ? [[pool, { id: pool, name: poolName, physical: 0, reserved: 0 }] as const] : []), ...models.filter((m) => m.active).map((m) => [m.id, { id: m.id, name: m.name, physical: 0, reserved: 0 }] as const)].reverse()).values()].reverse()
    : [];
  const filtered = !!(f.state || f.type || f.stock || f.q);
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
            ["Locations (Branches and Shops)", n(allLocs.length)],
            ["Locations with no stock", n(allLocs.filter((l) => l.physical === 0).length)],
            ["Awaiting approval", n(pending.length + pendingCounts.length)],
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

      {access.admin && pendingCounts.length > 0 && (
        <section className="card action-panel" aria-labelledby="h-cnt-appr">
          <h2 id="h-cnt-appr">Stock counts awaiting approval</h2>
          <div className="stack">
            {pendingCounts.map((c) => (
              <div key={c.id} className="alt-repl">
                <div>
                  <strong>{c.location_name}</strong> — counted {c.counted_on}
                  <div className="small muted">
                    <span className="mono">{c.ref}</span> · {c.submitted_by_name} · {formatLagos(c.submitted_at)}
                  </div>
                  <div className="small">
                    {c.lines.map((l) => `${l.model}: ${l.counted} counted (ledger ${l.system}${l.counted !== l.system ? `, ${l.counted - l.system > 0 ? "+" : ""}${l.counted - l.system}` : ""})`).join(" · ")}
                  </div>
                  {c.note && <div className="small muted">{c.note}</div>}
                </div>
                {c.submitted_by === session.staffId ? (
                  <span className="small muted">Counted by you — another Super Admin must decide.</span>
                ) : (
                  <ActionForm action={decideStockCountAction} className="alt-repl-form">
                    <input type="hidden" name="id" value={c.id} />
                    <input name="comment" placeholder="Comment (required to reject)" aria-label="Comment" />
                    <div className="action-bar">
                      <SubmitButton name="decision" value="APPROVE">
                        Approve count
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

      {!locId && (
        <section className="card" aria-labelledby="h-locs">
          <div className="card-head">
            <h2 id="h-locs">Locations</h2>
            <span className="small muted">
              {n(locRows.length)} shown · {n(locRows.reduce((a, l) => a + l.physical, 0))} units
            </span>
          </div>
          <form className="filters" method="get">
            <div className="field">
              <label htmlFor="f-q">Search</label>
              <input id="f-q" name="q" type="search" defaultValue={f.q} placeholder="Location or city" />
            </div>
            <div className="field">
              <label htmlFor="f-state">State</label>
              <select id="f-state" name="state" defaultValue={f.state}>
                <option value="">All states</option>
                {[...new Set(allLocs.map((l) => l.state))].sort().map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-type">Type</label>
              <select id="f-type" name="type" defaultValue={f.type}>
                <option value="">Branches and Shops</option>
                <option value="BRANCH">Branches</option>
                <option value="ALTSHOP">Shops</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-stock">Stock</label>
              <select id="f-stock" name="stock" defaultValue={f.stock}>
                <option value="">Any</option>
                <option value="instock">In stock</option>
                <option value="zero">No stock</option>
              </select>
            </div>
            <button className="btn">Filter</button>
            {filtered && (
              <Link className="btn btn-ghost" href="/altphones/inventory">
                Clear
              </Link>
            )}
          </form>
          {locRows.length === 0 ? (
            <p className="muted small">No locations match.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Location</th>
                    <th scope="col">State</th>
                    <th scope="col">Type</th>
                    <th scope="col" className="num">
                      Physical
                    </th>
                    <th scope="col" className="num">
                      Reserved
                    </th>
                    <th scope="col" className="num">
                      Available
                    </th>
                    <th scope="col">Last count</th>
                  </tr>
                </thead>
                <tbody>
                  {locRows.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <Link href={`/altphones/inventory?location=${l.id}`}>{l.name}</Link>
                        {l.source_name && l.source_name !== l.name && <div className="small muted">Listed as {l.source_name}</div>}
                      </td>
                      <td>
                        {l.state}
                        {l.source_state && l.source_state.toUpperCase() !== l.state && <div className="small muted">Listed as {l.source_state}</div>}
                      </td>
                      <td>
                        {l.outlet_type === "BRANCH" ? "Branch" : "Shop"}
                        {l.source_type && !["BRANCH", "ALTSHOP", "SHOP"].includes(l.source_type.toUpperCase()) && <div className="small muted">Listed as {l.source_type}</div>}
                      </td>
                      <td className="num">{l.physical === 0 ? <span className="muted">0</span> : n(l.physical)}</td>
                      <td className="num">{n(l.reserved)}</td>
                      <td className="num">
                        <strong>{n(l.available)}</strong>
                      </td>
                      <td className="small">{l.last_count ?? <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {locId && (access.pm || access.admin) && (
        <section className="card" aria-labelledby="h-count">
          <h2 id="h-count">Record a stock count</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            Enter what is physically on the shelf. Nothing changes until another Super Admin approves; the difference to the ledger is then posted as a count adjustment. Leave a phone blank to skip it.
          </p>
          <ActionForm action={stockCountAction} className="stack" resetOnSuccess>
            <input type="hidden" name="locationId" value={locId} />
            <div className="grid-2">
              <div className="field">
                <label htmlFor="countedOn">Date counted</label>
                <input id="countedOn" name="countedOn" type="date" required defaultValue={new Date(Date.now() + 3600_000).toISOString().slice(0, 10)} />
              </div>
              <div className="field">
                <label htmlFor="cnote">Note (optional)</label>
                <input id="cnote" name="note" placeholder="Who counted, anything unusual" />
              </div>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Phone</th>
                    <th scope="col" className="num">
                      Ledger now
                    </th>
                    <th scope="col" className="num">
                      Reserved
                    </th>
                    <th scope="col">Counted</th>
                  </tr>
                </thead>
                <tbody>
                  {countLines.map((m) => (
                    <tr key={m.id}>
                      <td>{m.name}</td>
                      <td className="num">{n(m.physical)}</td>
                      <td className="num">{n(m.reserved)}</td>
                      <td>
                        <input name={`count_${m.id}`} type="number" min={m.reserved} max={100000} inputMode="numeric" aria-label={`Units of ${m.name} counted`} style={{ maxWidth: 120 }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="action-bar">
              <SubmitButton>Send count for approval</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}

      <section className="card" aria-labelledby="h-stock" hidden={!locId}>
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
                  {requestModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
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
                <textarea id="imeis" name="imeis" rows={3} className="mono" placeholder="One 15-digit IMEI per line (each is checked, including its check digit)" />
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

      {counts.length > 0 && (
        <section className="card" aria-labelledby="h-counts">
          <h2 id="h-counts">Stock counts</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Count</th>
                  <th scope="col">Location</th>
                  <th scope="col" className="num">
                    Counted
                  </th>
                  <th scope="col" className="num">
                    Difference
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {counts.slice(0, 50).map((c) => {
                  const counted = c.lines.reduce((a, l) => a + l.counted, 0);
                  const diff = c.lines.reduce((a, l) => a + l.counted - l.system, 0);
                  return (
                    <tr key={c.id}>
                      <td>
                        <span className="mono">{c.ref}</span>
                        <div className="small muted">
                          {c.counted_on} · {c.submitted_by_name}
                        </div>
                      </td>
                      <td>{c.location_name}</td>
                      <td className="num">{n(counted)}</td>
                      <td className="num">{diff === 0 ? "—" : `${diff > 0 ? "+" : ""}${diff}`}</td>
                      <td>
                        <span className={`badge ${c.status === "APPROVED" ? "badge-green" : c.status === "REJECTED" ? "badge-red" : "badge-warn"}`}>{c.status === "SUBMITTED" ? "Awaiting Super Admin" : c.status === "APPROVED" ? "Approved" : "Rejected"}</span>
                        {c.decided_by_name && (
                          <div className="small muted">
                            {c.decided_by_name}
                            {c.decision_note ? ` — ${c.decision_note}` : ""}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
