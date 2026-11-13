import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { ActionForm, SubmitButton } from "@/components/forms";
import { db } from "@/server/db";
import { formatLagos } from "@/server/time";
import { integrationStatus, listHolidays, listModels, MAX_ACTIVE_MODELS } from "@/server/altphones/catalogue";
import { creditReadiness, currentSettings, roleHolders, routeUnitHead } from "@/server/altphones/core";
import { altphonesAccess } from "@/server/altphones/views";
import { termsFor } from "@/server/altphones/origination";
import { IMPORT_LABELS, listImports, type ImportKind } from "@/server/altphones/imports";
import { formatNaira, formatRateE4, MARKUP_BASIS_LABELS, SHORT_MONTH_RULE_LABELS, WEEKEND_RULE_LABELS, type MarkupBasis, type ShortMonthRule, type WeekendRule } from "@/lib/altphones";
import { PhoneImage } from "../ui";
import { ContractEditor } from "../AltClient";
import { CONTRACT_DRAFT } from "@/lib/altphones-contract";
import { contractAction, commitImportAction, discardImportAction, holidayAction, modelAction, policyAction, previewImportAction, pricingAction } from "../actions";

export const metadata = { title: "Altphones settings" };

type Tab = "catalogue" | "pricing" | "contract" | "policy" | "imports";

