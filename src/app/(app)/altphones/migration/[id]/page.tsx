import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "../../../../_lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { ActionForm, SubmitButton } from "@/components/forms";
import { db } from "@/server/db";
import { formatLagos } from "@/server/time";
import { CLASSIFICATION_LABEL, type Classification, getBatch, listRecords, locationLabels, migrationAccess, type Reconciliation, reconciliation, referrerLabels } from "@/server/altphones/migration";
import { decideBatchAction, decideMatchingAction, decideRecordAction, discardBatchAction, mapLocationsAction, mapReferrersAction, setAsAtAction, submitBatchAction } from "../../actions";
import { CLASS_BADGE, ISSUE_LABEL, STATUS_BADGE, STATUS_LABEL } from "../labels";

export const metadata = { title: "Migration batch" };

const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-NG");
const naira = (kobo: unknown) => (kobo === null || kobo === undefined ? "—" : `₦${(Number(kobo) / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`);
const STATUSES: Classification[] = ["CURRENT", "IN_ARREARS", "NOT_STARTED", "COMPLETED", "CANCELLED", "NEEDS_REVIEW"];
type Issue = { code: string; level: "BLOCK" | "WARN"; message: string };

export default async function MigrationBatch({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const { session } = await requireUser();
  const access = await migrationAccess(db, session.staffId);
  if (!access.view) redirect("/altphones");
  const b = await getBatch(db, id);
  if (!b) notFound();
  const editable = b.status === "DRAFT" && access.prepare;
  const canDecide = b.status === "SUBMITTED" && access.approve && b.prepared_by !== session.staffId && b.submitted_by !== session.staffId;
  const f = { sheet: sp.sheet ?? "", status: STATUSES.includes(sp.status as Classification) ? sp.status! : "", issue: sp.issue ?? "", decision: ["INCLUDE", "EXCLUDE", "NONE"].includes(sp.decision ?? "") ? sp.decision! : "", q: (sp.q ?? "").slice(0, 60), page: Math.max(1, Number(sp.page) || 1) };
  const live = b.status === "DRAFT" || b.status === "SUBMITTED";
  const [rec, records, locLabels, refLabels, locations, staff] = await Promise.all([
    live ? reconciliation(db, b.id) : Promise.resolve(b.summary as Reconciliation),
    listRecords(db, b.id, f),
    editable ? locationLabels(db, b.id) : Promise.resolve([]),
    editable ? referrerLabels(db, b.id) : Promise.resolve([]),
    editable ? db.query<{ id: string; name: string; state: string; outlet_type: string }>("SELECT id, name, state, outlet_type FROM locations WHERE active ORDER BY state, name").then((r) => r.rows) : Promise.resolve([]),
    editable ? db.query<{ id: string; full_name: string; email: string }>("SELECT id, full_name, email FROM staff WHERE status = 'ACTIVE' ORDER BY full_name").then((r) => r.rows) : Promise.resolve([]),
  ]);
  const qs = (over: Record<string, string | number>) => {
    const p = new URLSearchParams(Object.entries({ ...f, page: 1, ...over }).filter(([, v]) => v !== "" && v !== 1 && v !== "1") as [string, string][]);
    if (over.page && Number(over.page) > 1) p.set("page", String(over.page));
    const s = p.toString();
    return `/altphones/migration/${b.id}${s ? `?${s}` : ""}#records`;
  };
  const filtered = Boolean(f.sheet || f.status || f.issue || f.q);
  const undecided = editable && filtered && f.decision !== "INCLUDE" && f.decision !== "EXCLUDE" ? (await listRecords(db, b.id, { ...f, decision: "NONE", page: 1 })).total : 0;
  const sheets = rec?.sheets ?? [];
  const unmappedLocs = locLabels.filter((l) => !l.location_id);
  const unmappedRefs = refLabels.filter((l) => !l.staff_id);

  return (
    <>
      <PageHeader
        eyebrow="Altphones · Historical migration"
        title={
          <>
            <span className="mono">{b.ref}</span> <span className={`badge ${STATUS_BADGE[b.status]}`}>{STATUS_LABEL[b.status]}</span>
          </>
        }
        intro={`${b.filename} · register correct as at ${b.as_at_text} · prepared by ${b.prepared_by_name} on ${formatLagos(b.prepared_at)}${b.submitted_by_name ? ` · submitted by ${b.submitted_by_name}` : ""}${b.decided_by_name ? ` · ${b.status === "PUBLISHED" ? "approved" : "decided"} by ${b.decided_by_name} on ${formatLagos(b.decided_at)}` : ""}`}
        crumbs={[{ href: "/altphones/migration", label: "Historical migration" }, { label: b.ref }]}
      />

      {b.returned_note && b.status === "DRAFT" && (
        <div className="alert alert-warn" role="status" style={{ marginBottom: "var(--space-4)" }}>
          <strong>Returned by the Unit Head:</strong> {b.returned_note}
        </div>
      )}
      {b.status === "PUBLISHED" && (
        <div className="alert alert-success" role="status" style={{ marginBottom: "var(--space-4)" }}>
          Published as verified historical accounts. {b.decision_note ? `Unit Head's note: ${b.decision_note}` : ""}
        </div>
      )}

      {rec && (
        <div className="metric-grid" style={{ marginBottom: "var(--space-4)" }}>
          {(
            [
              ["Records read", n(rec.records)],
              ["Phones", n(rec.units)],
              [b.status === "PUBLISHED" ? "Published" : "To publish", n(rec.included)],
              ["Excluded", n(rec.excluded)],
              ["Need a decision", n(rec.blockedOpen)],
              ["Arrears (register)", naira(rec.money.arrearsKobo)],
            ] as [string, string][]
          ).map(([k, v]) => (
            <div key={k} className="metric">
              <div className="k">{k}</div>
              <div className="v">{v}</div>
            </div>
          ))}
        </div>
      )}

      {rec && (
        <section className="card" aria-labelledby="h-rec">
          <h2 id="h-rec">Reconciliation</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            Every row read from the workbook is staged; sheets that are not recognised are listed and not read.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Sheet</th>
                  <th scope="col">Read as</th>
                  <th scope="col" className="num">
                    Rows read
                  </th>
                  <th scope="col" className="num">
                    Staged
                  </th>
                  <th scope="col" className="num">
                    Phones
                  </th>
                  <th scope="col">Check</th>
                </tr>
              </thead>
              <tbody>
                {sheets.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    <td>{s.kind ? { INTERNAL: "Internal sales", EXTERNAL: "External sales", COMPLETED: "Completed repayment", CANCELLED: "Cancelled" }[s.kind] : "—"}</td>
                    <td className="num">{n(s.read)}</td>
                    <td className="num">{n(s.staged)}</td>
                    <td className="num">{n(s.units)}</td>
                    <td className="small">{s.note ? <span className="muted">{s.note}</span> : s.read === s.staged ? <span className="badge badge-green">All rows staged</span> : <span className="badge badge-red">Mismatch</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 style={{ marginTop: "var(--space-5)" }}>Status from the register</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Records
                  </th>
                  <th scope="col" className="num">
                    Phones
                  </th>
                  <th scope="col" className="num">
                    Outstanding
                  </th>
                  <th scope="col" className="num">
                    In arrears
                  </th>
                </tr>
              </thead>
              <tbody>
                {rec.byStatus.map((s) => (
                  <tr key={s.status}>
                    <td>
                      <Link href={qs({ status: s.status })}>
                        <span className={`badge ${CLASS_BADGE[s.status]}`}>{CLASSIFICATION_LABEL[s.status]}</span>
                      </Link>
                    </td>
                    <td className="num">{n(s.records)}</td>
                    <td className="num">{n(s.units)}</td>
                    <td className="num">{naira(s.outstandingKobo)}</td>
                    <td className="num">{naira(s.arrearsKobo)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row">Included</th>
                  <td className="num">
                    <strong>{n(rec.included)}</strong>
                  </td>
                  <td className="num">{n(rec.byStatus.reduce((a, s) => a + s.units, 0))}</td>
                  <td className="num">
                    <strong>{naira(rec.money.outstandingKobo)}</strong>
                  </td>
                  <td className="num">
                    <strong>{naira(rec.money.arrearsKobo)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <dl className="case-facts" style={{ marginTop: "var(--space-4)" }}>
            <div>
              <dt>Records read = included + excluded</dt>
              <dd>
                {n(rec.records)} = {n(rec.included)} + {n(rec.excluded)} {rec.records === rec.included + rec.excluded ? "✓" : "✗"}
              </dd>
            </div>
            <div>
              <dt>Down payments recorded</dt>
              <dd>{naira(rec.money.downPaymentsKobo)}</dd>
            </div>
            <div>
              <dt>Collected per register (down payments + paid months)</dt>
              <dd>{naira(rec.money.collectedKobo)}</dd>
            </div>
            <div>
              <dt>NIN</dt>
              <dd>
                Kept for {n(rec.ninKept)} records still repaying; left out for {n(rec.ninDropped)} completed
              </dd>
            </div>
            <div>
              <dt>Location labels linked</dt>
              <dd>
                {n(rec.locations.mapped)} of {n(rec.locations.labels)} ({n(rec.locations.unmappedRecords)} records not linked)
              </dd>
            </div>
            <div>
              <dt>&quot;Referred by&quot; linked to staff</dt>
              <dd>
                {n(rec.referrers.mapped)} of {n(rec.referrers.labels)} ({n(rec.referrers.unmappedRecords)} records not linked)
              </dd>
            </div>
            <div>
              <dt>Stock</dt>
              <dd>Historical sales do not change stock. Their IMEIs are registered as issued so they cannot be sold or migrated again.</dd>
            </div>
          </dl>
          {rec.issues.length > 0 && (
            <>
              <h3 style={{ marginTop: "var(--space-5)" }}>Checks</h3>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">Check</th>
                      <th scope="col">Effect</th>
                      <th scope="col" className="num">
                        Records
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rec.issues.map((i) => (
                      <tr key={i.code}>
                        <td>
                          <Link href={qs({ issue: i.code })}>{ISSUE_LABEL[i.code] ?? i.code}</Link>
                        </td>
                        <td>{i.level === "BLOCK" ? <span className="badge badge-red">Needs a decision</span> : <span className="badge">For information</span>}</td>
                        <td className="num">{n(i.records)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {editable && (
        <section className="card" aria-labelledby="h-asat">
          <h2 id="h-asat">As-at date</h2>
          <ActionForm action={setAsAtAction} className="filters" refreshOnSuccess>
            <input type="hidden" name="batchId" value={b.id} />
            <div className="field">
              <label htmlFor="asAtEdit">Register correct as at</label>
              <input id="asAtEdit" name="asAt" type="date" required defaultValue={b.as_at_text} />
            </div>
            <SubmitButton className="btn">Save and re-check</SubmitButton>
          </ActionForm>
        </section>
      )}

      {editable && locLabels.length > 0 && (
        <section className="card" aria-labelledby="h-locmap">
          <h2 id="h-locmap">Location labels</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            Link each label used in the register to a Branch, Shop or BOX. Links are remembered for later files. {unmappedLocs.length ? `${n(unmappedLocs.length)} not linked yet.` : "All labels are linked."} Labels that are not a place (for example a team or a person) can be left unlinked; the label is kept on the record.
          </p>
          <ActionForm action={mapLocationsAction} className="stack">
            <input type="hidden" name="batchId" value={b.id} />
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Label in the register</th>
                    <th scope="col" className="num">
                      Records
                    </th>
                    <th scope="col">Linked to</th>
                  </tr>
                </thead>
                <tbody>
                  {locLabels.map((l, i) => (
                    <tr key={l.label}>
                      <td>{l.label}</td>
                      <td className="num">{n(l.records)}</td>
                      <td>
                        <input type="hidden" name={`label_${i}`} value={l.label} />
                        <select name={`to_${i}`} defaultValue="" aria-label={`Location for ${l.label}`} style={{ maxWidth: 320 }}>
                          <option value="">{l.location_name ? `${l.location_name} (linked)` : "Not linked"}</option>
                          {locations.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name} — {o.state}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="action-bar">
              <SubmitButton>Save links</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}

      {editable && refLabels.length > 0 && (
        <section className="card" aria-labelledby="h-refmap">
          <h2 id="h-refmap">&quot;Referred by&quot;</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            Names that match a staff member exactly are linked automatically. Link the others where the person is known. {unmappedRefs.length ? `${n(unmappedRefs.length)} not linked yet.` : "All names are linked."}
          </p>
          <ActionForm action={mapReferrersAction} className="stack">
            <input type="hidden" name="batchId" value={b.id} />
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Name in the register</th>
                    <th scope="col" className="num">
                      Records
                    </th>
                    <th scope="col">Staff member</th>
                  </tr>
                </thead>
                <tbody>
                  {refLabels.map((l, i) => (
                    <tr key={l.label}>
                      <td>{l.label}</td>
                      <td className="num">{n(l.records)}</td>
                      <td>
                        <input type="hidden" name={`label_${i}`} value={l.label} />
                        <select name={`to_${i}`} defaultValue="" aria-label={`Staff member for ${l.label}`} style={{ maxWidth: 320 }}>
                          <option value="">{l.staff_name ? `${l.staff_name} (linked)` : "Not linked"}</option>
                          {staff.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.full_name} — {o.email}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="action-bar">
              <SubmitButton>Save links</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}

      <section className="card" aria-labelledby="h-records" id="records">
        <div className="card-head">
          <h2 id="h-records">Records</h2>
          <span className="small muted">
            {n(records.total)} shown{records.pages > 1 ? ` · page ${records.page} of ${records.pages}` : ""}
          </span>
        </div>
        <form className="filters" method="get" action={`/altphones/migration/${b.id}#records`}>
          <div className="field">
            <label htmlFor="r-q">Search</label>
            <input id="r-q" name="q" defaultValue={f.q} placeholder="Name, IMEI or last 4 of account" />
          </div>
          <div className="field">
            <label htmlFor="r-sheet">Sheet</label>
            <select id="r-sheet" name="sheet" defaultValue={f.sheet}>
              <option value="">All sheets</option>
              {sheets
                .filter((s) => s.kind)
                .map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="r-status">Status</label>
            <select id="r-status" name="status" defaultValue={f.status}>
              <option value="">Any</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {CLASSIFICATION_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="r-issue">Checks</label>
            <select id="r-issue" name="issue" defaultValue={f.issue}>
              <option value="">Any</option>
              <option value="blocked">Needs a decision</option>
              <option value="warn">Has information notes</option>
              {Object.entries(ISSUE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="r-dec">Decision</label>
            <select id="r-dec" name="decision" defaultValue={f.decision}>
              <option value="">Any</option>
              <option value="NONE">No decision</option>
              <option value="INCLUDE">Included</option>
              <option value="EXCLUDE">Excluded</option>
            </select>
          </div>
          <button type="submit" className="btn">
            Filter
          </button>
          <Link href={`/altphones/migration/${b.id}#records`} className="btn btn-ghost">
            Clear
          </Link>
        </form>
        {undecided > 0 && (
          <details className="mig-bulk">
            <summary>
              Decide all {n(undecided)} undecided record{undecided === 1 ? "" : "s"} matching this filter
            </summary>
            <ActionForm action={decideMatchingAction} className="stack">
              <input type="hidden" name="batchId" value={b.id} />
              <input type="hidden" name="f_sheet" value={f.sheet} />
              <input type="hidden" name="f_status" value={f.status} />
              <input type="hidden" name="f_issue" value={f.issue} />
              <input type="hidden" name="f_q" value={f.q} />
              <p className="small muted" style={{ margin: 0 }}>
                Records that already have a decision are not changed. The reason is kept on every record and shown to the Unit Head.
              </p>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="bulk-d">Decision</label>
                  <select id="bulk-d" name="decision" defaultValue="INCLUDE">
                    <option value="INCLUDE">Include</option>
                    <option value="EXCLUDE">Exclude</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="bulk-c">Status from the team&apos;s records</label>
                  <select id="bulk-c" name="classification" defaultValue="">
                    <option value="">As read from the register</option>
                    {STATUSES.filter((x) => x !== "NEEDS_REVIEW").map((x) => (
                      <option key={x} value={x}>
                        {CLASSIFICATION_LABEL[x]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor="bulk-n">Reason</label>
                <input id="bulk-n" name="note" required placeholder="For example: confirmed against the team's collection records" />
              </div>
              <div className="action-bar">
                <SubmitButton>Apply to {n(undecided)} records</SubmitButton>
              </div>
            </ActionForm>
          </details>
        )}
        {records.rows.length === 0 ? (
          <p className="muted">No records match.</p>
        ) : (
          <div className="table-wrap">
            <table className="data mig-records">
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Terms</th>
                  <th scope="col">Months</th>
                  <th scope="col">Status</th>
                  <th scope="col">Checks and decision</th>
                </tr>
              </thead>
              <tbody>
                {records.rows.map((r) => {
                  const issues = r.issues as Issue[];
                  const blocks = issues.filter((i) => i.level === "BLOCK");
                  return (
                    <tr key={r.id} className={r.decision === "EXCLUDE" ? "muted" : undefined}>
                      <td>
                        <strong>{r.customer_name}</strong>
                        <div className="small muted">
                          {r.sheet} row {r.row_no}
                          {r.account_last4 ? ` · acct …${r.account_last4}` : ""}
                        </div>
                        <div className="small muted">
                          {r.location_name ?? r.location_label ?? "No location"}
                          {r.officer_name ? ` · ${r.officer_name}` : r.referrer_label ? ` · ${r.referrer_label}` : ""}
                        </div>
                        {r.imei && <div className="small mono">{r.imei}</div>}
                      </td>
                      <td className="small">
                        {n(r.units ?? 0)} phone{r.units === 1 ? "" : "s"}
                        <div>Down {naira(r.down_payment_kobo)}</div>
                        <div>
                          {naira(r.instalment_kobo)} × {r.tenor_months ?? "?"}
                        </div>
                        {r.start_date && <div className="muted">from {r.start_date}</div>}
                      </td>
                      <td className="small">
                        <span className="mig-marks" aria-label={`${r.paid_count} paid, ${r.missed_count} missed`}>
                          {(r.months as { m: string; s: string }[]).map((m) => (
                            <span key={m.m} className={m.s === "Y" ? "mk-y" : "mk-n"} title={`${m.m}: ${m.s === "Y" ? "paid" : "missed"}`}>
                              {m.s === "Y" ? "✓" : "✗"}
                            </span>
                          ))}
                        </span>
                        <div className="muted">
                          {r.paid_count} paid · {r.missed_count} missed
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${CLASS_BADGE[r.status]}`}>{CLASSIFICATION_LABEL[r.status as Classification]}</span>
                        {r.override_classification && <div className="small muted">register: {CLASSIFICATION_LABEL[r.classification as Classification]}</div>}
                        {Number(r.arrears_kobo) > 0 && <div className="small">arrears {naira(r.arrears_kobo)}</div>}
                        {Number(r.outstanding_kobo) > 0 && <div className="small muted">outstanding {naira(r.outstanding_kobo)}</div>}
                      </td>
                      <td className="small" style={{ minWidth: 260 }}>
                        {blocks.map((i, k) => (
                          <div key={`b${k}`} className={r.decision ? "muted" : "text-danger"}>
                            <strong>{ISSUE_LABEL[i.code] ?? i.code}:</strong> {i.message}
                          </div>
                        ))}
                        {issues.filter((i) => i.level === "WARN").length > 0 && <div className="muted">{issues.filter((i) => i.level === "WARN").map((i) => ISSUE_LABEL[i.code] ?? i.code).join(" · ")}</div>}
                        {r.decision && (
                          <div style={{ marginTop: 4 }}>
                            <span className={`badge ${r.decision === "EXCLUDE" ? "" : "badge-green"}`}>{r.decision === "EXCLUDE" ? "Excluded" : "Included"}</span> {r.decision_note}
                            {r.decided_by_name && <span className="muted"> — {r.decided_by_name}</span>}
                          </div>
                        )}
                        {editable && (
                          <details className="mig-decide">
                            <summary>{r.decision ? "Change decision" : blocks.length ? "Decide" : "Exclude or set status"}</summary>
                            <ActionForm action={decideRecordAction} className="stack">
                              <input type="hidden" name="recordId" value={r.id} />
                              <div className="field">
                                <label htmlFor={`d-${r.id}`}>Decision</label>
                                <select id={`d-${r.id}`} name="decision" defaultValue={r.decision ?? "INCLUDE"}>
                                  <option value="INCLUDE">Include</option>
                                  <option value="EXCLUDE">Exclude</option>
                                  {r.decision && <option value="CLEAR">Clear decision</option>}
                                </select>
                              </div>
                              <div className="field">
                                <label htmlFor={`c-${r.id}`}>Status from the team&apos;s records</label>
                                <select id={`c-${r.id}`} name="classification" defaultValue={r.override_classification ?? ""}>
                                  <option value="">As read from the register{r.classification !== "NEEDS_REVIEW" ? ` (${CLASSIFICATION_LABEL[r.classification as Classification]})` : ""}</option>
                                  {STATUSES.filter((s) => s !== "NEEDS_REVIEW").map((s) => (
                                    <option key={s} value={s}>
                                      {CLASSIFICATION_LABEL[s]}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="field">
                                <label htmlFor={`n-${r.id}`}>Reason</label>
                                <input id={`n-${r.id}`} name="note" defaultValue={r.decision_note ?? ""} placeholder="Shown to the Unit Head" />
                              </div>
                              <div className="action-bar">
                                <SubmitButton>Save decision</SubmitButton>
                              </div>
                            </ActionForm>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {records.pages > 1 && (
          <nav className="pagination" aria-label="Pages">
            {records.page > 1 && (
              <Link className="btn btn-ghost" href={qs({ page: records.page - 1 })}>
                Previous
              </Link>
            )}
            <span className="small muted">
              Page {records.page} of {records.pages}
            </span>
            {records.page < records.pages && (
              <Link className="btn btn-ghost" href={qs({ page: records.page + 1 })}>
                Next
              </Link>
            )}
          </nav>
        )}
      </section>

      {editable && rec && (
        <section className="card action-panel" aria-labelledby="h-submit">
          <h2 id="h-submit">Send for approval</h2>
          {rec.blockedOpen > 0 ? (
            <p style={{ marginTop: 0 }}>
              <Link href={qs({ issue: "blocked" })}>{n(rec.blockedOpen)} records need a decision</Link> before the batch can be submitted.
            </p>
          ) : (
            <p className="small muted" style={{ marginTop: 0 }}>
              {n(rec.included)} records will be published and {n(rec.excluded)} left out. The Unit Head reviews this reconciliation and approves or returns it.
            </p>
          )}
          <ActionForm action={submitBatchAction} className="stack">
            <input type="hidden" name="batchId" value={b.id} />
            <div className="field">
              <label htmlFor="snote">Note for the Unit Head (optional)</label>
              <input id="snote" name="note" />
            </div>
            <div className="action-bar">
              <SubmitButton disabled={rec.blockedOpen > 0}>Submit to the Unit Head</SubmitButton>
            </div>
          </ActionForm>
          <details style={{ marginTop: "var(--space-4)" }}>
            <summary className="small">Discard this batch</summary>
            <ActionForm action={discardBatchAction} className="stack" doneHref="/altphones/migration">
              <input type="hidden" name="batchId" value={b.id} />
              <div className="field">
                <label htmlFor="dreason">Reason</label>
                <input id="dreason" name="reason" required />
              </div>
              <div className="action-bar">
                <SubmitButton className="btn btn-danger">Discard batch</SubmitButton>
              </div>
            </ActionForm>
          </details>
        </section>
      )}

      {b.status === "SUBMITTED" && (
        <section className="card action-panel" aria-labelledby="h-approve">
          <h2 id="h-approve">Unit Head approval</h2>
          {b.decision_note && <p style={{ marginTop: 0 }}>Preparer&apos;s note: {b.decision_note}</p>}
          {canDecide ? (
            <ActionForm action={decideBatchAction} className="stack">
              <input type="hidden" name="batchId" value={b.id} />
              <p className="small muted" style={{ marginTop: 0 }}>
                Approving publishes {n(rec?.included)} records as verified historical accounts. Returning sends the batch back to the preparer with your reason.
              </p>
              <div className="field">
                <label htmlFor="acomment">Comment (required to return)</label>
                <input id="acomment" name="comment" />
              </div>
              <div className="action-bar">
                <SubmitButton name="decision" value="APPROVE">
                  Approve and publish
                </SubmitButton>
                <SubmitButton name="decision" value="RETURN" className="btn btn-danger">
                  Return for changes
                </SubmitButton>
              </div>
            </ActionForm>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>
              {access.approve ? "You prepared or submitted this batch, so another Unit Head must decide it." : "Waiting for the Altphones Unit Head to approve or return it."}
            </p>
          )}
        </section>
      )}
    </>
  );
}
