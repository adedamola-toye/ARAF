import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { ActionForm, SubmitButton } from "@/components/forms";
import { db } from "@/server/db";
import { formatLagos } from "@/server/time";
import { REGIONS } from "@/server/domain/roles";
import { BPM_ROLE } from "@/server/altphones/core";
import {
  addressRequests,
  bpmRequests,
  bpmStates,
  unroutedLocations,
  placeholderWaiting,
  placeholderBpm,
  PLACEHOLDER_BPM,
  type ImportSummary,
  importSources,
  listImports,
  locationAccess,
  locationMaster,
  recordedAddresses,
  TYPE_LABEL,
  unroutedStates,
} from "@/server/altphones/location-master";
import {
  applyProfilingAction,
  decideAddressAction,
  discardProfilingAction,
  linkSourceAction,
  previewProfilingAction,
  proposeLocationAction,
  requestAddressAction,
  decideBpmAction,
  rerouteAction,
  requestBpmAction,
} from "../actions";

export const metadata = { title: "Altphones locations" };

const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-NG");
const ADDRESS_BADGE: Record<string, [string, string]> = { REGISTERED: ["badge-green", "Registered"], MISSING: ["badge-red", "No address"], REVIEW: ["badge-warn", "Conflicting addresses"] };
const OUTCOME_LABEL: Record<string, string> = {
  REGISTERED: "Address registered",
  MISSING: "No address in the workbook",
  CONFLICT: "Different addresses for one location",
  KEPT_EXISTING: "Matches the registered address",
  DIFFERS_FROM_EXISTING: "Differs from the registered address",
};
type Tab = "locations" | "import" | "bpm" | "requests";

