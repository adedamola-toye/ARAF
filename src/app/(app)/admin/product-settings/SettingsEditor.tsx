"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { createContext, useContext, useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronLeft, ExternalLink, Lock, Plus, Trash2 } from "lucide-react";
import {
  APPLICANT_TYPES,
  DEFAULT_TYPES,
  PROFILE_NAMES,
  SECTIONS,
  blankProfile,
  completeness,
  describePath,
  diffSettings,
  publishChecks,
  sectionsWithErrors,
  type Cfg,
  type Change,
  type General,
  type SectionKey,
} from "@/lib/product-settings";
import { publishAction, reviewAction, saveDraftAction } from "./actions";

type Opt = [string, string];
export interface EditorProps {
  code: string;
  productName: string;
  config: Cfg;
  general: General;
  effectiveFrom: string | null;
  revision: number;
  readOnly: boolean;
  /** The version in force (for View changes). */
  published: { config: Cfg; general: General; version: number } | null;
  ceiling: Opt[];
  documents: Opt[];
  contractTypes: Opt[];
  approverRoles: Opt[];
  fulfilment: Opt[];
  workflowHref: string | null;
  today: string;
  draftNote: string | null;
}

const CONVENTIONS: Opt[] = [["FLAT_PER_ANNUM", "Flat per annum"], ["FLAT_FOR_TENOR", "Flat once for the tenor"], ["FLAT_PER_MONTH", "Flat per month"]];
const INSURANCE: Opt[] = [["CUSTOMER", "Customer bears the cost"], ["BANK", "Bank bears the cost"], ["NOT_APPLICABLE", "Not applicable"]];
const DENOMS: Opt[] = [
  ["VERIFIED_MONTHLY_NET_SALARY", "Verified monthly net salary"],
  ["VERIFIED_MONTHLY_GROSS_SALARY", "Verified monthly gross salary"],
  ["AVERAGE_MONTHLY_BUSINESS_TURNOVER", "Average monthly business turnover"],
  ["AVERAGE_MONTHLY_NET_CASH_INFLOW", "Average monthly net cash inflow"],
  ["AVERAGE_MONTHLY_NET_PROFIT", "Average monthly net profit"],
  ["AVERAGE_MONTHLY_INFLOW_FROM_ANNUAL", "Average monthly inflow (annual inflow ÷ 12)"],
];
const STAGES: Opt[] = [["SUBMISSION", "At submission"], ["CREDIT", "During credit review"], ["OFFER", "At offer"], ["PRE_DISBURSEMENT", "Before disbursement"]];
const LEVELS: Opt[] = [["MANDATORY", "Mandatory"], ["CONDITIONAL", "Conditional"], ["OPTIONAL", "Optional"]];
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
/** Locale-independent naira formatting (identical on the server and in the browser). */
const groupNaira = (n: number) => {
  const [i, d] = n.toFixed(2).split(".");
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${d === "00" ? "" : `.${d}`}`;
};
const fid = (path: string) => `ps-${path.replace(/[^A-Za-z0-9]+/g, "-")}`;

/* ------------------------------------------------------------------ field primitives */

const Errs = createContext<Record<string, string>>({});

function Field({ path, label, hint, children, wide }: { path: string; label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  const err = useContext(Errs)[path];
  return (
    <div className={`field${err ? " has-error" : ""}${wide ? " ps-wide" : ""}`} data-path={path}>
      <label htmlFor={fid(path)}>{label}</label>
      {children}
      {hint && !err && <span className="hint">{hint}</span>}
      {err && (
        <span className="err" id={`${fid(path)}-err`}>
          <AlertTriangle className="icon" aria-hidden="true" /> {err}
        </span>
      )}
    </div>
  );
}
const aria = (errs: Record<string, string>, path: string) => (errs[path] ? { "aria-invalid": true, "aria-describedby": `${fid(path)}-err` } : {});

function Text({ path, label, value, onChange, hint, area, placeholder }: { path: string; label: string; value: string | null | undefined; onChange: (v: string | null) => void; hint?: string; area?: boolean; placeholder?: string }) {
  const errs = useContext(Errs);
  const p = { id: fid(path), value: value ?? "", placeholder, ...aria(errs, path) };
  return (
    <Field path={path} label={label} hint={hint} wide={area}>
      {area ? <textarea rows={3} {...p} onChange={(e) => onChange(e.target.value || null)} /> : <input {...p} onChange={(e) => onChange(e.target.value || null)} />}
    </Field>
  );
}

/** Whole numbers (months, days, counts). Invalid text keeps the field empty and shows why. */
function Int({ path, label, value, onChange, hint, suffix }: { path: string; label: string; value: number | null | undefined; onChange: (v: number | null) => void; hint?: string; suffix?: string }) {
  const errs = useContext(Errs);
  const [text, setText] = useState(value === null || value === undefined ? "" : String(value));
  const bad = text !== "" && !/^\d+$/.test(text.trim());
  return (
    <Field path={path} label={label} hint={bad ? undefined : hint}>
      <span className="ps-affix">
        <input
          id={fid(path)}
          inputMode="numeric"
          value={text}
          {...aria(errs, path)}
          onChange={(e) => {
            setText(e.target.value);
            const t = e.target.value.trim();
            onChange(/^\d+$/.test(t) ? Number(t) : null);
          }}
        />
        {suffix && <span className="muted small">{suffix}</span>}
      </span>
      {bad && !errs[path] && <span className="err">Whole numbers only.</span>}
    </Field>
  );
}

/** Percentages are stored as text (exact decimals). */
function Pct({ path, label, value, onChange, hint }: { path: string; label: string; value: string | null | undefined; onChange: (v: string | null) => void; hint?: string }) {
  const errs = useContext(Errs);
  const bad = !!value && !/^\d{1,3}(\.\d{1,4})?$/.test(value);
  return (
    <Field path={path} label={label} hint={bad ? undefined : hint}>
      <span className="ps-affix">
        <input id={fid(path)} inputMode="decimal" value={value ?? ""} {...aria(errs, path)} onChange={(e) => onChange(e.target.value.trim() || null)} />
        <span className="muted small">%</span>
      </span>
      {bad && !errs[path] && <span className="err">Enter a percentage, e.g. 30 or 23.5.</span>}
    </Field>
  );
}

/** ₦ amount; stored in kobo. */
function Amount({ path, label, value, onChange, hint }: { path: string; label: string; value: number | null | undefined; onChange: (v: number | null) => void; hint?: string }) {
  const errs = useContext(Errs);
  const [text, setText] = useState(value === null || value === undefined ? "" : groupNaira(value / 100));
  const clean = text.replace(/[₦,\s]/g, "");
  const bad = clean !== "" && !/^\d+(\.\d{1,2})?$/.test(clean);
  return (
    <Field path={path} label={label} hint={bad ? undefined : hint}>
      <span className="ps-affix ps-prefix">
        <span className="muted small">₦</span>
        <input
          id={fid(path)}
          inputMode="decimal"
          value={text}
          {...aria(errs, path)}
          onChange={(e) => {
            setText(e.target.value);
            const t = e.target.value.replace(/[₦,\s]/g, "");
            onChange(/^\d+(\.\d{1,2})?$/.test(t) && Number(t) > 0 ? Math.round(Number(t) * 100) : null);
          }}
          onBlur={() => !bad && clean && setText(groupNaira(Number(clean)))}
        />
      </span>
      {bad && !errs[path] && <span className="err">Enter an amount in naira, e.g. 5,000,000.</span>}
    </Field>
  );
}

function Select({ path, label, value, options, onChange, hint, empty = "Not set" }: { path: string; label: string; value: string | null | undefined; options: Opt[]; onChange: (v: string | null) => void; hint?: string; empty?: string | false }) {
  const errs = useContext(Errs);
  return (
    <Field path={path} label={label} hint={hint}>
      <select id={fid(path)} value={value ?? ""} className={value ? "" : "unset"} {...aria(errs, path)} onChange={(e) => onChange(e.target.value || null)}>
        {empty !== false && <option value="">{empty}</option>}
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </Field>
  );
}

function YesNo({ path, label, value, onChange, hint, allowUnset }: { path: string; label: string; value: boolean | null | undefined; onChange: (v: boolean | null) => void; hint?: string; allowUnset?: boolean }) {
  return (
    <Select
      path={path}
      label={label}
      hint={hint}
      value={value === null || value === undefined ? "" : String(value)}
      options={[["true", "Yes"], ["false", "No"]]}
      empty={allowUnset ? "Not set" : false}
      onChange={(v) => onChange(v === null ? null : v === "true")}
    />
  );
}

function Checks({ path, legend, options, value, onChange, hint }: { path: string; legend: string; options: Opt[]; value: string[]; onChange: (v: string[]) => void; hint?: string }) {
  const err = useContext(Errs)[path];
  return (
    <fieldset className={`ps-checks${err ? " has-error" : ""}`} data-path={path} id={fid(path)} tabIndex={-1}>
      <legend>{legend}</legend>
      <div className="ps-check-row">
        {options.map(([v, l]) => (
          <label key={v} className="check small">
            <input type="checkbox" checked={value.includes(v)} onChange={(e) => onChange(e.target.checked ? [...value, v] : value.filter((x) => x !== v))} />
            <span>{l}</span>
          </label>
        ))}
      </div>
      {hint && !err && <span className="hint small muted">{hint}</span>}
      {err && (
        <span className="err">
          <AlertTriangle className="icon" aria-hidden="true" /> {err}
        </span>
      )}
    </fieldset>
  );
}

/** Contract steps, one per line (kept as typed so new lines can be added). */
function Steps({ id, value, onChange }: { id: string; value: string[] | null; onChange: (v: string[] | null) => void }) {
  const [text, setText] = useState((value ?? []).join("\n"));
  useEffect(() => {
    if (Array.isArray(value) && value.length === 0) setText("");
  }, [value]);
  return (
    <textarea
      id={id}
      rows={3}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const lines = e.target.value.split("\n").map((x) => x.trim()).filter(Boolean);
        onChange(lines.length ? lines : null);
      }}
    />
  );
}

function Fixed({ items, title = "Fixed controls (not configurable)" }: { items: [string, string][]; title?: string }) {
  return (
    <div className="ps-fixed">
      <p className="ps-fixed-title">
        <Lock className="icon" aria-hidden="true" /> {title}
      </p>
      <ul>
        {items.map(([t, d]) => (
          <li key={t}>
            <strong>{t}</strong> <span className="muted">{d}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ editor */

type SaveState = { kind: "clean" } | { kind: "dirty" } | { kind: "saving" } | { kind: "saved"; at: string } | { kind: "error"; message: string; conflict?: boolean };
interface Review {
  errors: Record<string, string>;
  warnings: string[];
  changes: Change[];
  nextVersion: number;
  firstVersion: boolean;
  stale: boolean;
  latestVersion: number | null;
  revision: number;
}

export function SettingsEditor(p: EditorProps) {
  const [cfg, setCfg] = useState<Cfg>(() => clone(p.config));
  const [general, setGeneral] = useState<General>(() => clone(p.general));
  const [effectiveFrom, setEffectiveFrom] = useState<string | null>(p.effectiveFrom ?? (p.readOnly ? null : p.today));
  const [revision, setRevision] = useState(p.revision);
  const [section, setSection] = useState<SectionKey>("general");
  const [save, setSave] = useState<SaveState>({ kind: "clean" });
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [mode, setMode] = useState<"edit" | "changes" | "review">("edit");
  const [review, setReview] = useState<Review | null>(null);
  const [reason, setReason] = useState("");
  const [publishError, setPublishError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [pending, start] = useTransition();
  const ro = p.readOnly;

  const opts = useMemo(() => ({ ceiling: p.ceiling.map(([v]) => v), knownDocuments: p.documents.map(([v]) => v) }), [p.ceiling, p.documents]);
  const local = useMemo(() => publishChecks(cfg, general, opts), [cfg, general, opts]);
  const errors = useMemo(() => (showErrors || ro ? { ...local.errors, ...serverErrors } : serverErrors), [showErrors, ro, local.errors, serverErrors]);
  const bad = useMemo(() => sectionsWithErrors(errors), [errors]);
  const done = useMemo(() => completeness(cfg, general, opts), [cfg, general, opts]);
  const changes = useMemo(() => diffSettings({ config: p.published?.config ?? {}, general: p.published ? p.published.general : p.general }, { config: cfg, general }), [p.published, p.general, cfg, general]);
  const dirty = save.kind === "dirty" || (save.kind === "error" && !save.conflict);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const touch = () => {
    setSave({ kind: "dirty" });
    setReview(null);
  };
  const upd = (fn: (c: Cfg) => void) => {
    const c = clone(cfg);
    fn(c);
    setCfg(c);
    touch();
  };
  const updG = (patch: Partial<General>) => {
    setGeneral({ ...general, ...patch });
    touch();
  };

  async function doSave(): Promise<number | null> {
    setSave({ kind: "saving" });
    const r = await saveDraftAction(p.code, { config: cfg, general, effectiveFrom, revision });
    if (!r.ok) {
      setServerErrors(r.fields ?? {});
      if (r.fields) setShowErrors(true);
      setSave({ kind: "error", message: r.error ?? "Not saved.", conflict: /another window|changed since/.test(r.error ?? "") });
      return null;
    }
    setServerErrors({});
    setRevision(r.revision!);
    setSave({ kind: "saved", at: r.savedAt! });
    return r.revision!;
  }

  const onSave = () => start(async () => void (await doSave()));
  const onReview = () =>
    start(async () => {
      setShowErrors(true);
      setPublishError(null);
      const rev = dirty || save.kind === "clean" ? await doSave() : revision;
      if (rev === null) return;
      const r = await reviewAction(p.code);
      if (!r.ok) return setPublishError({ message: r.error ?? "The review could not be completed." });
      setReview(r.data as Review);
      setServerErrors((r.data as Review).errors);
      setMode("review");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  const onPublish = () =>
    start(async () => {
      setPublishError(null);
      const r = await publishAction(p.code, { reason, revision, effectiveFrom });
      // On success the server redirects to the confirmation; reaching here means it was refused.
      if (r && !r.ok) {
        setPublishError({ message: r.error ?? "Not published.", fields: r.fields });
        if (r.fields) setServerErrors(Object.fromEntries(Object.entries(r.fields).filter(([k]) => k !== "reason" && k !== "effectiveFrom")));
      }
    });

  const goTo = (path: string) => {
    const s = path === "reason" || path === "effectiveFrom" ? "general" : path === "profiles" ? "eligibility" : describePath(path).section;
    setMode("edit");
    setSection(s);
    setTimeout(() => {
      const el = document.getElementById(fid(path)) ?? document.querySelector<HTMLElement>(`[data-path="${path}"]`);
      el?.scrollIntoView({ block: "center" });
      el?.focus();
    }, 50);
  };

  const profiles = Object.keys(PROFILE_NAMES).filter((k) => cfg.profiles?.[k]);
  const offered = profiles.filter((k) => cfg.profiles[k].enabled);
  // A plain function (not a component) so inputs keep focus between renders.
  const P = ({ children }: { children: (k: string, r: any) => ReactNode }) => (
    <>
      {offered.length === 0 && <p className="small muted">Offer the product to a customer profile under Eligibility &amp; KYC first.</p>}
      {offered.map((k) => (
        <fieldset key={k} className="ps-profile">
          <legend>{PROFILE_NAMES[k]}</legend>
          {children(k, cfg.profiles[k])}
        </fieldset>
      ))}
    </>
  );
  const at = (k: string, f: string) => `profiles.${k}.${f}`;

  /* ---------------- sections ---------------- */

  const generalSection = (
    <>
      <div className="grid-2">
        <Text path="general.name" label="Product name" value={general.name} onChange={(v) => updG({ name: v ?? "" })} />
        <Text path="general.owner" label="Product owner" value={general.owner} onChange={(v) => updG({ owner: v ?? "" })} hint="The business owner accountable for the product, e.g. Head of Retail." />
      </div>
      <Text path="general.description" label="Description" area value={general.description} onChange={(v) => updG({ description: v ?? "" })} hint="Shown to staff choosing a product." />
      <div className="grid-2">
        <Field path="general.active" label="Availability">
          <label className="check">
            <input id={fid("general.active")} type="checkbox" checked={general.active} onChange={(e) => updG({ active: e.target.checked })} />
            <span>Open for new applications</span>
          </label>
        </Field>
        <Field path="effectiveFrom" label="Effective date" hint="Requests started on or after this date use the new rules. Today means immediately on publication.">
          <input id={fid("effectiveFrom")} type="date" min={p.today} value={effectiveFrom ?? ""} {...aria(errors, "effectiveFrom")} onChange={(e) => (setEffectiveFrom(e.target.value || null), touch())} />
        </Field>
      </div>
      <fieldset className="ps-checks" data-path="general.originationRoles" id={fid("general.originationRoles")} tabIndex={-1}>
        <legend>Who can originate this product</legend>
        <label className="check small">
          <input type="radio" name="orig" checked={general.originationRoles === null} onChange={() => updG({ originationRoles: null })} />
          <span>Every role permitted for this product type ({p.ceiling.map(([, l]) => l).join(", ")})</span>
        </label>
        <label className="check small">
          <input type="radio" name="orig" checked={general.originationRoles !== null} onChange={() => updG({ originationRoles: p.ceiling.map(([v]) => v) })} />
          <span>Only these roles</span>
        </label>
        {general.originationRoles !== null && (
          <div className="ps-check-row ps-indent">
            {p.ceiling.map(([v, l]) => (
              <label key={v} className="check small">
                <input type="checkbox" checked={general.originationRoles!.includes(v)} onChange={(e) => updG({ originationRoles: e.target.checked ? [...general.originationRoles!, v] : general.originationRoles!.filter((x) => x !== v) })} />
                <span>{l}</span>
              </label>
            ))}
          </div>
        )}
        {errors["general.originationRoles"] && (
          <span className="err">
            <AlertTriangle className="icon" aria-hidden="true" /> {errors["general.originationRoles"]}
          </span>
        )}
        <span className="hint small muted">Enforced on the product picker, the request pages and the server. Roles outside this product type can never be added.</span>
      </fieldset>
      <div className="grid-2">
        <Int path="draftExpiryDays" label="Unsubmitted drafts expire after" suffix="days" value={cfg.draftExpiryDays} onChange={(v) => upd((c) => (c.draftExpiryDays = v))} hint="Leave empty for no expiry." />
      </div>
    </>
  );

  const eligibilitySection = (
    <>
      <fieldset className="ps-checks" data-path="profiles" id={fid("profiles")} tabIndex={-1}>
        <legend>Customer profiles offered</legend>
        <div className="ps-check-row">
          {Object.entries(PROFILE_NAMES).map(([k, l]) => (
            <label key={k} className="check small">
              <input
                type="checkbox"
                checked={!!cfg.profiles?.[k]?.enabled}
                onChange={(e) =>
                  upd((c) => {
                    if (!c.profiles[k]) c.profiles[k] = blankProfile(DEFAULT_TYPES[k]);
                    c.profiles[k].enabled = e.target.checked;
                  })
                }
              />
              <span>{l}</span>
            </label>
          ))}
        </div>
        {errors.profiles && (
          <span className="err">
            <AlertTriangle className="icon" aria-hidden="true" /> {errors.profiles}
          </span>
        )}
      </fieldset>
      {P({ children: (k, r) => (
          <>
            <Checks path={at(k, "eligibleApplicantTypes")} legend="Eligible customer types" options={APPLICANT_TYPES} value={r.eligibleApplicantTypes ?? []} onChange={(v) => upd((c) => (c.profiles[k].eligibleApplicantTypes = v))} />
            <Text path={at(k, "eligibilityNote")} label="Eligibility conditions" area value={r.eligibilityNote} onChange={(v) => upd((c) => (c.profiles[k].eligibilityNote = v))} hint="Shown to the originator, e.g. minimum time in business." />
            <div className="grid-3">
              <Int path={at(k, "statementMonths")} label="Bank statement period" suffix="months" value={r.statementMonths} onChange={(v) => upd((c) => (c.profiles[k].statementMonths = v))} />
              {k === "SALARY_EARNER" && <Int path={at(k, "payslipMonths")} label="Payslip / salary history" suffix="months" value={r.payslipMonths} onChange={(v) => upd((c) => (c.profiles[k].payslipMonths = v))} />}
              <Int path={at(k, "statementMaxAgeDays")} label="Statement recency" suffix="days" value={r.statementMaxAgeDays} onChange={(v) => upd((c) => (c.profiles[k].statementMaxAgeDays = v))} hint="Maximum days between statement end and submission. Empty: not checked." />
            </div>
            <label className="check small">
              <input type="checkbox" checked={!!r.assetEligibility?.required} onChange={(e) => upd((c) => (c.profiles[k].assetEligibility = { required: e.target.checked, criteria: c.profiles[k].assetEligibility?.criteria ?? null }))} />
              <span>The financed asset must meet eligibility criteria</span>
            </label>
            {r.assetEligibility?.required && <Text path={at(k, "assetEligibility.criteria")} label="Asset eligibility criteria" area value={r.assetEligibility.criteria} onChange={(v) => upd((c) => (c.profiles[k].assetEligibility.criteria = v))} />}
          </>
)})}
      {(cfg.privacyConsents ?? []).length > 0 && (
        <div className="ps-fixed">
          <p className="ps-fixed-title">Customer consents collected</p>
          <ul>
            {cfg.privacyConsents.map((c: any) => (
              <li key={c.code}>
                <span className="mono small">{c.code}</span> <span className="muted">{c.purpose}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Fixed
        items={[
          ["BVN and identity verification", "required for every applicant."],
          ["SeedFi credit check", "run before submission on every request."],
          ["KYC documents", "the identity documents in the onboarding checklist are always required."],
        ]}
      />
    </>
  );

  const financingSection = (
    <>
      {P({ children: (k, r) => (
          <>
            <div className="grid-2">
              <Amount path={at(k, "minAmountKobo")} label="Minimum financing amount" value={r.minAmountKobo} onChange={(v) => upd((c) => (c.profiles[k].minAmountKobo = v))} hint="Optional. Requests below it cannot be submitted." />
              <Amount path={at(k, "maxAmountKobo")} label="Maximum financing amount" value={r.maxAmountKobo} onChange={(v) => upd((c) => (c.profiles[k].maxAmountKobo = v))} />
              <Int path={at(k, "minTenorMonths")} label="Minimum tenor" suffix="months" value={r.minTenorMonths} onChange={(v) => upd((c) => (c.profiles[k].minTenorMonths = v))} hint="Optional." />
              <Int path={at(k, "maxTenorMonths")} label="Maximum tenor" suffix="months" value={r.maxTenorMonths} onChange={(v) => upd((c) => (c.profiles[k].maxTenorMonths = v))} />
            </div>
            <p className="small muted ps-inline-fixed">
              <Lock className="icon" aria-hidden="true" /> Repayment frequency: monthly. Fees are entered at credit assessment.
            </p>
            <h4 className="ps-sub">Contract structures and pricing</h4>
            <div data-path={at(k, "structures")} id={fid(at(k, "structures"))} tabIndex={-1}>
              {(r.structures ?? []).map((s: any, i: number) => (
                <div key={s.code} className="ps-row">
                  <div className="ps-row-head">
                    <strong>{p.contractTypes.find(([v]) => v === s.code)?.[1] ?? s.label ?? s.code}</strong>
                    <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${s.code}`} onClick={() => upd((c) => c.profiles[k].structures.splice(i, 1))}>
                      <Trash2 className="icon" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="grid-3">
                    <Pct path={at(k, `structures.${s.code}.ratePercent`)} label="Rate" value={s.ratePercent} onChange={(v) => upd((c) => (c.profiles[k].structures[i].ratePercent = v))} />
                    <Select path={at(k, `structures.${s.code}.rateConvention`)} label="How the rate is applied" value={s.rateConvention} options={CONVENTIONS} onChange={(v) => upd((c) => (c.profiles[k].structures[i].rateConvention = v))} />
                    <Select path={at(k, `structures.${s.code}.insuranceBearer`)} label="Insurance" value={s.insuranceBearer} options={INSURANCE} onChange={(v) => upd((c) => (c.profiles[k].structures[i].insuranceBearer = v))} />
                  </div>
                  <Field path={at(k, `structures.${s.code}.contractSequence`)} label="Contract steps (one per line)" hint={s.contractSequence === null ? "Not set: contracting stays blocked until the steps are entered." : undefined}>
                    <Steps id={fid(at(k, `structures.${s.code}.contractSequence`))} value={s.contractSequence} onChange={(v) => upd((c) => (c.profiles[k].structures[i].contractSequence = v))} />
                  </Field>
                  <label className="check small">
                    <input type="checkbox" checked={Array.isArray(s.contractSequence) && s.contractSequence.length === 0} onChange={(e) => upd((c) => (c.profiles[k].structures[i].contractSequence = e.target.checked ? [] : null))} />
                    <span>No structure-specific contract steps apply</span>
                  </label>
                </div>
              ))}
              {errors[at(k, "structures")] && (
                <span className="err">
                  <AlertTriangle className="icon" aria-hidden="true" /> {errors[at(k, "structures")]}
                </span>
              )}
              <div className="ps-add">
                {p.contractTypes
                  .filter(([v]) => !(r.structures ?? []).some((s: any) => s.code === v))
                  .map(([v, l]) => (
                    <button key={v} type="button" className="btn btn-sm" onClick={() => upd((c) => c.profiles[k].structures.push({ code: v, label: l, ratePercent: null, rateConvention: null, insuranceBearer: null, contractSequence: null }))}>
                      <Plus className="icon" aria-hidden="true" /> {l}
                    </button>
                  ))}
              </div>
            </div>
            <h4 className="ps-sub">Affordability</h4>
            <div className="grid-3">
              <Pct path={at(k, "dsr.maxPercent")} label="Maximum DSR" value={r.dsr?.maxPercent} onChange={(v) => upd((c) => (c.profiles[k].dsr.maxPercent = v))} />
              <Select path={at(k, "dsr.denominator")} label="DSR income basis" value={r.dsr?.denominator} options={DENOMS} onChange={(v) => upd((c) => (c.profiles[k].dsr.denominator = v))} />
              <Pct path={at(k, "dsr.inflowRecognitionPercent")} label="Income recognised" value={r.dsr?.inflowRecognitionPercent} onChange={(v) => upd((c) => (c.profiles[k].dsr.inflowRecognitionPercent = v ?? "100"))} hint="Share of verified inflow counted for affordability." />
            </div>
            <div className="grid-2">
              <YesNo path={at(k, "equityContribution.applies")} label="Equity contribution applies" value={r.equityContribution?.applies} allowUnset onChange={(v) => upd((c) => (c.profiles[k].equityContribution = { applies: v, minPercent: v ? c.profiles[k].equityContribution?.minPercent ?? null : null }))} />
              {r.equityContribution?.applies && <Pct path={at(k, "equityContribution.minPercent")} label="Minimum equity" value={r.equityContribution.minPercent} onChange={(v) => upd((c) => (c.profiles[k].equityContribution.minPercent = v))} />}
              <YesNo path={at(k, "principalTurnoverCap.applies")} label="Principal-to-turnover cap applies" value={r.principalTurnoverCap?.applies ?? false} onChange={(v) => upd((c) => (c.profiles[k].principalTurnoverCap = { applies: !!v, maxPercent: v ? c.profiles[k].principalTurnoverCap?.maxPercent ?? null : null }))} hint="Separate from DSR." />
              {r.principalTurnoverCap?.applies && <Pct path={at(k, "principalTurnoverCap.maxPercent")} label="Cap (% of turnover)" value={r.principalTurnoverCap.maxPercent} onChange={(v) => upd((c) => (c.profiles[k].principalTurnoverCap.maxPercent = v))} />}
            </div>
          </>
)})}
      <h4 className="ps-sub">Disbursement and fulfilment</h4>
      <YesNo path="beneficiaryRequired" label="Pay only a beneficiary from the approved vendor register" value={cfg.beneficiaryRequired ?? true} onChange={(v) => upd((c) => (c.beneficiaryRequired = !!v))} />
      <Checks path="fulfilmentSteps" legend="After-payment fulfilment steps" options={p.fulfilment} value={cfg.fulfilmentSteps ?? []} onChange={(v) => upd((c) => (c.fulfilmentSteps = v))} hint="Created only after payment is confirmed and reconciled." />
    </>
  );

  const workflowSection = (
    <>
      <Select
        path="approvalPolicy"
        label="Approval chain"
        value={cfg.approvalPolicy ?? "STANDARD"}
        empty={false}
        options={[
          ["STANDARD", "Standard: Team Lead → Head of Retail Sales → Head of Unit → credit reviews → Unit Head → Divisional Head"],
          ["RETAIL_CX_V1", "CX policy: Team Lead certification → CX credit review → Unit Head → Divisional Head"],
        ]}
        onChange={(v) => upd((c) => (c.approvalPolicy = v))}
      />
      {cfg.approvalPolicy !== "RETAIL_CX_V1" && (
        <Select path="businessReview.headOfUnitStage" label="Head of Unit stage" value={cfg.businessReview?.headOfUnitStage} options={[["DISTINCT", "A separate approval stage after Head of Retail Sales"], ["NOT_REQUIRED", "Not required"]]} onChange={(v) => upd((c) => (c.businessReview.headOfUnitStage = v))} />
      )}
      <div className="ps-link-card">
        <div>
          <strong>Approval stages, amount thresholds and credit authority</strong>
          <p className="small muted" style={{ margin: "2px 0 0" }}>Set in the approval workflow, versioned and published separately. Requests keep the workflow they were submitted under.</p>
        </div>
        {p.workflowHref ? (
          <Link href={p.workflowHref} className="btn btn-sm">
            Open approval workflow <ExternalLink className="icon" aria-hidden="true" />
          </Link>
        ) : (
          <span className="small muted">This product uses the default Retail workflow.</span>
        )}
      </div>
      <Fixed
        items={[
          ["Segregation of duties", "the originator never reviews or approves their own request."],
          ["No self-approval", "no one approves a stage they acted on earlier in the same request."],
          ["Approval verification checklist", "every approver confirms the checklist before approving."],
          ["Alternate approvers", "any active holder of the stage's role can act (the role pool)."],
          ["Escalation", "uses the service targets set under Administration."],
        ]}
      />
    </>
  );

  const documentsSection = (
    <>
      {P({ children: (k, r) => (
          <>
            <div data-path={at(k, "documents")} id={fid(at(k, "documents"))} tabIndex={-1} className="ps-docs">
              {(r.documents ?? []).map((d: any, i: number) => (
                <div key={`${d.code}-${i}`} className="ps-row">
                  <div className="ps-row-head">
                    <strong>{p.documents.find(([v]) => v === d.code)?.[1] ?? d.code}</strong>
                    <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${d.code}`} onClick={() => upd((c) => c.profiles[k].documents.splice(i, 1))}>
                      <Trash2 className="icon" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="grid-4">
                    <Select path={at(k, `documents.${d.code}.requirement`)} label="Requirement" value={d.requirement} options={LEVELS} empty={false} onChange={(v) => upd((c) => (c.profiles[k].documents[i].requirement = v))} />
                    <Select path={at(k, `documents.${d.code}.stage`)} label="Stage" value={d.stage} options={STAGES} empty={false} onChange={(v) => upd((c) => (c.profiles[k].documents[i].stage = v))} />
                    <Int path={at(k, `documents.${d.code}.minCount`)} label="Number of files" value={d.minCount ?? 1} onChange={(v) => upd((c) => (c.profiles[k].documents[i].minCount = v ?? 1))} />
                    {d.requirement === "CONDITIONAL" ? (
                      <Amount path={at(k, `documents.${d.code}.amountAboveKobo`)} label="Required above" value={d.amountAboveKobo} onChange={(v) => upd((c) => (c.profiles[k].documents[i].amountAboveKobo = v))} />
                    ) : (
                      <span />
                    )}
                  </div>
                  <Text path={at(k, `documents.${d.code}.note`)} label="Guidance for the originator" value={d.note} onChange={(v) => upd((c) => (c.profiles[k].documents[i].note = v))} />
                </div>
              ))}
              {errors[at(k, "documents")] && (
                <span className="err">
                  <AlertTriangle className="icon" aria-hidden="true" /> {errors[at(k, "documents")]}
                </span>
              )}
              <div className="ps-add">
                <label className="sr-only" htmlFor={`add-doc-${k}`}>
                  Add a document
                </label>
                <select
                  id={`add-doc-${k}`}
                  value=""
                  onChange={(e) => {
                    const code = e.target.value;
                    if (code) upd((c) => c.profiles[k].documents.push({ code, requirement: "MANDATORY", stage: "SUBMISSION", minCount: 1, coverageFrom: code === "BANK_STATEMENT" ? "statementMonths" : code === "PAYSLIP" ? "payslipMonths" : null, amountAboveKobo: null, structures: null, exceptionType: null, note: null }));
                  }}
                >
                  <option value="">Add a document…</option>
                  {p.documents
                    .filter(([v]) => !(r.documents ?? []).some((d: any) => d.code === v))
                    .map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <div className="grid-3">
              <Int path={at(k, "businessPhotos.minDistinct")} label="Business photographs (distinct angles)" value={r.businessPhotos?.minDistinct ?? 0} onChange={(v) => upd((c) => (c.profiles[k].businessPhotos = { ...(c.profiles[k].businessPhotos ?? { rmPhotoRequired: false }), minDistinct: v ?? 0 }))} />
              <YesNo path={at(k, "businessPhotos.rmPhotoRequired")} label="Photograph of the RM at the business" value={r.businessPhotos?.rmPhotoRequired ?? false} onChange={(v) => upd((c) => (c.profiles[k].businessPhotos = { ...(c.profiles[k].businessPhotos ?? { minDistinct: 0 }), rmPhotoRequired: !!v }))} />
              <YesNo path={at(k, "rmProposalRequired")} label="RM credit proposal required" value={r.rmProposalRequired ?? false} onChange={(v) => upd((c) => (c.profiles[k].rmProposalRequired = !!v))} />
            </div>
          </>
)})}
    </>
  );

  const controlsSection = (
    <>
      {P({ children: (k, r) => (
          <>
            <div className="grid-2">
              <YesNo path={at(k, "dsr.exceptionAllowed")} label="DSR exceptions permitted" value={r.dsr?.exceptionAllowed ?? false} onChange={(v) => upd((c) => (c.profiles[k].dsr.exceptionAllowed = !!v))} />
              {r.dsr?.exceptionAllowed && <Select path={at(k, "dsr.exceptionApproverRole")} label="Who may approve a DSR exception" value={r.dsr.exceptionApproverRole} options={p.approverRoles} onChange={(v) => upd((c) => (c.profiles[k].dsr.exceptionApproverRole = v))} />}
              <YesNo path={at(k, "visitRequired")} label="Management visit required" value={r.visitRequired} allowUnset onChange={(v) => upd((c) => (c.profiles[k].visitRequired = v))} />
            </div>
            <label className="check small">
              <input type="checkbox" checked={!!r.afs} onChange={(e) => upd((c) => (c.profiles[k].afs = e.target.checked ? { thresholdKobo: null, exceptionApproverRole: null } : null))} />
              <span>Audited financial statements required above an amount</span>
            </label>
            {r.afs && (
              <div className="grid-2">
                <Amount path={at(k, "afs.thresholdKobo")} label="Audited accounts required above" value={r.afs.thresholdKobo} onChange={(v) => upd((c) => (c.profiles[k].afs.thresholdKobo = v))} />
                <Select path={at(k, "afs.exceptionApproverRole")} label="Who may waive audited accounts" value={r.afs.exceptionApproverRole} options={p.approverRoles} onChange={(v) => upd((c) => (c.profiles[k].afs.exceptionApproverRole = v))} />
              </div>
            )}
          </>
)})}
      <Select path="servicing.restructureApproverRole" label="Who may approve a restructure" value={cfg.servicing?.restructureApproverRole} options={p.approverRoles} onChange={(v) => upd((c) => (c.servicing = { ...(c.servicing ?? {}), restructureApproverRole: v }))} />
      <Fixed
        items={[
          ["Shariah contract steps", "the contract sequence for each structure cannot be skipped."],
          ["Mandatory documents", "cannot be waived except through a permitted, approved exception."],
          ["Audit trail", "every change and decision is recorded."],
        ]}
      />
    </>
  );

  const body: Record<SectionKey, ReactNode> = { general: generalSection, eligibility: eligibilitySection, financing: financingSection, workflow: workflowSection, documents: documentsSection, controls: controlsSection };
  const current = SECTIONS.find((s) => s.key === section)!;

  /* ---------------- render ---------------- */

  const status =
    save.kind === "saving" ? (
      <span className="ps-save muted">Saving…</span>
    ) : save.kind === "saved" ? (
      <span className="ps-save ps-ok">
        <CheckCircle2 className="icon" aria-hidden="true" /> Saved {new Date(save.at).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" })}
      </span>
    ) : save.kind === "dirty" ? (
      <span className="ps-save ps-warn">Unsaved changes</span>
    ) : save.kind === "error" ? (
      <span className="ps-save ps-bad">Not saved</span>
    ) : (
      <span className="ps-save muted">{p.draftNote ?? "No changes yet"}</span>
    );

  if (mode === "review" && review && !ro) {
    const blocking = Object.entries(review.errors);
    const reasonLen = reason.trim().length;
    return (
      <section className="card ps-review" aria-labelledby="ps-review-h">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode("edit")}>
          <ChevronLeft className="icon" aria-hidden="true" /> Back to editing
        </button>
        <h2 id="ps-review-h">Review configuration: {p.productName}</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          {review.firstVersion ? "Publishing creates version 1 of this product's rules." : `Publishing creates version ${review.nextVersion}, replacing version ${review.latestVersion} from the effective date.`} Requests already started keep the version they started under.
        </p>
        {review.stale && (
          <div className="alert alert-error" role="alert">
            Version {review.latestVersion} was published after this draft was started. Discard this draft and start again from version {review.latestVersion} so no change is lost.
          </div>
        )}
        {blocking.length > 0 ? (
          <div className="alert alert-error" role="alert">
            <div>
              <strong>
                {blocking.length} item{blocking.length === 1 ? "" : "s"} must be fixed before publishing
              </strong>
              <ul className="ps-issue-list">
                {blocking.map(([k, v]) => (
                  <li key={k}>
                    <button type="button" className="linkish" onClick={() => goTo(k)}>
                      {describePath(k).label}
                    </button>
                    : {v}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <div className="alert alert-success" role="status">
            <CheckCircle2 className="icon" aria-hidden="true" /> All required settings are complete.
          </div>
        )}
        {review.warnings.length > 0 && (
          <div className="alert alert-warn">
            <div>
              <strong>Check before publishing</strong>
              <ul className="ps-issue-list">
                {review.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <h3>Changes {review.firstVersion ? "(first version)" : `from version ${review.latestVersion}`}</h3>
        <ChangeList changes={review.changes} />
        <div className="grid-2" style={{ marginTop: "var(--space-4)" }}>
          <Errs.Provider value={publishError?.fields ?? {}}>
            <Field path="effectiveFrom" label="Effective date" hint="Today publishes immediately.">
              <input id={fid("effectiveFrom")} type="date" min={p.today} value={effectiveFrom ?? ""} onChange={(e) => setEffectiveFrom(e.target.value || null)} />
            </Field>
            <Field path="reason" label="Reason for the change" hint={`${reasonLen} of at least 20 characters. Cite the approving memo or decision.`}>
              <textarea id={fid("reason")} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Credit committee memo CC/2026/14 approved the revised limits" />
            </Field>
          </Errs.Provider>
        </div>
        {publishError && (
          <div className="alert alert-error" role="alert">
            <strong>Not published: </strong>
            {publishError.message}
          </div>
        )}
        <div className="ps-actions">
          <button type="button" className="btn btn-primary" disabled={pending || blocking.length > 0 || review.stale || reasonLen < 20 || !effectiveFrom} onClick={onPublish}>
            {pending ? "Publishing…" : "Publish Product Rules"}
          </button>
          <button type="button" className="btn" onClick={() => setMode("edit")}>
            Edit Configuration
          </button>
        </div>
      </section>
    );
  }

  return (
    <Errs.Provider value={errors}>
      <div className="ps-layout">
        <nav className="ps-nav" aria-label="Settings sections">
          {!ro && (
            <div className="ps-progress" aria-label={`Configuration ${done.percent}% complete`}>
              <div className="ps-progress-head">
                <span className="small">Complete</span>
                <strong>{done.percent}%</strong>
              </div>
              <div className="ps-bar">
                <span style={{ width: `${done.percent}%` }} />
              </div>
            </div>
          )}
          <ul>
            {SECTIONS.map((s) => (
              <li key={s.key}>
                <button type="button" className={`ps-nav-item${section === s.key && mode === "edit" ? " is-active" : ""}`} aria-current={section === s.key && mode === "edit" ? "true" : undefined} onClick={() => (setSection(s.key), setMode("edit"))}>
                  <span>{s.title}</span>
                  {bad.has(s.key) && (
                    <span className="ps-dot" aria-label="has items to fix">
                      !
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ps-main">
          {!ro && (
            <div className="ps-toolbar">
              {status}
              <div className="ps-toolbar-actions">
                <button type="button" className="btn btn-sm" onClick={() => setMode(mode === "changes" ? "edit" : "changes")}>
                  {mode === "changes" ? "Back to editing" : `View Changes (${changes.length})`}
                </button>
                <button type="button" className="btn btn-sm" disabled={pending} onClick={onSave}>
                  Save Draft
                </button>
                <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={onReview}>
                  Review Configuration
                </button>
              </div>
            </div>
          )}
          {save.kind === "error" && (
            <div className="alert alert-error" role="alert">
              <span>
                <strong>Not saved: </strong>
                {save.message}{" "}
                {save.conflict && (
                  <button type="button" className="linkish" onClick={() => window.location.reload()}>
                    Reload the latest draft
                  </button>
                )}
              </span>
            </div>
          )}
          {publishError && mode === "edit" && (
            <div className="alert alert-error" role="alert">
              {publishError.message}
            </div>
          )}
          {mode === "changes" ? (
            <section className="card">
              <h2>Changes {p.published ? `from version ${p.published.version}` : "(first version)"}</h2>
              <ChangeList changes={changes} />
            </section>
          ) : (
            <section className="card ps-section" aria-labelledby="ps-sec-h">
              <h2 id="ps-sec-h">{current.title}</h2>
              <p className="small muted" style={{ marginTop: 0 }}>
                {current.intro}
              </p>
              <fieldset disabled={ro} className="ps-body">
                {body[section]}
              </fieldset>
              <div className="ps-pager">
                {SECTIONS.findIndex((s) => s.key === section) > 0 && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSection(SECTIONS[SECTIONS.findIndex((s) => s.key === section) - 1].key)}>
                    ← {SECTIONS[SECTIONS.findIndex((s) => s.key === section) - 1].title}
                  </button>
                )}
                <span />
                {SECTIONS.findIndex((s) => s.key === section) < SECTIONS.length - 1 && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSection(SECTIONS[SECTIONS.findIndex((s) => s.key === section) + 1].key)}>
                    {SECTIONS[SECTIONS.findIndex((s) => s.key === section) + 1].title} →
                  </button>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </Errs.Provider>
  );
}

export function ChangeList({ changes }: { changes: Change[] }) {
  if (!changes.length) return <p className="small muted">No changes.</p>;
  return (
    <div className="ps-changes">
      {SECTIONS.map((s) => {
        const list = changes.filter((c) => c.section === s.key);
        if (!list.length) return null;
        return (
          <div key={s.key}>
            <h4 className="ps-sub">{s.title}</h4>
            <ul>
              {list.map((c) => (
                <li key={c.path}>
                  <span>{c.label}</span>
                  <span className="ps-from">{c.from}</span>
                  <span aria-hidden="true">→</span>
                  <span className="sr-only">changed to</span>
                  <span className="ps-to">{c.to}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
