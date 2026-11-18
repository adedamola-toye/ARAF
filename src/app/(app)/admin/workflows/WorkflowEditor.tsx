"use client";
import { useId, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Lock, Plus, Trash2 } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import {
  BUSINESS_STAGE_ROLE,
  BUSINESS_STAGE_TYPES,
  CREDIT_AUTHORITY,
  MAX_KOBO,
  MIN_KOBO,
  ROLE_NAMES,
  STAGE_NAMES,
  conditionLabel,
  diffDefinitions,
  naira,
  planRoute,
  sameDefinition,
  validateDefinition,
  type BusinessStage,
  type BusinessStageType,
  type CreditBand,
  type Family,
  type RetailPolicy,
  type WorkflowDefinition,
} from "@/lib/approval-workflow";
import { publishWorkflowAction } from "./actions";

type ProductConfigInfo = { policy: RetailPolicy; headOfUnitDistinct: boolean; version: number } | null;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** ₦ amount field holding kobo. Empty = null (no bound). Invalid text = NaN (reported by validation). */
function NairaInput({ id, value, onChange, placeholder, label }: { id: string; value: number | null; onChange: (k: number | null) => void; placeholder?: string; label: string }) {
  const [text, setText] = useState(value === null || Number.isNaN(value) ? "" : (value / 100).toFixed(2).replace(/\.00$/, ""));
  return (
    <input
      id={id}
      inputMode="decimal"
      aria-label={label}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const t = e.target.value.replace(/[₦,\s]/g, "");
        if (!t) return onChange(null);
        onChange(/^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : Number.NaN);
      }}
    />
  );
}

function Fixed({ name, roles, note }: { name: string; roles: string; note?: string }) {
  return (
    <li className="wf-stage is-fixed">
      <Lock className="icon" aria-hidden="true" />
      <div className="wf-stage-main">
        <strong>{name}</strong>
        <span className="small muted">
          {roles}
          {note ? ` · ${note}` : ""}
        </span>
      </div>
      <span className="badge">Mandatory</span>
    </li>
  );
}