export default async function AltManage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { session } = await requireUser();
  const access = await altphonesAccess(db, session.staffId);
  if (!access.pm && !access.admin) redirect("/altphones");
  const tabs: { key: Tab; label: string; show: boolean }[] = [
    { key: "catalogue", label: "Catalogue", show: access.pm },
    { key: "pricing", label: "Pricing", show: access.pm || access.admin },
    { key: "contract", label: "Contract", show: access.pm || access.admin },
    {
      key: "policy",
      label: "Credit policy and routing",
      show: access.admin || access.pm,
    },
    { key: "imports", label: "Setup uploads", show: access.admin },
  ];
  const visible = tabs.filter((t) => t.show);
  const tab = (visible.find((t) => t.key === sp.tab)?.key ?? visible[0].key) as Tab;
  const s = await currentSettings(db);
  const missing = creditReadiness(s);
  const integ = integrationStatus();
  return (
    <>
      <PageHeader eyebrow="Altphones" title="Altphones settings" intro="Every change is saved as a new version and audited. Agreed customer terms never change." />
      <div className="alt-integrations">
        {(
          [
            ["SeedFi Seed Score", integ.seedfi],
            ["Paystack payments", integ.paystack],
            ["Paystack Direct Debit", integ.directDebit],
          ] as [string, string][]
        ).map(([k, v]) => (
          <span key={k} className={`badge ${v === "CONFIGURED" ? "badge-green" : "badge-warn"}`}>
            {k}: {v === "CONFIGURED" ? "configured" : "not configured"}
          </span>
        ))}
        {missing.length === 0 ? (
          <span className="badge badge-green">Credit sales: ready</span>
        ) : (
          <span className="badge badge-warn">
            Credit sales: {missing.length} item{missing.length === 1 ? "" : "s"} missing
          </span>
        )}
      </div>
      <nav className="tabs" aria-label="Settings">
        {visible.map((t) => (
          <Link key={t.key} className="tab" href={`?tab=${t.key}`} aria-current={t.key === tab ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "catalogue" && <Catalogue />}
      {tab === "pricing" && <Pricing canEdit={access.pm} />}
      {tab === "policy" && <Policy canEdit={access.admin} />}
      {tab === "contract" && <Contract />}
      {tab === "imports" && <Imports preview={sp.preview} />}
      <p className="small muted">
        Settings version {s.version} · {formatLagos(s.created_at)} · {s.reason}
      </p>
    </>
  );
}

async function Catalogue() {
  const models = await listModels(db);
  const active = models.filter((m) => m.active).length;
  return (
    <>
      <p className="small muted">
        {active} of {MAX_ACTIVE_MODELS} catalogue places used. Upload the actual product photo (PNG, JPEG or WebP, up to 5 MB) and the approved specifications.
      </p>
      <div className="alt-model-list">
        {models.map((m) => (
          <section key={m.id} className="card alt-model">
            <PhoneImage modelId={m.id} hasImage={!!m.image_key} name={m.name} size="thumb" />
            <ActionForm action={modelAction} className="stack" encType="multipart/form-data">
              <input type="hidden" name="id" value={m.id} />
              <div className="grid-2">
                <div className="field">
                  <label htmlFor={`n-${m.id}`}>Name</label>
                  <input id={`n-${m.id}`} name="name" defaultValue={m.name} required />
                </div>
                <div className="field">
                  <label htmlFor={`o-${m.id}`}>Display order</label>
                  <input id={`o-${m.id}`} name="sortOrder" type="number" min={0} max={99} defaultValue={m.sort_order} />
                </div>
                <div className="field" style={{ gridColumn: "1 / -1" }}>
                  <label htmlFor={`s-${m.id}`}>Specifications (one per line)</label>
                  <textarea id={`s-${m.id}`} name="specifications" rows={4} defaultValue={m.specifications} required />
                </div>
                <div className="field">
                  <label htmlFor={`i-${m.id}`}>{m.image_key ? "Replace photo" : "Product photo"}</label>
                  <input id={`i-${m.id}`} name="image" type="file" accept="image/png,image/jpeg,image/webp" />
                </div>
                <label className="check" style={{ alignSelf: "end" }}>
                  <input type="checkbox" name="active" defaultChecked={m.active} /> Shown in the catalogue
                </label>
              </div>
              <div className="action-bar">
                <SubmitButton>Save</SubmitButton>
              </div>
            </ActionForm>
          </section>
        ))}
        <section className="card alt-model">
          <div className="alt-phone-img alt-phone-img--thumb is-empty" aria-hidden="true" />
          <ActionForm action={modelAction} className="stack" encType="multipart/form-data" resetOnSuccess>
            <h2 style={{ margin: 0 }}>Add a phone</h2>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="n-new">Name</label>
                <input id="n-new" name="name" required />
              </div>
              <div className="field">
                <label htmlFor="o-new">Display order</label>
                <input id="o-new" name="sortOrder" type="number" min={0} max={99} defaultValue={models.length} />
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label htmlFor="s-new">Specifications (one per line)</label>
                <textarea id="s-new" name="specifications" rows={4} required />
              </div>
              <div className="field">
                <label htmlFor="i-new">Product photo</label>
                <input id="i-new" name="image" type="file" accept="image/png,image/jpeg,image/webp" />
              </div>
              <label className="check" style={{ alignSelf: "end" }}>
                <input type="checkbox" name="active" defaultChecked={active < MAX_ACTIVE_MODELS} /> Shown in the catalogue
              </label>
            </div>
            <div className="action-bar">
              <SubmitButton>Add phone</SubmitButton>
            </div>
          </ActionForm>
        </section>
      </div>
    </>
  );
}

async function Pricing({ canEdit }: { canEdit: boolean }) {
  const s = await currentSettings(db);
  const holidays = await listHolidays(db);
  const rate = (t: number) => (s.markup_rates?.[String(t)] !== undefined ? formatRateE4(s.markup_rates[String(t)]).replace("%", "") : "");
  return (
    <div className="stack">
      <section className="card" aria-labelledby="h-calc">
        <h2 id="h-calc">Current calculation</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          Phone price {formatNaira(s.outright_price_kobo)} · fixed down payment {formatNaira(s.down_payment_kobo)}. Markup is charged on the full phone price; the down payment comes off the price with markup and
          the balance is paid monthly.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Tenure</th>
                <th scope="col" className="num">
                  Rate
                </th>
                <th scope="col" className="num">
                  Markup
                </th>
                <th scope="col" className="num">
                  Price with markup
                </th>
                <th scope="col" className="num">
                  Balance in instalments
                </th>
                <th scope="col" className="num">
                  Monthly
                </th>
                <th scope="col" className="num">
                  Final instalment
                </th>
              </tr>
            </thead>
            <tbody>
              {s.tenures.map((t) => {
                const x = termsFor(s, t);
                return (
                  <tr key={t}>
                    <td>{t} months</td>
                    <td className="num">{x ? formatRateE4(x.effectiveRateE4) : "Not set"}</td>
                    <td className="num">{x ? formatNaira(x.markupKobo) : "—"}</td>
                    <td className="num">{x ? formatNaira(x.priceKobo + x.markupKobo) : "—"}</td>
                    <td className="num">{x ? formatNaira(x.totalRepaymentKobo) : "—"}</td>
                    <td className="num">{x ? formatNaira(x.instalmentKobo) : "—"}</td>
                    <td className="num">{x ? formatNaira(x.finalInstalmentKobo) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="small muted">Check these against the approved Excel workbook before enabling credit sales.</p>
      </section>
      {canEdit && (
        <section className="card" aria-labelledby="h-price">
          <h2 id="h-price">Pricing, repayment rules and contract</h2>
          <ActionForm action={pricingAction} className="stack">
            <div className="alt-rates">
              {s.tenures.map((t) => (
                <div key={t} className="field">
                  <label htmlFor={`rate${t}`}>{t}-month rate (%)</label>
                  <input id={`rate${t}`} name={`rate${t}`} inputMode="decimal" defaultValue={rate(t)} placeholder="e.g. 12.5" />
                </div>
              ))}
              <div className="field">
                <label htmlFor="basis">How the rate applies</label>
                <select id="basis" name="basis" defaultValue={s.markup_basis ?? ""}>
                  <option value="">Not set</option>
                  {(Object.keys(MARKUP_BASIS_LABELS) as MarkupBasis[]).map((b) => (
                    <option key={b} value={b}>
                      {MARKUP_BASIS_LABELS[b]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="weekendRule">Weekends and public holidays</label>
                <select id="weekendRule" name="weekendRule" defaultValue={s.weekend_rule ?? ""}>
                  <option value="">Not set</option>
                  {(Object.keys(WEEKEND_RULE_LABELS) as WeekendRule[]).map((b) => (
                    <option key={b} value={b}>
                      {WEEKEND_RULE_LABELS[b]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="shortMonthRule">Months without the repayment day</label>
                <select id="shortMonthRule" name="shortMonthRule" defaultValue={s.short_month_rule ?? ""}>
                  <option value="">Not set</option>
                  {(Object.keys(SHORT_MONTH_RULE_LABELS) as ShortMonthRule[]).map((b) => (
                    <option key={b} value={b}>
                      {SHORT_MONTH_RULE_LABELS[b]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="reason">Approval reference</label>
              <input id="reason" name="reason" required placeholder="Approval memo or committee reference" />
            </div>
            <div className="action-bar">
              <SubmitButton>Save new version</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}
      <section className="card" aria-labelledby="h-hol">
        <h2 id="h-hol">Public holidays</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          Used to move repayment dates. Add holidays as they are declared.
        </p>
        {holidays.length > 0 && (
          <ul className="alt-holidays">
            {holidays.map((h) => (
              <li key={h.holiday_date}>
                <span className="mono">{h.holiday_date}</span> {h.name}
                <ActionForm action={holidayAction} className="inline-form" showMessages={false}>
                  <input type="hidden" name="date" value={h.holiday_date} />
                  <input type="hidden" name="remove" value="1" />
                  <SubmitButton className="btn btn-sm btn-ghost">Remove</SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
        <ActionForm action={holidayAction} className="alt-inline-add" resetOnSuccess>
          <div className="field">
            <label htmlFor="hdate">Date</label>
            <input id="hdate" name="date" type="date" required />
          </div>
          <div className="field">
            <label htmlFor="hname">Holiday</label>
            <input id="hname" name="name" required />
          </div>
          <SubmitButton>Add</SubmitButton>
        </ActionForm>
      </section>
    </div>
  );
}

async function Policy({ canEdit }: { canEdit: boolean }) {
  const s = await currentSettings(db);
  const [uh, holders] = await Promise.all([routeUnitHead(db), roleHolders(db, ["UNIT_HEAD"])]);
  return (
    <section className="card" aria-labelledby="h-pol">
      <h2 id="h-pol">Credit policy and routing</h2>
      <dl className="alt-kv">
        <div>
          <dt>Seed Score bands</dt>
          <dd>
            {s.score_pass_min === null
              ? "Not configured — credit checks cannot be mapped"
              : `Pass ≥ ${Number(s.score_pass_min)} · Fair ${Number(s.score_fair_min)}–${Number(s.score_pass_min) - 1} · Fail below ${Number(s.score_fair_min)}`}
            <div className="small muted">Seed Score range 280–800, decided on SeedFi&rsquo;s reviewed score. SeedFi&rsquo;s documented bands: Approved 620–800, Manual Review 530–619, Declined below 530.</div>
          </dd>
        </div>
        <div>
          <dt>Unit Head (Altphones route)</dt>
          <dd>{uh.problem ? <span className="err">{uh.problem}</span> : uh.name}</dd>
        </div>
        <div>
          <dt>Routes</dt>
          <dd className="small">Delight Officer: Product Manager → Unit Head. Smile Associate: Business Performance Manager → Product Manager → Unit Head. Approved applications return to the originating officer.</dd>
        </div>
        <div>
          <dt>Team mailbox</dt>
          <dd>{s.team_email}</dd>
        </div>
      </dl>
      {canEdit ? (
        <ActionForm action={policyAction} className="stack">
          <div className="grid-2">
            <div className="field">
              <label htmlFor="passMin">Pass: Seed Score at or above</label>
              <input id="passMin" name="passMin" inputMode="decimal" defaultValue={s.score_pass_min ?? ""} />
            </div>
            <div className="field">
              <label htmlFor="fairMin">Fair: Seed Score at or above</label>
              <input id="fairMin" name="fairMin" inputMode="decimal" defaultValue={s.score_fair_min ?? ""} />
              <span className="hint">Below this is Fail. Use the thresholds in the approved credit policy.</span>
            </div>
            <div className="field">
              <label htmlFor="unitHeadId">Unit Head for the Altphones route</label>
              <select id="unitHeadId" name="unitHeadId" defaultValue={s.unit_head_staff_id ?? ""}>
                <option value="">Not set</option>
                {holders.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.full_name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="teamEmail">Altphones team mailbox</label>
              <input id="teamEmail" name="teamEmail" type="email" defaultValue={s.team_email} required />
            </div>
          </div>
          <div className="field">
            <label htmlFor="preason">Approval reference</label>
            <input id="preason" name="reason" required placeholder="Approved credit policy reference" />
          </div>
          <div className="action-bar">
            <SubmitButton>Save new version</SubmitButton>
          </div>
        </ActionForm>
      ) : (
        <p className="small muted">A Super Admin changes these settings.</p>
      )}
    </section>
  );
}

const n = (c: number, one: string, many = `${one}s`) => `${c.toLocaleString()} ${c === 1 ? one : many}`;

async function Imports({ preview }: { preview?: string }) {
  const list = await listImports(db, 20);
  const open = list.find((i) => i.status === "PREVIEW" && (!preview || i.id === preview));
  const counts = (
    await db.query<{
      branches: number;
      shops: number;
      boxes: number;
      dos: number;
      sas: number;
      units: number;
      stockLocations: number;
    }>(
      `SELECT (SELECT count(*) FROM locations WHERE active AND outlet_type = 'BRANCH')::int AS branches,
              (SELECT count(*) FROM locations WHERE active AND outlet_type = 'ALTSHOP')::int AS shops,
              (SELECT count(*) FROM locations WHERE active AND outlet_type = 'ALTBOX')::int AS boxes,
              (SELECT count(DISTINCT staff_id) FROM role_assignments WHERE active AND role = 'DELIGHT_OFFICER')::int AS dos,
              (SELECT count(DISTINCT staff_id) FROM role_assignments WHERE active AND role = 'SMILE_ASSOCIATE')::int AS sas,
              (SELECT coalesce(sum(physical), 0) FROM altphones_stock)::int AS units,
              (SELECT count(DISTINCT location_id) FROM altphones_stock WHERE physical > 0)::int AS "stockLocations"`,
    )
  ).rows[0];
  return (
    <div className="stack">
      <section className="card" aria-labelledby="h-imp">
        <h2 id="h-imp">Altphones setup</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          Upload in this order. Each file is checked first and nothing is applied until you confirm. Download a template, fill it in Excel, and save as .xlsx or .csv.
        </p>
        <ol className="setup-steps">
          {(
            [
              [
                "LOCATIONS",
                "Locations",
                `${n(counts.branches, "Branch", "Branches")} · ${n(counts.shops, "Shop")} · ${n(counts.boxes, "BOX", "BOXes")}`,
                "State, city, type (Branch, Shop or BOX) and name. Existing locations are skipped; duplicate names are refused.",
              ],
              [
                "OFFICERS",
                "Delight Officers and Smile Associates",
                `${n(counts.dos, "Delight Officer")} · ${n(counts.sas, "Smile Associate")}`,
                "Work email, name, route (Delight Officer or Smile Associate), state and home Branch/BOX. The route decides how they sign in; set Active to No to remove access. Emails must be in the bank directory.",
              ],
              [
                "OPENING_STOCK",
                "Opening stock",
                `${n(counts.units, "unit")} at ${n(counts.stockLocations, "location")}`,
                "Branch or Shop, phone model, quantity and (optionally) the IMEIs. BOX locations cannot hold stock.",
              ],
            ] as [ImportKind, string, string, string][]
          ).map(([kind, title, status, hint], i) => (
            <li key={kind} className="setup-step">
              <div className="setup-step-head">
                <span className="setup-step-n">{i + 1}</span>
                <div>
                  <strong>{title}</strong>
                  <div className="small muted">{status}</div>
                </div>
                <a className="btn btn-sm btn-ghost" href={`/api/altphones/templates/${kind.toLowerCase()}`}>
                  Template
                </a>
              </div>
              <p className="small" style={{ margin: 0 }}>
                {hint}
              </p>
              <ActionForm action={previewImportAction} className="alt-inline-add" encType="multipart/form-data" resetOnSuccess>
                <input type="hidden" name="kind" value={kind} />
                <div className="field">
                  <label htmlFor={`file-${kind}`}>File</label>
                  <input id={`file-${kind}`} name="file" type="file" accept=".csv,.xlsx" required />
                </div>
                <SubmitButton>Check file</SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ol>
      </section>
      <section className="card" aria-labelledby="h-hist-up">
        <h2 id="h-hist-up">Historical records</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          Sales and credit facilities completed outside ARAF are marked Legacy / Imported and create no payments, approvals, emails or stock movements. Import past stock movements separately so nothing is counted twice.
        </p>
        <ActionForm action={previewImportAction} className="alt-inline-add" encType="multipart/form-data" resetOnSuccess>
          <div className="field">
            <label htmlFor="kind">What</label>
            <select id="kind" name="kind" required>
              {(["TRANSACTIONS", "STOCK"] as ImportKind[]).map((k) => (
                <option key={k} value={k}>
                  {IMPORT_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="file">File</label>
            <input id="file" name="file" type="file" accept=".csv,.xlsx" required />
          </div>
          <SubmitButton>Check file</SubmitButton>
        </ActionForm>
        <p className="small">
          Templates:{" "}
          {(["TRANSACTIONS", "STOCK"] as ImportKind[]).map((k, i) => (
            <span key={k}>
              {i > 0 && " · "}
              <a href={`/api/altphones/templates/${k.toLowerCase()}`}>{IMPORT_LABELS[k]}</a>
            </span>
          ))}
        </p>
      </section>
      {open && (
        <section className="card action-panel stack" aria-labelledby="h-prev">
          <h2 id="h-prev">
            Check: {open.filename} <span className="badge">{IMPORT_LABELS[open.kind as ImportKind]}</span>
          </h2>
          <div className="alt-integrations">
            <span className="badge">{open.summary.rows} rows</span>
            <span className="badge badge-green">{open.summary.valid} ready</span>
            {open.summary.skipped > 0 && <span className="badge">{open.summary.skipped} already exist (skipped)</span>}
            {open.summary.errors > 0 && <span className="badge badge-red">{open.summary.errors} errors</span>}
          </div>
          {open.errors.length > 0 && (
            <ul className="alt-import-errors small">
              {open.errors.slice(0, 200).map((e: { row: number; message: string; skipped?: boolean }, i: number) => (
                <li key={i} className={e.skipped ? "muted" : "err"}>
                  Row {e.row}: {e.message}
                </li>
              ))}
            </ul>
          )}
          <div className="action-bar">
            {open.summary.errors === 0 && open.summary.valid > 0 ? (
              <ActionForm action={commitImportAction} className="inline-form">
                <input type="hidden" name="importId" value={open.id} />
                <SubmitButton>Import {open.summary.valid} records</SubmitButton>
              </ActionForm>
            ) : (
              <span className="small">{open.summary.errors ? "Correct the errors in the file and upload it again." : "Nothing new to import."}</span>
            )}
            <ActionForm action={discardImportAction} className="inline-form">
              <input type="hidden" name="importId" value={open.id} />
              <SubmitButton className="btn btn-ghost">Discard</SubmitButton>
            </ActionForm>
          </div>
        </section>
      )}
      <section className="card" aria-labelledby="h-ihist">
        <h2 id="h-ihist">Recent imports</h2>
        {list.length === 0 ? (
          <p className="muted small">None yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">What</th>
                  <th scope="col">Result</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {list.map((i) => (
                  <tr key={i.id}>
                    <td>{i.filename}</td>
                    <td className="small">{IMPORT_LABELS[i.kind as ImportKind]}</td>
                    <td>
                      <span className={`badge ${i.status === "COMMITTED" ? "badge-green" : i.status === "DISCARDED" ? "" : "badge-warn"}`}>
                        {i.status === "COMMITTED" ? `Imported ${i.summary.applied ?? 0}` : i.status === "DISCARDED" ? "Discarded" : "Awaiting confirmation"}
                      </span>
                    </td>
                    <td className="small muted">
                      {formatLagos(i.committed_at ?? i.created_at)} · {i.by_name}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

async function Contract() {
  const s = await currentSettings(db);
  const history = (
    await db.query<{
      version: number;
      reason: string;
      created_at: Date;
      by_name: string | null;
    }>(
      `SELECT v.version, v.reason, v.created_at, st.full_name AS by_name FROM altphones_settings v LEFT JOIN staff st ON st.id = v.created_by
        WHERE v.contract_template IS DISTINCT FROM (SELECT p.contract_template FROM altphones_settings p WHERE p.version = v.version - 1)
        ORDER BY v.version DESC LIMIT 10`,
    )
  ).rows.filter((h) => h.version > 1);
  const inForce = !!s.contract_template?.trim();
  return (
    <div className="stack">
      <section className="card" aria-labelledby="h-con">
        <div className="card-head">
          <h2 id="h-con">Customer contract</h2>
          <span className={`badge ${inForce ? "badge-green" : "badge-warn"}`}>{inForce ? `In force · settings version ${s.version}` : "Not set — credit sales cannot reach acceptance"}</span>
        </div>
        <p className="small muted" style={{ marginTop: 0 }}>
          Each customer receives this wording with their own figures and accepts it with a one-time code. Saving creates a new version; contracts already accepted keep the exact text the customer accepted.
        </p>
        <ActionForm action={contractAction} className="stack">
          <ContractEditor initial={s.contract_template ?? CONTRACT_DRAFT} isDraft={!inForce} />
          <div className="field">
            <label htmlFor="creason">Approval reference</label>
            <input id="creason" name="reason" required placeholder="Legal and Shariah approval reference" />
          </div>
          <div className="action-bar">
            <SubmitButton>Save wording</SubmitButton>
          </div>
        </ActionForm>
      </section>
      {history.length > 0 && (
        <section className="card" aria-labelledby="h-chist">
          <h2 id="h-chist">Wording history</h2>
          <ul className="alt-decisions">
            {history.map((h) => (
              <li key={h.version}>
                <strong>Version {h.version}</strong>{" "}
                <span className="small muted">
                  · {formatLagos(h.created_at)} · {h.by_name ?? "Migration"}
                </span>
                <div className="small">{h.reason}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