export default async function AltLocations({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { session } = await requireUser();
  const access = await locationAccess(db, session.staffId);
  if (!access.view) redirect("/altphones");
  const tabs: { key: Tab; label: string }[] = [
    { key: "locations", label: "Location master" },
    ...(access.manage ? [{ key: "import" as Tab, label: "Import profiling workbook" }, { key: "bpm" as Tab, label: "BPM mapping" }] : []),
    { key: "requests", label: "Approvals" },
  ];
  const tab: Tab = tabs.some((t) => t.key === sp.tab) ? (sp.tab as Tab) : access.manage ? "locations" : "requests";
  const pending = [...(await addressRequests(db, "PENDING")), ...(await bpmRequests(db, "PENDING"))];
  const [unrouted, waiting, ph] = await Promise.all([unroutedStates(db), placeholderWaiting(db), placeholderBpm(db)]);

  return (
    <>
      <PageHeader
        eyebrow="Altphones"
        title="Locations"
        intro="The location master: every Branch, Altshop and Altbox with its registered address and the Business Performance Manager for its state. Staff choose their operating location; ARAF supplies the address and the approval route."
      />
      {(unrouted.length > 0 || waiting.length > 0) && (
        <div className="alert alert-warn" role="status" style={{ marginBottom: "var(--space-4)" }}>
          <div>
            {unrouted.length > 0 && (
              <p style={{ margin: 0 }}>
                <strong>
                  Smile Associate sales from {n(unrouted.reduce((a, u) => a + u.locations, 0))} Altshops and Altboxes go to the {PLACEHOLDER_BPM}
                  {ph.id ? ` (${ph.name})` : " — not set yet, so they cannot be reviewed"}
                </strong>{" "}
                because no active Business Performance Manager is mapped: {unrouted.map((u) => `${u.state} (${u.locations})`).join(", ")}.
                {access.manage && (
                  <>
                    {" "}
                    Request a mapping under <Link href="?tab=bpm">BPM mapping</Link>; it takes effect when the Unit Head approves it.
                  </>
                )}
              </p>
            )}
            {waiting.length > 0 && (
              <p style={{ margin: unrouted.length ? "8px 0 0" : 0 }}>
                <strong>
                  {n(waiting.length)} application{waiting.length === 1 ? " is" : "s are"} at the BPM stage with the {PLACEHOLDER_BPM}
                </strong>{" "}
                ({waiting.slice(0, 5).map((w) => `${w.ref} · ${w.location ?? "?"}${w.holder ? "" : " · unassigned"}`).join("; ")}
                {waiting.length > 5 ? "; …" : ""}). Each moves to the location&apos;s BPM automatically when a mapping is approved.
              </p>
            )}
            {waiting.length > 0 && access.manage && (
              <ActionForm action={rerouteAction} className="inline-form">
                <SubmitButton className="btn btn-ghost btn-sm">Re-route waiting applications now</SubmitButton>
              </ActionForm>
            )}
          </div>
        </div>
      )}
      <nav className="tabs" aria-label="Locations">
        {tabs.map((t) => (
          <Link key={t.key} className="tab" href={`?tab=${t.key}`} aria-current={t.key === tab ? "page" : undefined}>
            {t.label}
            {t.key === "requests" && pending.length > 0 ? ` (${pending.length})` : ""}
          </Link>
        ))}
      </nav>
      {tab === "locations" && <Master sp={sp} canManage={access.manage} ph={ph} />}
      {tab === "import" && access.manage && <ImportTab sp={sp} />}
      {tab === "bpm" && access.manage && <BpmTab />}
      {tab === "requests" && <Requests me={session.staffId} canApprove={access.approve} />}
    </>
  );
}

async function Master({ sp, canManage, ph }: { sp: Record<string, string | undefined>; canManage: boolean; ph: { name: string | null } }) {
  const f = {
    state: (REGIONS as readonly string[]).includes(sp.state ?? "") ? sp.state! : "",
    type: ["BRANCH", "ALTSHOP", "ALTBOX"].includes(sp.type ?? "") ? sp.type! : "",
    address: ["REGISTERED", "MISSING", "REVIEW"].includes(sp.address ?? "") ? sp.address! : "",
    q: (sp.q ?? "").slice(0, 60),
  };
  const rows = await locationMaster(db, f);
  const all = await db.query<{ address_status: string; n: number }>("SELECT address_status, count(*)::int AS n FROM locations GROUP BY 1").then((r) => Object.fromEntries(r.rows.map((x) => [x.address_status, x.n])));
  const sel = sp.location ? rows.find((r) => r.id === sp.location) : null;
  const recorded = sel ? await recordedAddresses(db, sel.id) : [];
  return (
    <>
      <div className="metric-grid" style={{ marginBottom: "var(--space-4)" }}>
        {(
          [
            ["Registered addresses", n(all.REGISTERED)],
            ["No address", n(all.MISSING)],
            ["Conflicting addresses", n(all.REVIEW)],
          ] as [string, string][]
        ).map(([k, v]) => (
          <div key={k} className="metric">
            <div className="k">{k}</div>
            <div className="v">{v}</div>
          </div>
        ))}
      </div>

      {sel && canManage && (
        <section className="card action-panel" aria-labelledby="h-addr">
          <h2 id="h-addr">
            {sel.name} <span className="small muted">· {TYPE_LABEL[sel.outlet_type as keyof typeof TYPE_LABEL]} · {sel.state}</span>
          </h2>
          <p style={{ marginTop: 0 }}>
            <span className="loc-address-label">Registered address</span>
          </p>
          <p className="loc-address">{sel.address ?? <span className="muted">Not registered</span>}</p>
          {sel.pending_ref ? (
            <p className="small muted">Address request {sel.pending_ref} is awaiting the Unit Head.</p>
          ) : (
            <ActionForm action={requestAddressAction} className="stack" doneHref="/altphones/locations?tab=requests">
              <input type="hidden" name="locationId" value={sel.id} />
              {recorded.length > 0 && (
                <fieldset className="stack">
                  <legend className="small">Addresses recorded in the profiling workbook — choose the right one</legend>
                  {recorded.map((a, i) => (
                    <label key={i} className="check">
                      <input type="radio" name="choice" value={String(i)} /> {a}
                    </label>
                  ))}
                  <label className="check">
                    <input type="radio" name="choice" value="" defaultChecked={recorded.length === 0} /> None of these: register a different address below
                  </label>
                </fieldset>
              )}
              <div className="field">
                <label htmlFor="r-address">{recorded.length ? "Different address (only if none above is right)" : "Address to register"}</label>
                <textarea id="r-address" name="address" rows={2} />
                <span className="hint">The Unit Head approves it before it is used. Staff never type an address during a sale.</span>
              </div>
              <div className="field">
                <label htmlFor="r-note">Reason</label>
                <input id="r-note" name="note" placeholder="Why this is the right address" />
              </div>
              <div className="action-bar">
                <SubmitButton>Send to the Unit Head</SubmitButton>
                <Link href="?tab=locations" className="btn btn-ghost">
                  Close
                </Link>
              </div>
            </ActionForm>
          )}
        </section>
      )}

      <section className="card" aria-labelledby="h-master">
        <div className="card-head">
          <h2 id="h-master">Location master</h2>
          <span className="small muted">{n(rows.length)} shown</span>
        </div>
        <form className="filters" method="get">
          <input type="hidden" name="tab" value="locations" />
          <div className="field">
            <label htmlFor="m-q">Search</label>
            <input id="m-q" name="q" defaultValue={f.q} placeholder="Name or address" />
          </div>
          <div className="field">
            <label htmlFor="m-state">State</label>
            <select id="m-state" name="state" defaultValue={f.state}>
              <option value="">All states</option>
              {REGIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="m-type">Type</label>
            <select id="m-type" name="type" defaultValue={f.type}>
              <option value="">All types</option>
              <option value="BRANCH">Branch</option>
              <option value="ALTSHOP">Altshop</option>
              <option value="ALTBOX">Altbox</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="m-addr">Address</label>
            <select id="m-addr" name="address" defaultValue={f.address}>
              <option value="">Any</option>
              <option value="REGISTERED">Registered</option>
              <option value="MISSING">No address</option>
              <option value="REVIEW">Conflicting addresses</option>
            </select>
          </div>
          <button type="submit" className="btn">
            Filter
          </button>
          <Link href="?tab=locations" className="btn btn-ghost">
            Clear
          </Link>
        </form>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Location</th>
                <th scope="col">Type</th>
                <th scope="col">Registered address</th>
                <th scope="col">BPM (state)</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td>
                    <strong>{l.name}</strong>
                    <div className="small muted">
                      {l.state}
                      {l.source_name && l.source_name !== l.name ? ` · listed as ${l.source_name}` : ""}
                    </div>
                  </td>
                  <td>{TYPE_LABEL[l.outlet_type as keyof typeof TYPE_LABEL]}</td>
                  <td className="small" style={{ maxWidth: 360 }}>
                    {l.address ?? <span className="muted">—</span>}
                  </td>
                  <td className="small">{l.outlet_type === "BRANCH" ? <span className="muted">DO route: PM → Unit Head</span> : (l.bpm_name ? <>{l.bpm_name}{l.bpm_for_location && <div className="muted">for this location</div>}</> : (l.bpm_email ? <span className="text-danger">{PLACEHOLDER_BPM} ({l.bpm_email} not set up)</span> : <span className="text-danger">{PLACEHOLDER_BPM}{ph.name ? `: ${ph.name}` : " (not set)"}</span>))}</td>
                  <td>
                    <span className={`badge ${ADDRESS_BADGE[l.address_status][0]}`}>{ADDRESS_BADGE[l.address_status][1]}</span>
                    {!l.active && <div className="small muted">Inactive</div>}
                    {l.pending_ref && <div className="small muted">{l.pending_ref} pending</div>}
                    {canManage && (
                      <div>
                        <Link className="small" href={`?tab=locations&location=${l.id}`}>
                          {l.address_status === "REGISTERED" ? "Correct address" : "Register address"}
                        </Link>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {canManage && (
        <section className="card" aria-labelledby="h-new">
          <h2 id="h-new">Add a location</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            A new location stays inactive until the Unit Head approves its address. Use this only for a place that is not in the profiling workbook.
          </p>
          <ActionForm action={proposeLocationAction} className="stack" resetOnSuccess>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="n-state">State</label>
                <select id="n-state" name="state" required defaultValue="">
                  <option value="">Choose the state</option>
                  {REGIONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="n-type">Type</label>
                <select id="n-type" name="type" required defaultValue="">
                  <option value="">Choose the type</option>
                  <option value="BRANCH">Branch</option>
                  <option value="ALTSHOP">Altshop</option>
                  <option value="ALTBOX">Altbox</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="n-name">Location name</label>
              <input id="n-name" name="name" required />
            </div>
            <div className="field">
              <label htmlFor="n-address">Address to register</label>
              <textarea id="n-address" name="address" rows={2} required />
            </div>
            <div className="field">
              <label htmlFor="n-note">Note for the Unit Head (optional)</label>
              <input id="n-note" name="note" />
            </div>
            <div className="action-bar">
              <SubmitButton>Propose location</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}
    </>
  );
}

async function ImportTab({ sp }: { sp: Record<string, string | undefined> }) {
  const imports = await listImports(db);
  const open = imports.find((i) => i.status === "PREVIEW");
  const f = { type: ["BRANCH", "ALTSHOP", "ALTBOX"].includes(sp.type ?? "") ? sp.type! : "", outcome: sp.outcome === "all" ? "" : (sp.outcome ?? "attention") };
  const sources = open ? await importSources(db, open.id, f) : [];
  const summary = open?.summary as ImportSummary | undefined;
  const locs = open ? (await db.query<{ id: string; name: string; state: string; outlet_type: string }>("SELECT id, name, state, outlet_type FROM locations ORDER BY state, name")).rows : [];
  return (
    <>
      {!open && (
        <section className="card" aria-labelledby="h-up">
          <h2 id="h-up">Upload the profiling workbook</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            Sheets for Delight Officers (Branches), Altbox and Altshop Smile Associates, and BPMs. Only each location&apos;s name, state and address are read, plus the BPM sheet&apos;s email and mapped states. No staff profile is created or changed.
            Nothing changes until you review the reconciliation and apply it.
          </p>
          <ActionForm action={previewProfilingAction} encType="multipart/form-data" className="filters">
            <div className="field">
              <label htmlFor="pf">Workbook (.xlsx)</label>
              <input id="pf" name="file" type="file" accept=".xlsx" required />
            </div>
            <SubmitButton>Upload and reconcile</SubmitButton>
          </ActionForm>
        </section>
      )}
      {open && summary && (
        <section className="card action-panel" aria-labelledby="h-rec">
          <h2 id="h-rec">
            Reconciliation <span className="mono small">{open.ref}</span>
          </h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            {open.filename} · uploaded by {open.created_by_name} on {formatLagos(open.created_at)}
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col" className="num">
                    Locations
                  </th>
                  <th scope="col" className="num">
                    Matched
                  </th>
                  <th scope="col" className="num">
                    New
                  </th>
                  <th scope="col" className="num">
                    Address registered
                  </th>
                  <th scope="col" className="num">
                    No address
                  </th>
                  <th scope="col" className="num">
                    Conflicting
                  </th>
                  <th scope="col" className="num">
                    To check
                  </th>
                </tr>
              </thead>
              <tbody>
                {summary.byType.map((t) => (
                  <tr key={t.type}>
                    <td>{TYPE_LABEL[t.type]}</td>
                    <td className="num">{n(t.entries)}</td>
                    <td className="num">{n(t.matched)}</td>
                    <td className="num">{n(t.new)}</td>
                    <td className="num">{n(t.registered)}</td>
                    <td className="num">{n(t.missing)}</td>
                    <td className="num">{n(t.conflict + t.differs)}</td>
                    <td className="num">{n(t.typeConflicts + t.unknownState)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 style={{ marginTop: "var(--space-5)" }}>Business Performance Managers</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">States</th>
                  <th scope="col">In ARAF</th>
                </tr>
              </thead>
              <tbody>
                {summary.bpms.map((b) => (
                  <tr key={b.email}>
                    <td className="mono small">{b.email}</td>
                    <td className="small">
                      {b.states.join(", ")}
                      {b.unknown.length > 0 && <div className="text-danger">Not recognised: {b.unknown.join(", ")}</div>}
                    </td>
                    <td className="small">{b.ready ? <span className="badge badge-green">{b.staff}</span> : <span className="text-danger">{b.problem}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {summary.statesWithoutBpm.length > 0 && (
            <p className="small">
              <strong>States with Altshops or Altboxes but no BPM in the workbook:</strong> {summary.statesWithoutBpm.join(", ")}. Smile Associate sales there cannot be submitted until a BPM is mapped.
            </p>
          )}
          <div className="action-bar">
            <ActionForm action={applyProfilingAction} className="inline-form" doneHref="/altphones/locations?tab=locations">
              <input type="hidden" name="importId" value={open.id} />
              <SubmitButton>Apply to the location master</SubmitButton>
            </ActionForm>
            <ActionForm action={discardProfilingAction} className="inline-form">
              <input type="hidden" name="importId" value={open.id} />
              <SubmitButton className="btn btn-ghost">Discard</SubmitButton>
            </ActionForm>
          </div>
        </section>
      )}
      {open && (
        <section className="card" aria-labelledby="h-src">
          <div className="card-head">
            <h2 id="h-src">Workbook entries</h2>
            <span className="small muted">{n(sources.length)} shown</span>
          </div>
          <form className="filters" method="get">
            <input type="hidden" name="tab" value="import" />
            <div className="field">
              <label htmlFor="s-type">Type</label>
              <select id="s-type" name="type" defaultValue={f.type}>
                <option value="">All types</option>
                <option value="BRANCH">Branch</option>
                <option value="ALTSHOP">Altshop</option>
                <option value="ALTBOX">Altbox</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="s-out">Show</label>
              <select id="s-out" name="outcome" defaultValue={sp.outcome ?? "attention"}>
                <option value="attention">Needs attention</option>
                <option value="all">All entries</option>
                <option value="NEW">New locations</option>
                <option value="MATCHED">Matched</option>
                <option value="MISSING">No address</option>
                <option value="CONFLICT">Conflicting addresses</option>
              </select>
            </div>
            <button type="submit" className="btn">
              Filter
            </button>
          </form>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">In the workbook</th>
                  <th scope="col">Address(es) as written</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Link to an existing location</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.source_name}</strong>
                      <div className="small muted">
                        {TYPE_LABEL[s.location_type as keyof typeof TYPE_LABEL]} · {s.source_state}
                        {s.state && s.state !== s.source_state ? ` → ${s.state}` : ""} · {s.rows} row{s.rows === 1 ? "" : "s"}
                      </div>
                      {(s.labels as { state: string; name: string }[]).length > 1 && <div className="small muted">Also listed as {(s.labels as { state: string; name: string }[]).slice(1).map((l) => `${l.state} / ${l.name}`).join("; ")}</div>}
                    </td>
                    <td className="small" style={{ maxWidth: 320 }}>
                      {(s.addresses as string[]).length ? (s.addresses as string[]).map((a, i) => <div key={i}>{a}</div>) : <span className="muted">None</span>}
                    </td>
                    <td className="small">
                      {s.outcome === "MATCHED" ? <span className="badge badge-green">Matches {s.location_name}</span> : s.outcome === "NEW" ? <span className="badge badge-blue">New location</span> : <span className="badge badge-red">State not recognised</span>}
                      <div>{OUTCOME_LABEL[s.address_outcome]}</div>
                      {s.type_conflict && s.type_conflict !== "linked by hand" && <div className="text-danger">{s.type_conflict}</div>}
                      {s.type_conflict === "linked by hand" && <div className="muted">Linked by hand</div>}
                    </td>
                    <td>
                      <ActionForm action={linkSourceAction} className="inline-form">
                        <input type="hidden" name="sourceId" value={s.id} />
                        <select name="locationId" defaultValue={s.location_id ?? ""} aria-label={`Existing location for ${s.source_name}`} style={{ maxWidth: 240 }}>
                          <option value="">Create as a new location</option>
                          {locs
                            .filter((l) => l.state === s.state)
                            .map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.name} ({TYPE_LABEL[l.outlet_type as keyof typeof TYPE_LABEL]})
                              </option>
                            ))}
                        </select>
                        <SubmitButton className="btn btn-ghost btn-sm">Save</SubmitButton>
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="card" aria-labelledby="h-hist">
        <h2 id="h-hist">Imports</h2>
        {imports.length === 0 ? (
          <p className="muted">No profiling workbook has been imported yet.</p>
        ) : (
          <ul className="plain-list">
            {imports.map((i) => (
              <li key={i.id}>
                <span className="mono">{i.ref}</span> · {i.filename} · {i.status === "APPLIED" ? `applied by ${i.applied_by_name} on ${formatLagos(i.applied_at)}` : i.status === "PREVIEW" ? "being reviewed" : "discarded"}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

async function BpmTab() {
  const [map, pending, uncovered] = await Promise.all([bpmStates(db), bpmRequests(db, "PENDING"), unroutedLocations(db)]);
  const locMaps = (
    await db.query(
      `SELECT l.name, l.state, l.outlet_type, m.bpm_email, s.full_name FROM altphones_bpm_locations m JOIN locations l ON l.id = m.location_id
         LEFT JOIN staff s ON lower(s.email) = m.bpm_email AND s.status = 'ACTIVE' ORDER BY l.state, l.name`,
    )
  ).rows;
  const saLocations = (await db.query<{ id: string; name: string; state: string; outlet_type: string }>("SELECT id, name, state, outlet_type FROM locations WHERE active AND outlet_type IN ('ALTSHOP','ALTBOX') ORDER BY state, name")).rows;
  const bpms = (await db.query<{ email: string; full_name: string }>("SELECT DISTINCT s.email, s.full_name FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.role = $1 AND ra.active WHERE s.status = 'ACTIVE' ORDER BY s.full_name", [BPM_ROLE])).rows;
  const uncoveredIds = new Set(uncovered.map((u) => u.id));
  const ph = await placeholderBpm(db);
  const phPending = pending.find((r) => r.scope === "PLACEHOLDER");
  return (
    <>
      <section className="card action-panel" aria-labelledby="h-ph">
        <h2 id="h-ph">{PLACEHOLDER_BPM}</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          Reviews Smile Associate sales from Altshops and Altboxes that have no BPM mapped, until the right BPM is mapped to the location. Any active @altbank.ng staff member with the Business Performance Manager role can hold it. The Unit Head approves the choice.
        </p>
        <p>
          <strong>Now:</strong> {ph.id ? `${ph.name} (${ph.email})` : ph.email ? <span className="text-danger">{ph.problem}</span> : <span className="text-danger">Not set — sales from unmapped locations wait unassigned.</span>}
          {phPending && (
            <span className="small muted">
              {" "}
              · {phPending.ref} to change it to {phPending.bpm_name ?? phPending.bpm_email ?? "nobody"} is awaiting the Unit Head
            </span>
          )}
        </p>
        <ActionForm action={requestBpmAction} className="filters" resetOnSuccess>
          <input type="hidden" name="scope" value="PLACEHOLDER" />
          <div className="field">
            <label htmlFor="ph-bpm">Placeholder BPM</label>
            <select id="ph-bpm" name="email" defaultValue="" required>
              <option value="">Choose the person</option>
              {bpms
                .filter((b) => b.email.endsWith("@altbank.ng"))
                .map((b) => (
                  <option key={b.email} value={b.email}>
                    {b.full_name} — {b.email}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ph-note">Reason</label>
            <input id="ph-note" name="note" required placeholder="For example: covers unmapped locations until BPMs are assigned" />
          </div>
          <SubmitButton>Send to the Unit Head</SubmitButton>
        </ActionForm>
      </section>

      <section className="card action-panel" aria-labelledby="h-bpmreq">
        <h2 id="h-bpmreq">Request a BPM mapping</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          Smile Associate sales are reviewed by the BPM for the Altshop or Altbox they are sold from, then the Product Manager and the Unit Head. Map a whole state, or one location (a location mapping takes precedence over its state&apos;s). The mapping takes effect when the Unit Head approves it.
          {uncovered.length > 0 && <> {n(uncovered.length)} active Altshops and Altboxes are not routed to a BPM yet; they are listed first below.</>}
        </p>
        <ActionForm action={requestBpmAction} className="stack" resetOnSuccess>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="bq-scope">Map</label>
              <select id="bq-scope" name="scope" defaultValue="STATE" required>
                <option value="STATE">A whole state</option>
                <option value="LOCATION">One location</option>
              </select>
              <span className="hint">Choose the state for a state mapping, or the location for a location mapping.</span>
            </div>
            <div className="field">
              <label htmlFor="bq-bpm">Business Performance Manager</label>
              <select id="bq-bpm" name="email" defaultValue="" required>
                <option value="">Choose the BPM</option>
                {bpms.map((b) => (
                  <option key={b.email} value={b.email}>
                    {b.full_name} — {b.email}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="bq-state">State</label>
              <select id="bq-state" name="state" defaultValue="">
                <option value="">—</option>
                {REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="bq-loc">Location</label>
              <select id="bq-loc" name="locationId" defaultValue="">
                <option value="">—</option>
                {[...saLocations.filter((l) => uncoveredIds.has(l.id)), ...saLocations.filter((l) => !uncoveredIds.has(l.id))].map((l) => (
                  <option key={l.id} value={l.id}>
                    {uncoveredIds.has(l.id) ? "Not routed · " : ""}
                    {l.name} — {TYPE_LABEL[l.outlet_type as keyof typeof TYPE_LABEL]}, {l.state}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="bq-note">Reason</label>
            <input id="bq-note" name="note" required placeholder="For example: covers the North Central region from December" />
          </div>
          <div className="action-bar">
            <SubmitButton>Send to the Unit Head</SubmitButton>
          </div>
        </ActionForm>
        {pending.length > 0 && (
          <>
            <h3 style={{ marginTop: "var(--space-5)" }}>Awaiting the Unit Head</h3>
            <ul className="plain-list">
              {pending.map((r) => (
                <li key={r.id} className="small">
                  <span className="mono">{r.ref}</span> · {r.scope === "PLACEHOLDER" ? PLACEHOLDER_BPM : r.scope === "STATE" ? `all of ${r.state}` : `${r.location_name} (${r.state})`} → {r.bpm_name ?? r.bpm_email ?? "remove mapping"} · {r.requested_by_name}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="h-bpm">
        <h2 id="h-bpm">Mapped states</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">State</th>
                <th scope="col">BPM</th>
                <th scope="col" className="num">
                  Altshops and Altboxes
                </th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {map.map((m) => (
                <tr key={m.state}>
                  <td>{m.state}</td>
                  <td className="small">
                    {m.full_name && m.has_role ? m.full_name : <span className="text-danger">{m.full_name ? `${m.full_name} has no BPM role` : `${m.bpm_email} is not set up in ARAF`}</span>}
                    <div className="mono muted">{m.bpm_email}</div>
                  </td>
                  <td className="num">{n(m.sa_locations)}</td>
                  <td className="small">{m.source === "MANUAL" ? "Approved mapping" : "Profiling workbook"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {locMaps.length > 0 && (
          <>
            <h3 style={{ marginTop: "var(--space-5)" }}>Mapped locations</h3>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Location</th>
                    <th scope="col">BPM</th>
                  </tr>
                </thead>
                <tbody>
                  {locMaps.map((m) => (
                    <tr key={m.name + m.state}>
                      <td>
                        {m.name}
                        <div className="small muted">
                          {TYPE_LABEL[m.outlet_type as keyof typeof TYPE_LABEL]} · {m.state}
                        </div>
                      </td>
                      <td className="small">
                        {m.full_name ?? <span className="text-danger">not set up in ARAF</span>}
                        <div className="mono muted">{m.bpm_email}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </>
  );
}

async function Requests({ me, canApprove }: { me: string; canApprove: boolean }) {
  const [pending, recent, bpmPending] = await Promise.all([addressRequests(db, "PENDING"), addressRequests(db, "ALL"), bpmRequests(db, "PENDING")]);
  const done = recent.filter((r) => r.status !== "PENDING").slice(0, 30);
  return (
    <>
      <section className="card action-panel" aria-labelledby="h-bpmpend">
        <h2 id="h-bpmpend">BPM mappings awaiting the Unit Head</h2>
        {bpmPending.length === 0 ? (
          <p className="muted">No BPM mapping requests are waiting.</p>
        ) : (
          <div className="stack">
            {bpmPending.map((r) => (
              <div key={r.id} className="alt-repl">
                <div>
                  <strong>{r.scope === "PLACEHOLDER" ? `${PLACEHOLDER_BPM} (Altshops and Altboxes with no BPM mapped)` : r.scope === "STATE" ? `All Altshops and Altboxes in ${r.state}` : `${r.location_name} (${TYPE_LABEL[r.outlet_type as keyof typeof TYPE_LABEL]}, ${r.state})`}</strong>
                  <div>→ {r.bpm_email ? `${r.bpm_name ?? "?"} (${r.bpm_email})` : "remove the mapping"}</div>
                  <div className="small muted">
                    <span className="mono">{r.ref}</span> · {r.requested_by_name} · {formatLagos(r.requested_at)}
                  </div>
                  {r.note && <div className="small">Reason: {r.note}</div>}
                </div>
                {!canApprove ? (
                  <span className="small muted">Waiting for the Unit Head.</span>
                ) : r.requested_by === me ? (
                  <span className="small muted">You requested this — another approver must decide.</span>
                ) : (
                  <ActionForm action={decideBpmAction} className="alt-repl-form">
                    <input type="hidden" name="id" value={r.id} />
                    <input name="note" placeholder="Comment (required to reject)" aria-label="Comment" />
                    <div className="action-bar">
                      <SubmitButton name="decision" value="APPROVE">
                        Approve mapping
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
        )}
      </section>
      <section className="card action-panel" aria-labelledby="h-pend">
        <h2 id="h-pend">Addresses awaiting the Unit Head</h2>
        {pending.length === 0 ? (
          <p className="muted">No address requests are waiting.</p>
        ) : (
          <div className="stack">
            {pending.map((r) => (
              <div key={r.id} className="alt-repl">
                <div>
                  <strong>{r.location_name}</strong> <span className="small muted">· {TYPE_LABEL[r.outlet_type as keyof typeof TYPE_LABEL]} · {r.state}</span>
                  <div className="small muted">
                    <span className="mono">{r.ref}</span> ·{" "}
                    {{ NEW_LOCATION: "New location (activated on approval)", MISSING_ADDRESS: "Missing address", CONFLICT_CHOICE: "Choice between recorded addresses", CORRECTION: "Correction" }[r.basis as string]} · {r.requested_by_name} · {formatLagos(r.requested_at)}
                  </div>
                  <p className="loc-address" style={{ margin: "6px 0" }}>
                    {r.address}
                  </p>
                  {r.current_address && r.current_address !== r.address && <div className="small muted">Currently registered: {r.current_address}</div>}
                  {r.note && <div className="small">Reason: {r.note}</div>}
                </div>
                {!canApprove ? (
                  <span className="small muted">Waiting for the Unit Head.</span>
                ) : r.requested_by === me ? (
                  <span className="small muted">You requested this — another approver must decide.</span>
                ) : (
                  <ActionForm action={decideAddressAction} className="alt-repl-form">
                    <input type="hidden" name="id" value={r.id} />
                    <input name="note" placeholder="Comment (required to reject)" aria-label="Comment" />
                    <div className="action-bar">
                      <SubmitButton name="decision" value="APPROVE">
                        Approve address
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
        )}
      </section>
      {done.length > 0 && (
        <section className="card" aria-labelledby="h-done">
          <h2 id="h-done">Decided</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Request</th>
                  <th scope="col">Location</th>
                  <th scope="col">Address</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {done.map((r) => (
                  <tr key={r.id}>
                    <td className="mono small">{r.ref}</td>
                    <td>{r.location_name}</td>
                    <td className="small">{r.address}</td>
                    <td className="small">
                      <span className={`badge ${r.status === "APPROVED" ? "badge-green" : "badge-red"}`}>{r.status === "APPROVED" ? "Approved" : "Rejected"}</span>
                      <div className="muted">
                        {r.decided_by_name} · {formatLagos(r.decided_at)}
                      </div>
                      {r.decision_note && <div>{r.decision_note}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