function BusinessStages({ label, stages, onChange, uid }: { label: string; stages: BusinessStage[]; onChange: (s: BusinessStage[]) => void; uid: string }) {
  const missing = BUSINESS_STAGE_TYPES.filter((t) => !stages.some((s) => s.stage === t));
  const set = (i: number, patch: Partial<BusinessStage>) => onChange(stages.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) => {
    const n = [...stages];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    onChange(n);
  };
  return (
    <>
      {stages.map((s, i) => (
        <li key={s.stage} className="wf-stage">
          <span className="wf-step" aria-hidden="true">
            {i + 1}
          </span>
          <div className="wf-stage-main">
            <strong>{STAGE_NAMES[s.stage]}</strong>
            <span className="small muted">
              Approver: {ROLE_NAMES[BUSINESS_STAGE_ROLE[s.stage]]}
              {conditionLabel(s) ? ` · applies ${conditionLabel(s)}` : " · all amounts"}
              {s.followProductConfig ? " · when the product configuration requires it" : ""}
            </span>
            {s.stage !== "TEAM_LEAD_REVIEW" && (
              <div className="wf-cond">
                <div className="field">
                  <label htmlFor={`${uid}-${label}-${s.stage}-min`}>From (₦, optional)</label>
                  <NairaInput id={`${uid}-${label}-${s.stage}-min`} label={`${STAGE_NAMES[s.stage]} applies from`} value={s.minKobo} onChange={(v) => set(i, { minKobo: v })} placeholder="Any amount" />
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-${label}-${s.stage}-max`}>Up to (₦, optional)</label>
                  <NairaInput id={`${uid}-${label}-${s.stage}-max`} label={`${STAGE_NAMES[s.stage]} applies up to`} value={s.maxKobo} onChange={(v) => set(i, { maxKobo: v })} placeholder="Any amount" />
                </div>
                {s.stage === "HEAD_OF_UNIT_APPROVAL" && (
                  <label className="check small">
                    <input type="checkbox" checked={!!s.followProductConfig} onChange={(e) => set(i, { followProductConfig: e.target.checked || undefined })} />
                    <span>Only when the product configuration requires a distinct Head of Unit stage</span>
                  </label>
                )}
              </div>
            )}
          </div>
          <div className="wf-stage-tools">
            <button type="button" className="btn btn-ghost btn-sm" aria-label={`Move ${STAGE_NAMES[s.stage]} up`} disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp className="icon" aria-hidden="true" />
            </button>
            <button type="button" className="btn btn-ghost btn-sm" aria-label={`Move ${STAGE_NAMES[s.stage]} down`} disabled={i === stages.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown className="icon" aria-hidden="true" />
            </button>
            <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${STAGE_NAMES[s.stage]}`} onClick={() => onChange(stages.filter((_, j) => j !== i))}>
              <Trash2 className="icon" aria-hidden="true" />
            </button>
          </div>
        </li>
      ))}
      {missing.length > 0 && (
        <li className="wf-add">
          {missing.map((t) => (
            <button key={t} type="button" className="btn btn-sm" onClick={() => onChange([...stages, { stage: t as BusinessStageType, minKobo: null, maxKobo: null }])}>
              <Plus className="icon" aria-hidden="true" /> Add {STAGE_NAMES[t]}
            </button>
          ))}
        </li>
      )}
    </>
  );
}

function CreditBands({ bands, onChange, uid }: { bands: CreditBand[]; onChange: (b: CreditBand[]) => void; uid: string }) {
  const set = (i: number, patch: Partial<CreditBand>) => onChange(bands.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const toggle = (list: string[], r: string, on: boolean) => (on ? [...list, r] : list.filter((x) => x !== r));
  const add = () => {
    const last = bands[bands.length - 1];
    if (!last) return onChange([{ minKobo: MIN_KOBO, maxKobo: MAX_KOBO, firstReviewRoles: ["CREDIT_OFFICER_3"], secondReviewRoles: ["CREDIT_LEAD_1", "CREDIT_LEAD_2"] }]);
    // Split the highest route in two; the administrator then sets the boundary and roles.
    const mid = Math.floor((last.minKobo + last.maxKobo) / 2 / 100) * 100;
    onChange([...bands.slice(0, -1), { ...last, maxKobo: mid }, { ...clone(last), minKobo: mid + 1 }]);
  };
  return (
    <div className="wf-bands">
      {bands.map((b, i) => (
        <fieldset key={i} className="wf-band">
          <legend>Route {i + 1}</legend>
          <div className="wf-cond">
            <div className="field">
              <label htmlFor={`${uid}-b${i}-min`}>From (₦)</label>
              <NairaInput key={`min-${i}-${bands.length}`} id={`${uid}-b${i}-min`} label={`Route ${i + 1} from`} value={b.minKobo} onChange={(v) => set(i, { minKobo: v ?? Number.NaN })} />
            </div>
            <div className="field">
              <label htmlFor={`${uid}-b${i}-max`}>Up to (₦)</label>
              <NairaInput key={`max-${i}-${bands.length}`} id={`${uid}-b${i}-max`} label={`Route ${i + 1} up to`} value={b.maxKobo} onChange={(v) => set(i, { maxKobo: v ?? Number.NaN })} />
            </div>
          </div>
          <div className="grid-2">
            <fieldset className="wf-roles">
              <legend className="small">First credit review</legend>
              {Object.entries(CREDIT_AUTHORITY.first).map(([r, auth]) => (
                <label key={r} className="check small">
                  <input type="checkbox" checked={b.firstReviewRoles.includes(r)} onChange={(e) => set(i, { firstReviewRoles: toggle(b.firstReviewRoles, r, e.target.checked) })} />
                  <span>
                    {ROLE_NAMES[r]} <span className="muted">(authority up to {naira(auth)})</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <fieldset className="wf-roles">
              <legend className="small">Second credit review (concurrence)</legend>
              {Object.entries(CREDIT_AUTHORITY.second).map(([r, auth]) => (
                <label key={r} className="check small">
                  <input type="checkbox" checked={b.secondReviewRoles.includes(r)} onChange={(e) => set(i, { secondReviewRoles: toggle(b.secondReviewRoles, r, e.target.checked) })} />
                  <span>
                    {ROLE_NAMES[r]} <span className="muted">(authority up to {naira(auth)})</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </div>
          {bands.length > 1 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(bands.filter((_, j) => j !== i))}>
              <Trash2 className="icon" aria-hidden="true" /> Remove route {i + 1}
            </button>
          )}
        </fieldset>
      ))}
      <button type="button" className="btn btn-sm" onClick={add}>
        <Plus className="icon" aria-hidden="true" /> Split the highest route
      </button>
    </div>
  );
}

const ORIGINATORS: Record<Family, { v: string; l: string }[]> = {
  RETAIL: [
    { v: "RM", l: "Relationship Manager" },
    { v: "TEAM_LEAD", l: "Team Lead" },
    { v: "UNIT_HEAD", l: "Unit Head" },
    { v: "DELIGHT_OFFICER", l: "Delight Officer (requests started before the channel was retired)" },
  ],
  WAKEELBOOST: [
    { v: "RM", l: "Relationship Manager" },
    { v: "ANM", l: "Agent Network Manager" },
    { v: "MERCHANT_OFFICER", l: "Merchant Officer" },
  ],
  ALTPHONES: [
    { v: "DO", l: "Delight Officer" },
    { v: "SA", l: "Smile Associate" },
  ],
};

function RouteList({ def, input }: { def: WorkflowDefinition; input: Parameters<typeof planRoute>[1] }) {
  const r = planRoute(def, input);
  return (
    <>
      <ol className="wf-route">
        {r.stages.map((s, i) => (
          <li key={i}>
            <strong>{s.name}</strong>
            {s.roles.length > 0 && <span> · {s.roles.map((x) => ROLE_NAMES[x] ?? x).join(" / ")}</span>}
            {s.note && <span className="small muted"> · {s.note}</span>}
          </li>
        ))}
      </ol>
      {r.errors.map((e) => (
        <p key={e} className="err">
          {e}
        </p>
      ))}
    </>
  );
}

function Simulation({ family, current, draft, productConfig, changed }: { family: Family; current: WorkflowDefinition; draft: WorkflowDefinition; productConfig: ProductConfigInfo; changed: boolean }) {
  const uid = useId();
  const [amount, setAmount] = useState<number | null>(1_500_000_000);
  const [originator, setOriginator] = useState(ORIGINATORS[family][0].v);
  const [policy, setPolicy] = useState<RetailPolicy>(productConfig?.policy ?? "STANDARD");
  const [hou, setHou] = useState(productConfig?.headOfUnitDistinct ?? true);
  const [which, setWhich] = useState<"current" | "draft">("current");
  const [segment, setSegment] = useState<"" | "DBC" | "NON_DBC">("");
  const valid = amount !== null && !Number.isNaN(amount) && amount >= MIN_KOBO;
  const input = { amountKobo: amount ?? 0, initiatorRole: originator, policy, headOfUnitDistinct: hou, channel: originator as "DO" | "SA", segment: segment || null };
  return (
    <section className="card" aria-labelledby={`${uid}-sim`} style={{ marginTop: "var(--space-5)" }}>
      <div className="card-head">
        <h2 id={`${uid}-sim`}>Simulate a request</h2>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        Shows the approval route a request would follow, using the same routing as real submissions. Nothing is created and no approval is triggered.
      </p>
      <div className="wf-sim-form">
        <div className="field">
          <label htmlFor={`${uid}-amt`}>Financing amount (₦)</label>
          <NairaInput id={`${uid}-amt`} label="Financing amount" value={amount} onChange={setAmount} />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-orig`}>{family === "ALTPHONES" ? "Channel" : "Originated by"}</label>
          <select id={`${uid}-orig`} value={originator} onChange={(e) => setOriginator(e.target.value)}>
            {ORIGINATORS[family].map((o) => (
              <option key={o.v} value={o.v}>
                {o.l}
              </option>
            ))}
          </select>
        </div>
        {family !== "ALTPHONES" && originator === "RM" && (
          <div className="field">
            <label htmlFor={`${uid}-seg`}>RM classification</label>
            <select id={`${uid}-seg`} value={segment} onChange={(e) => setSegment(e.target.value as "" | "DBC" | "NON_DBC")}>
              <option value="">Not yet classified (existing route)</option>
              <option value="DBC">DBC</option>
              <option value="NON_DBC">Non-DBC (RBE → CX → Credit Officer → E-commerce Unit Head → Divisional Head)</option>
            </select>
          </div>
        )}
        {family === "RETAIL" && (
          <>
            <div className="field">
              <label htmlFor={`${uid}-pol`}>Approval policy</label>
              <select id={`${uid}-pol`} value={policy} onChange={(e) => setPolicy(e.target.value as RetailPolicy)}>
                <option value="STANDARD">Standard{productConfig?.policy === "STANDARD" ? " (current product configuration)" : ""}</option>
                <option value="RETAIL_CX_V1">CX policy{productConfig?.policy === "RETAIL_CX_V1" ? " (current product configuration)" : ""}</option>
              </select>
            </div>
            <label className="check small" style={{ alignSelf: "end" }}>
              <input type="checkbox" checked={hou} onChange={(e) => setHou(e.target.checked)} />
              <span>Product configuration requires a distinct Head of Unit stage</span>
            </label>
          </>
        )}
        {changed && (
          <div className="field">
            <label htmlFor={`${uid}-w`}>Workflow</label>
            <select id={`${uid}-w`} value={which} onChange={(e) => setWhich(e.target.value as "current" | "draft")}>
              <option value="current">Published version</option>
              <option value="draft">Your unpublished changes</option>
            </select>
          </div>
        )}
      </div>
      {valid ? <RouteList def={which === "draft" && changed ? draft : current} input={input} /> : <p className="err">Enter an amount of at least {naira(MIN_KOBO)}.</p>}
    </section>
  );
}

export function WorkflowEditor({ product, current, version, productConfig }: { product: { code: string; name: string; family: Family }; current: WorkflowDefinition; version: number; productConfig: ProductConfigInfo }) {
  const uid = useId();
  const [draft, setDraft] = useState<WorkflowDefinition>(() => clone(current));
  const [reason, setReason] = useState("");
  const family = product.family;
  const problems = useMemo(() => validateDefinition(draft, family), [draft, family]);
  const changes = useMemo(() => diffDefinitions(current, draft), [current, draft]);
  const changed = !sameDefinition(current, draft);
  const ready = changed && problems.length === 0 && reason.trim().length >= 20;
  const sampleAmounts = [100_000_000, 1_000_000_000, 3_000_000_000];

  if (family === "ALTPHONES") {
    return (
      <>
        <section className="card">
          <div className="card-head">
            <h2>Approval route</h2>
          </div>
          <ol className="wf-stages">
            <Fixed name={STAGE_NAMES.ALT_BPM} roles="Business Performance Manager" note="Smile Associate sales only; the BPM mapped to the sale's location" />
            <Fixed name={STAGE_NAMES.ALT_PM} roles="Altphones Product Manager" />
            <Fixed name={STAGE_NAMES.ALT_UH} roles="Unit Head" />
          </ol>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Every Altphones approval stage is mandatory under the approved governance, so there is nothing to change here. Pricing, the ₦29,000 down payment, tenors and stock rules are managed under Altphones settings and are unaffected.
          </p>
        </section>
        <Simulation family={family} current={current} draft={draft} productConfig={productConfig} changed={false} />
      </>
    );
  }

  return (
    <>
      <div className="wf-layout">
        <div className="stack">
          {family === "RETAIL" && (
            <>
              {(["standard", "cx"] as const).map((k) => (
                <section key={k} className="card" aria-labelledby={`${uid}-${k}`}>
                  <div className="card-head">
                    <h2 id={`${uid}-${k}`}>{k === "standard" ? "Standard route" : "CX route"}</h2>
                    {productConfig && productConfig.policy === (k === "standard" ? "STANDARD" : "RETAIL_CX_V1") && <span className="badge badge-blue">Used by the current product configuration</span>}
                  </div>
                  <p className="small muted" style={{ marginTop: 0 }}>
                    {k === "standard" ? "Business reviews, then credit review by amount, then the Unit Head and Divisional Head." : "Team Lead certification, then independent CX credit review, then the Unit Head and Divisional Head."} Approvals run one after another; parallel approval is not supported.
                  </p>
                  <ol className="wf-stages">
                    {k === "standard" && <Fixed name={STAGE_NAMES.OSS_REVIEW} roles="Outlet Service Supervisor" note="only requests started by a Delight Officer before that channel was retired" />}
                    <BusinessStages uid={uid} label={k} stages={draft[k]?.businessStages ?? []} onChange={(s) => setDraft({ ...draft, [k]: { businessStages: s } })} />
                    {k === "standard" ? (
                      <>
                        <Fixed name={STAGE_NAMES.FIRST_CREDIT_REVIEW} roles="By credit route (below)" />
                        <Fixed name={STAGE_NAMES.SECOND_CREDIT_REVIEW} roles="By credit route (below)" />
                      </>
                    ) : (
                      <Fixed name={STAGE_NAMES.CX_CREDIT_REVIEW} roles="CX Credit Reviewer" note="a Team Lead's or Unit Head's own request comes straight here" />
                    )}
                    <Fixed name={STAGE_NAMES.UNIT_HEAD_REVIEW} roles="Unit Head" note={k === "cx" ? "a Unit Head's own request goes to the Divisional Head instead" : undefined} />
                    <Fixed name={STAGE_NAMES.DIVISIONAL_HEAD_REVIEW} roles="Divisional Head" />
                  </ol>
                </section>
              ))}
            </>
          )}
          {family === "WAKEELBOOST" && (
            <section className="card">
              <div className="card-head">
                <h2>Approval route</h2>
              </div>
              <ol className="wf-stages">
                <Fixed name={STAGE_NAMES.BUSINESS_ENDORSEMENT} roles="Regional Business Executive / Merchant Officer Lead / ANM Lead" note="by originating channel" />
                <Fixed name={STAGE_NAMES.FIRST_CREDIT_REVIEW} roles="By credit route (below)" />
                <Fixed name={STAGE_NAMES.SECOND_CREDIT_REVIEW} roles="By credit route (below)" />
                <Fixed name={STAGE_NAMES.UNIT_HEAD_REVIEW} roles="Unit Head" />
                <Fixed name={STAGE_NAMES.DIVISIONAL_HEAD_REVIEW} roles="Divisional Head" />
              </ol>
            </section>
          )}
          <section className="card" aria-labelledby={`${uid}-bands`}>
            <div className="card-head">
              <h2 id={`${uid}-bands`}>Credit routes by amount</h2>
            </div>
            <p className="small muted" style={{ marginTop: 0 }}>
              {family === "RETAIL" ? "Used by the standard route. " : ""}Routes must cover {naira(MIN_KOBO)} – {naira(MAX_KOBO)} without gaps or overlaps. Each role may be given only amounts within its existing credit authority; the first reviewer and the concurring reviewer must be different roles.
            </p>
            <CreditBands uid={uid} bands={draft.creditBands ?? []} onChange={(b) => setDraft({ ...draft, creditBands: b })} />
          </section>
        </div>

        <aside className="card wf-preview" aria-labelledby={`${uid}-prev`}>
          <h2 id={`${uid}-prev`}>Preview changes</h2>
          {!changed ? (
            <p className="small muted">No changes yet. Edit the workflow to see a comparison with version {version}.</p>
          ) : (
            <>
              <p className="eyebrow">Changes from version {version}</p>
              <ul className="small wf-changes">
                {changes.map((c, i) => (
                  <li key={i} className={`wf-ch wf-ch-${c.kind.toLowerCase()}`}>
                    {c.text}
                  </li>
                ))}
              </ul>
              <p className="eyebrow">Example routes: published → proposed</p>
              {sampleAmounts.map((a) => {
                const input = { amountKobo: a, initiatorRole: "RM", policy: productConfig?.policy ?? "STANDARD", headOfUnitDistinct: productConfig?.headOfUnitDistinct ?? true };
                const before = planRoute(current, input).stages.map((s) => s.name);
                const after = planRoute(draft, input).stages.map((s) => s.name);
                return (
                  <div key={a} className="wf-compare small">
                    <strong>{naira(a)}</strong>
                    <span className="muted">{before.join(" → ")}</span>
                    {before.join() !== after.join() ? <span>{after.join(" → ") || "No route"}</span> : <span className="muted">(unchanged)</span>}
                  </div>
                );
              })}
            </>
          )}
          {changed && problems.length > 0 && (
            <div className="alert alert-warn" role="alert">
              <div>
                <strong>This workflow cannot be published yet:</strong>
                <ul className="small">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <ActionForm action={publishWorkflowAction} refreshOnSuccess={false}>
            {(st) => (
              <>
                <input type="hidden" name="productCode" value={product.code} />
                <input type="hidden" name="expectedVersion" value={version} />
                <input type="hidden" name="definition" value={JSON.stringify(draft)} />
                <div className="field">
                  <label htmlFor={`${uid}-reason`}>Reason for this change</label>
                  <textarea id={`${uid}-reason`} name="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={!!st.fields?.reason} aria-describedby={`${uid}-reason-h`} />
                  <p id={`${uid}-reason-h`} className="small muted" style={{ margin: 0 }}>
                    Required (at least 20 characters), e.g. the approving memo or committee decision.
                  </p>
                  {st.fields?.reason && <p className="err">{st.fields.reason}</p>}
                </div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <SubmitButton disabled={!ready}>Publish version {version + 1}</SubmitButton>
                  {changed && (
                    <button type="button" className="btn" onClick={() => setDraft(clone(current))}>
                      Discard changes
                    </button>
                  )}
                </div>
                <p className="small muted" style={{ margin: 0 }}>
                  Publishing takes effect immediately for requests submitted afterwards. No second approval is needed; the change is recorded with your name and reason.
                </p>
              </>
            )}
          </ActionForm>
        </aside>
      </div>
      <Simulation family={family} current={current} draft={draft} productConfig={productConfig} changed={changed} />
    </>
  );
}

/** Restore an earlier version by publishing it again as a new version (with a reason). */
export function RestoreForm({ productCode, restoreFromId, restoreVersion, expectedVersion }: { productCode: string; restoreFromId: string; restoreVersion: number; expectedVersion: number }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        Restore version {restoreVersion}…
      </button>
    );
  return (
    <ActionForm action={publishWorkflowAction} refreshOnSuccess={false} className="stack wf-restore">
      {(st) => (
        <>
          <input type="hidden" name="productCode" value={productCode} />
          <input type="hidden" name="expectedVersion" value={expectedVersion} />
          <input type="hidden" name="restoreFromId" value={restoreFromId} />
          <div className="field">
            <label htmlFor={`${uid}-r`}>Reason for restoring version {restoreVersion}</label>
            <textarea id={`${uid}-r`} name="reason" rows={2} aria-invalid={!!st.fields?.reason} />
            {st.fields?.reason && <p className="err">{st.fields.reason}</p>}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <SubmitButton>Publish as version {expectedVersion + 1}</SubmitButton>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </ActionForm>
  );
}
