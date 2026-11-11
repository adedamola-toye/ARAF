"use client";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Circle, Plus, Trash2 } from "lucide-react";
import { FormMessages } from "@/components/forms";
import { AmountInput, DigitsInput, SearchSelect, amountToKobo, formatNaira, groupAmount } from "@/components/inputs";
import { saveRetailDraftAction } from "../../retail-actions";

export interface RetailFormProps {
  applicationId: string;
  taskId: string;
  ref_: string;
  productName: string;
  profile: "SALARY_EARNER" | "BUSINESS_OWNER";
  profileLabel: string;
  applicantType: "INDIVIDUAL" | "ENTERPRISE" | "LIMITED";
  initiatorRole: string;
  isCorrection: boolean;
  correction: { by: string; reason: string; at: string; stage: string } | null;
  lockVersion: number;
  savedAt: string;
  structure: string | null;
  structures: { code: string; label: string; rate: string; insurance: string; convention: string }[];
  limits: { maxAmountKobo: number | null; maxTenorMonths: number | null; dsrMax: string | null; denominator: string | null; statementMonths: number | null; payslipMonths: number | null; equityApplies: boolean | null; equityMin: string | null; assetCriteria: string | null };
  assetProduct: boolean;
  beneficiaryRequired: boolean;
  data: {
    text: Record<string, string>;
    money: Record<string, string>;
    tenor: string;
    yearsInOperation: string;
    obligations: { lender: string; facilityType: string; monthly: string; outstanding: string }[];
    salaryHistory: { month: string; amount: string }[];
    consents: { code: string; granted: boolean; recordedAt: string | null }[];
  };
  maskedBvn: string | null;
  maskedTin: string | null;
  directors: { id: string; fullName: string; masked: string }[];
  vendors: { vendorId: string; vendorName: string; vendorEmail: string | null; accounts: { id: string; label: string; status: string; bank: string; number: string }[] }[];
  locations: { id: string; state: string; city: string; outletType: string; name: string; oss: string | null }[];
  rms: { id: string; label: string }[];
  privacyConsents: { code: string; purpose: string }[];
  readiness: {
    ready: boolean;
    fieldErrors: Record<string, string>;
    blockers: string[];
    matrix: { code: string; label: string; requirement: string; status: string; detail: string; note: string | null; applies: boolean }[];
    photos: { distinctAngles: number; required: number; rmPhotoPresent: boolean; rmPhotoRequired: boolean } | null;
    proposal: { required: boolean; present: boolean; missing: string[]; versionNo: number | null };
    preliminary: { result: string; dsr: string | null; maxPercent: string | null; formula: string[]; checks: { rule: string; pass: boolean; detail: string }[]; source: string | null; monthly: string | null } | null;
    beneficiary: { bank: string; number: string; name: string; status: string; vendor: string; paymentSupported: boolean } | null;
  };
}

const SECTIONS = [
  { id: "customer", label: "Customer", keys: ["customerName", "businessName", "companyName", "registrationNumber", "phone", "email", "businessAddress", "bvn", "tin", "directors", "applicantType"] },
  { id: "work", label: "Employment or business", keys: ["employerName", "statedMonthlySalaryKobo", "salaryHistory", "businessSector", "statedMonthlyTurnoverKobo"] },
  { id: "facility", label: "Facility", keys: ["requestedAmountKobo", "tenorMonths", "structure", "purpose", "assetDescription", "assetCostKobo", "deliveryAddress", "equityContributionKobo"] },
  { id: "affordability", label: "Obligations and DSR", keys: ["incomeBasisKobo", "proposedMonthlyObligationKobo", "obligations"] },
  { id: "beneficiary", label: "Vendor and beneficiary", keys: ["vendorId", "vendorAccountId"] },
  { id: "origination", label: "Origination", keys: ["outletLocationId", "assignedRmId", "consent_"] },
  { id: "documents", label: "Documents", keys: ["doc_", "photos"] },
  { id: "proposal", label: "Credit proposal", keys: ["proposal"] },
  { id: "review", label: "Review and submit", keys: [] },
] as const;

function sectionErrors(errors: Record<string, string>, keys: readonly string[]) {
  return Object.keys(errors).filter((k) => keys.some((x) => k === x || k.startsWith(`${x}.`) || (x.endsWith("_") && k.startsWith(x)))).length;
}

function Field({ id, label, children, hint, error, required }: { id: string; label: string; children: React.ReactNode; hint?: string; error?: string; required?: boolean }) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required && <span className="req" aria-hidden="true"> *</span>}
      </label>
      {children}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && (
        <span className="err" id={`${id}-err`}>
          {error}
        </span>
      )}
    </div>
  );
}

function Buttons({ isCorrection, setIntent, dirty }: { isCorrection: boolean; setIntent: (s: string) => void; dirty: boolean }) {
  const { pending } = useFormStatus();
  return (
    <div className="row">
      <button type="submit" className="btn" disabled={pending} onClick={() => setIntent("save")}>
        {pending ? "Saving…" : dirty ? "Save draft" : "Save draft (no changes)"}
      </button>
      <button type="submit" className="btn btn-primary" disabled={pending} onClick={() => setIntent("submit")}>
        {pending ? "Submitting…" : isCorrection ? "Save and resubmit" : "Save and submit application"}
      </button>
    </div>
  );
}

const STATUS_BADGE: Record<string, string> = { RECEIVED: "badge-green", EXCEPTION_APPROVED: "badge-blue", MISSING: "badge-red", REJECTED: "badge-red", EXPIRED: "badge-warn", NOT_APPLICABLE: "" };

export function RetailDraftForm(props: RetailFormProps) {
  const [state, action] = useActionState(saveRetailDraftAction, {});
  const router = useRouter();
  const [t, setT] = useState<Record<string, string>>(props.data.text);
  const [money, setMoney] = useState<Record<string, string>>(props.data.money);
  const [tenor, setTenor] = useState(props.data.tenor);
  const [years, setYears] = useState(props.data.yearsInOperation);
  const [structure, setStructure] = useState(props.structure ?? "");
  const [obligations, setObligations] = useState(props.data.obligations);
  const [salary, setSalary] = useState(props.data.salaryHistory);
  const [consents, setConsents] = useState(props.data.consents);
  const [directors, setDirectors] = useState(props.directors.length ? props.directors.map((d) => ({ id: d.id as string | null, fullName: d.fullName, bvn: "", masked: d.masked })) : [{ id: null as string | null, fullName: "", bvn: "", masked: "" }]);
  const [bvn, setBvn] = useState("");
  const [tin, setTin] = useState("");
  const [intent, setIntentRaw] = useState("save");
  const [attempted, setAttempted] = useState(props.isCorrection);
  const setIntent = (v: string) => {
    if (v === "submit") setAttempted(true);
    setIntentRaw(v);
  };
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [savedAt, setSavedAt] = useState(props.savedAt);
  const formRef = useRef<HTMLFormElement>(null);
  const T = props.applicantType;
  const salaryProfile = props.profile === "SALARY_EARNER";
  const isDo = props.initiatorRole === "DELIGHT_OFFICER";

  const snapshot = JSON.stringify({ t, money, tenor, years, structure, obligations, salary, consents, directors: directors.map((d) => [d.fullName, d.bvn]), bvn, tin });
  const [baseline, setBaseline] = useState(snapshot);
  const dirty = snapshot !== baseline;
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);
  useEffect(() => {
    if (state.ok) {
      setKey(crypto.randomUUID());
      setBvn("");
      setTin("");
      const d = state.data as { savedAt?: string } | undefined;
      if (d?.savedAt) setSavedAt(d.savedAt);
      setBaseline(JSON.stringify({ t, money, tenor, years, structure, obligations, salary, consents, directors: directors.map((x) => [x.fullName, ""]), bvn: "", tin: "" }));
      router.refresh();
    }
    if (state.error) formRef.current?.querySelector<HTMLElement>(".alert-error")?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const errors = { ...props.readiness.fieldErrors, ...(state.fields ?? {}) };
  // Inline errors appear once the user has tried to submit (or is correcting); before that the
  // section badges and the review summary show what is outstanding without flooding a new draft with red.
  const fe = (k: string) => (state.fields ?? {})[k] ?? (attempted ? props.readiness.fieldErrors[k] : undefined);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setT({ ...t, [k]: e.target.value });
  const setM = (k: string) => (v: string) => setMoney({ ...money, [k]: v });

  // Dependent location dropdowns: State → Town/City → Outlet type → Outlet
  const selectedLoc = props.locations.find((l) => l.id === t.outletLocationId);
  const [locState, setLocState] = useState(selectedLoc?.state ?? "");
  const [locCity, setLocCity] = useState(selectedLoc?.city ?? "");
  const [locType, setLocType] = useState(selectedLoc?.outletType ?? "");
  const states = [...new Set(props.locations.map((l) => l.state))];
  const cities = [...new Set(props.locations.filter((l) => l.state === locState).map((l) => l.city))];
  const types = [...new Set(props.locations.filter((l) => l.state === locState && l.city === locCity).map((l) => l.outletType))];
  const outlets = props.locations.filter((l) => l.state === locState && l.city === locCity && l.outletType === locType);

  const vendor = props.vendors.find((v) => v.vendorId === t.vendorId);
  const account = vendor?.accounts.find((a) => a.id === t.vendorAccountId);
  const st = props.structures.find((s) => s.code === structure);
  const amountKobo = amountToKobo(money.requestedAmountKobo ?? "");
  const obligationsTotal = useMemo(() => obligations.reduce((s, o) => s + (amountToKobo(o.monthly) ?? 0), 0), [obligations]);

  const payload = JSON.stringify({
    data: {
      customerName: t.customerName,
      businessName: t.businessName,
      companyName: t.companyName,
      registrationNumber: t.registrationNumber,
      phone: t.phone,
      email: t.email,
      businessAddress: t.businessAddress,
      deliveryAddress: t.deliveryAddress,
      employerName: t.employerName,
      employmentConfirmationRef: t.employmentConfirmationRef,
      jobTitle: t.jobTitle,
      employmentStartDate: t.employmentStartDate,
      businessSector: t.businessSector,
      purpose: t.purpose,
      assetDescription: t.assetDescription,
      incomeBasisNote: t.incomeBasisNote,
      vendorId: t.vendorId || null,
      vendorAccountId: t.vendorAccountId || null,
      outletLocationId: t.outletLocationId || null,
      assignedRmId: t.assignedRmId || null,
      consents: consents.map((c) => ({ ...c, recordedAt: c.granted ? (c.recordedAt ?? new Date().toISOString()) : null })),
    },
    money,
    obligations,
    salaryHistory: salary,
    directors: directors.map((d) => ({ id: d.id, fullName: d.fullName, bvn: d.bvn })),
    bvn,
    tin,
    structure,
    tenor,
    yearsInOperation: years,
    expectedLockVersion: props.lockVersion,
  });

  const r = props.readiness;
  return (
    <div className="form-layout">
      <nav className="form-steps" aria-label="Application sections">
        <ol>
          {SECTIONS.filter((s) => s.id !== "origination" || isDo || props.privacyConsents.length > 0).map((s) => {
            const n = sectionErrors(errors, s.keys);
            const done = s.id === "review" ? r.ready : n === 0;
            return (
              <li key={s.id}>
                <a href={`#${s.id}`}>
                  <span className={`tick ${done ? "ok" : "no"}`} aria-hidden="true">{done ? <CheckCircle2 className="icon" /> : <Circle className="icon" />}</span>
                  {s.label}
                  {n > 0 && <span className="badge badge-red">{n}</span>}
                  <span className="sr-only">{done ? "(complete)" : `(${n} item${n === 1 ? "" : "s"} outstanding)`}</span>
                </a>
              </li>
            );
          })}
        </ol>
        <p className="save-state small" role="status" aria-live="polite">
          {dirty ? <span className="badge badge-warn">Unsaved changes</span> : <span className="badge badge-green">Saved</span>} <span className="muted">Last saved {savedAt}</span>
        </p>
      </nav>

      <form ref={formRef} action={action} className="stack form-main" noValidate>
        {props.correction && (
          <div className="alert alert-warn" role="alert" tabIndex={-1}>
            <AlertTriangle className="icon" aria-hidden="true" />
            <span>
              <strong>Correction requested</strong> at {props.correction.stage} by {props.correction.by} ({props.correction.at}): {props.correction.reason}
            </span>
          </div>
        )}
        <input type="hidden" name="applicationId" value={props.applicationId} />
        <input type="hidden" name="taskId" value={props.taskId} />
        <input type="hidden" name="idempotencyKey" value={key} />
        <input type="hidden" name="intent" value={intent} />
        <input type="hidden" name="payload" value={payload} />
        <FormMessages state={state.ok ? { ...state, message: intent === "save" ? "Draft saved." : state.message } : state} />

        {/* ------------------------------------------------ customer */}
        <section className="card" id="customer" aria-labelledby="h-customer">
          <h2 id="h-customer">Customer</h2>
          <p className="small muted">{props.productName} · {props.profileLabel} · {T === "LIMITED" ? "Limited company" : T === "ENTERPRISE" ? "Enterprise" : "Individual"}</p>
          {fe("applicantType") && <p className="err">{fe("applicantType")}</p>}
          <div className="grid-2">
            {T === "LIMITED" ? (
              <Field id="companyName" label="Company name" required error={fe("companyName")}>
                <input id="companyName" value={t.companyName} onChange={set("companyName")} aria-invalid={!!fe("companyName")} />
              </Field>
            ) : (
              <Field id="customerName" label={T === "ENTERPRISE" ? "Proprietor legal name" : "Customer full name"} required error={fe("customerName")}>
                <input id="customerName" value={t.customerName} onChange={set("customerName")} aria-invalid={!!fe("customerName")} autoComplete="off" />
              </Field>
            )}
            {T === "ENTERPRISE" && (
              <Field id="businessName" label="Registered business name" required error={fe("businessName")}>
                <input id="businessName" value={t.businessName} onChange={set("businessName")} aria-invalid={!!fe("businessName")} />
              </Field>
            )}
            {T !== "INDIVIDUAL" && (
              <Field id="registrationNumber" label="CAC registration number" hint="BN or RC number, e.g. RC1234567" required error={fe("registrationNumber")}>
                <input id="registrationNumber" value={t.registrationNumber} onChange={set("registrationNumber")} aria-invalid={!!fe("registrationNumber")} />
              </Field>
            )}
            <Field id="phone" label="Phone number" required>
              <DigitsInput id="phone" kind="tel" value={t.phone} onChange={(v) => setT({ ...t, phone: v })} serverError={fe("phone")} placeholder="08031234567" />
            </Field>
            <Field id="email" label="Email (optional)" error={fe("email")}>
              <input id="email" type="email" value={t.email} onChange={set("email")} aria-invalid={!!fe("email")} />
            </Field>
            <Field id="businessAddress" label={salaryProfile ? "Customer address" : "Business address"} hint="Where the customer lives or trades (not the outlet)." required error={fe("businessAddress")}>
              <input id="businessAddress" value={t.businessAddress} onChange={set("businessAddress")} aria-invalid={!!fe("businessAddress")} />
            </Field>
            {T !== "LIMITED" && (
              <Field id="bvn" label={T === "ENTERPRISE" ? "Proprietor BVN" : "BVN"} required>
                <DigitsInput id="bvn" kind="bvn" value={bvn} onChange={setBvn} serverError={fe("bvn")} placeholder={props.maskedBvn ? `Saved: ${props.maskedBvn} (leave blank to keep)` : "11 digits"} />
              </Field>
            )}
            {T !== "INDIVIDUAL" && (
              <Field id="tin" label="TIN (optional)" hint={props.maskedTin ? `Saved: ${props.maskedTin}` : "Tax identification number"} error={fe("tin")}>
                <input id="tin" value={tin} onChange={(e) => setTin(e.target.value)} autoComplete="off" />
              </Field>
            )}
          </div>
          {T === "LIMITED" && (
            <fieldset className="subfield">
              <legend>Directors ({directors.length})</legend>
              {fe("directors") && <p className="err">{fe("directors")}</p>}
              {directors.map((x, i) => (
                <div className="grid-2" key={i} style={{ alignItems: "start" }}>
                  <Field id={`directors.${i}.fullName`} label={`Director ${i + 1} full name`} error={fe(`directors.${i}.fullName`)}>
                    <input id={`directors.${i}.fullName`} value={x.fullName} onChange={(e) => setDirectors(directors.map((y, j) => (j === i ? { ...y, fullName: e.target.value } : y)))} />
                  </Field>
                  <Field id={`directors.${i}.bvn`} label="Director BVN">
                    <DigitsInput id={`directors.${i}.bvn`} kind="bvn" value={x.bvn} serverError={fe(`directors.${i}.bvn`)} placeholder={x.masked ? `Saved: ${x.masked}` : "11 digits"} onChange={(v) => setDirectors(directors.map((y, j) => (j === i ? { ...y, bvn: v } : y)))} />
                  </Field>
                </div>
              ))}
              <div className="row">
                <button type="button" className="btn btn-sm" onClick={() => setDirectors([...directors, { id: null, fullName: "", bvn: "", masked: "" }])}>
                  <Plus className="icon" aria-hidden="true" /> Add director
                </button>
                {directors.length > 1 && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDirectors(directors.slice(0, -1))}>
                    Remove last director
                  </button>
                )}
              </div>
            </fieldset>
          )}
        </section>

        {/* ------------------------------------------------ employment / business */}
        <section className="card" id="work" aria-labelledby="h-work">
          <h2 id="h-work">{salaryProfile ? "Employment and salary" : "Business profile"}</h2>
          {salaryProfile ? (
            <>
              <div className="grid-2">
                <Field id="employerName" label="Employer" required error={fe("employerName")}>
                  <input id="employerName" value={t.employerName} onChange={set("employerName")} aria-invalid={!!fe("employerName")} />
                </Field>
                <Field id="jobTitle" label="Job title">
                  <input id="jobTitle" value={t.jobTitle} onChange={set("jobTitle")} />
                </Field>
                <Field id="employmentStartDate" label="Employed since">
                  <input id="employmentStartDate" type="date" value={t.employmentStartDate} onChange={set("employmentStartDate")} />
                </Field>
                <Field id="employmentConfirmationRef" label="Employment confirmation reference" hint="Letter or HR reference; upload the confirmation under Documents.">
                  <input id="employmentConfirmationRef" value={t.employmentConfirmationRef} onChange={set("employmentConfirmationRef")} />
                </Field>
                <Field id="statedMonthlySalaryKobo" label="Monthly net salary" required error={fe("statedMonthlySalaryKobo")}>
                  <AmountInput id="statedMonthlySalaryKobo" value={money.statedMonthlySalaryKobo ?? ""} onChange={setM("statedMonthlySalaryKobo")} invalid={!!fe("statedMonthlySalaryKobo")} />
                </Field>
              </div>
              <fieldset className="subfield">
                <legend>Salary history{props.limits.payslipMonths ? ` (at least ${props.limits.payslipMonths} months)` : ""}</legend>
                {fe("salaryHistory") && <p className="err">{fe("salaryHistory")}</p>}
                {salary.map((s, i) => (
                  <div className="row" key={i} style={{ alignItems: "end" }}>
                    <Field id={`salaryHistory.${i}.month`} label={`Month ${i + 1}`} error={fe(`salaryHistory.${i}.month`)}>
                      <input id={`salaryHistory.${i}.month`} type="month" value={s.month} onChange={(e) => setSalary(salary.map((x, j) => (j === i ? { ...x, month: e.target.value } : x)))} />
                    </Field>
                    <Field id={`salaryHistory.${i}.amount`} label="Net salary" error={fe(`salaryHistory.${i}.amount`)}>
                      <AmountInput id={`salaryHistory.${i}.amount`} value={s.amount} onChange={(v) => setSalary(salary.map((x, j) => (j === i ? { ...x, amount: v } : x)))} />
                    </Field>
                    <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove month ${i + 1}`} onClick={() => setSalary(salary.filter((_, j) => j !== i))}>
                      <Trash2 className="icon" aria-hidden="true" />
                    </button>
                  </div>
                ))}
                <button type="button" className="btn btn-sm" onClick={() => setSalary([...salary, { month: "", amount: "" }])}>
                  <Plus className="icon" aria-hidden="true" /> Add month
                </button>
              </fieldset>
            </>
          ) : (
            <div className="grid-2">
              <Field id="businessSector" label="Business sector" required error={fe("businessSector")}>
                <input id="businessSector" value={t.businessSector} onChange={set("businessSector")} aria-invalid={!!fe("businessSector")} placeholder="e.g. Textiles retail" />
              </Field>
              <Field id="yearsInOperation" label="Years in operation">
                <input id="yearsInOperation" inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value.replace(/\D/g, "").slice(0, 3))} />
              </Field>
              <Field id="statedMonthlyTurnoverKobo" label="Average monthly turnover" hint="From the customer's statements." required error={fe("statedMonthlyTurnoverKobo")}>
                <AmountInput id="statedMonthlyTurnoverKobo" value={money.statedMonthlyTurnoverKobo ?? ""} onChange={setM("statedMonthlyTurnoverKobo")} invalid={!!fe("statedMonthlyTurnoverKobo")} />
              </Field>
            </div>
          )}
        </section>

        {/* ------------------------------------------------ facility */}
        <section className="card" id="facility" aria-labelledby="h-facility">
          <h2 id="h-facility">Facility</h2>
          <div className="grid-2">
            <Field id="requestedAmountKobo" label="Requested amount" required hint={props.limits.maxAmountKobo !== null ? `Maximum ${formatNaira(props.limits.maxAmountKobo)}` : "Maximum not configured yet"} error={fe("requestedAmountKobo") ?? (amountKobo !== null && props.limits.maxAmountKobo !== null && amountKobo > props.limits.maxAmountKobo ? `The maximum for this product is ${formatNaira(props.limits.maxAmountKobo)}.` : undefined)}>
              <AmountInput id="requestedAmountKobo" value={money.requestedAmountKobo ?? ""} onChange={setM("requestedAmountKobo")} invalid={!!fe("requestedAmountKobo")} max={props.limits.maxAmountKobo} />
            </Field>
            <Field id="tenorMonths" label="Tenor (months)" required hint={props.limits.maxTenorMonths !== null ? `1 to ${props.limits.maxTenorMonths} months` : "Maximum not configured yet"} error={fe("tenorMonths")}>
              <input id="tenorMonths" inputMode="numeric" value={tenor} onChange={(e) => setTenor(e.target.value.replace(/\D/g, "").slice(0, 3))} aria-invalid={!!fe("tenorMonths")} />
            </Field>
          </div>
          {props.structures.length > 0 && (
            <fieldset className="subfield">
              <legend>Financing structure</legend>
              {fe("structure") && <p className="err">{fe("structure")}</p>}
              <div className="choice-grid">
                {props.structures.map((s) => (
                  <label key={s.code} className="type-card">
                    <input type="radio" name="structure-choice" value={s.code} checked={structure === s.code} onChange={() => setStructure(s.code)} />
                    <span className="choice">
                      <strong>
                        {s.label} · {s.rate}
                      </strong>
                      <span>{s.insurance}</span>
                      <span className="small muted">{s.convention}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <Field id="purpose" label="Purpose of the financing" required error={fe("purpose")}>
            <textarea id="purpose" rows={2} value={t.purpose} onChange={set("purpose")} aria-invalid={!!fe("purpose")} />
          </Field>
          {props.assetProduct && (
            <div className="grid-2">
              <Field id="assetDescription" label="Asset or solution" hint={props.limits.assetCriteria ? `Eligibility: ${props.limits.assetCriteria}` : "e.g. make, model and year; or system capacity"} required error={fe("assetDescription")}>
                <input id="assetDescription" value={t.assetDescription} onChange={set("assetDescription")} aria-invalid={!!fe("assetDescription")} />
              </Field>
              <Field id="assetCostKobo" label="Asset cost (invoice or quotation)" required error={fe("assetCostKobo")}>
                <AmountInput id="assetCostKobo" value={money.assetCostKobo ?? ""} onChange={setM("assetCostKobo")} invalid={!!fe("assetCostKobo")} />
              </Field>
              <Field id="deliveryAddress" label="Delivery or installation address" hint="Separate from the outlet and the customer's address where different." required error={fe("deliveryAddress")}>
                <input id="deliveryAddress" value={t.deliveryAddress} onChange={set("deliveryAddress")} aria-invalid={!!fe("deliveryAddress")} />
              </Field>
              {props.limits.equityApplies && (
                <Field id="equityContributionKobo" label={`Customer equity contribution${props.limits.equityMin ? ` (minimum ${props.limits.equityMin}%)` : ""}`} required error={fe("equityContributionKobo")}>
                  <AmountInput id="equityContributionKobo" value={money.equityContributionKobo ?? ""} onChange={setM("equityContributionKobo")} />
                </Field>
              )}
            </div>
          )}
          {st && (
            <p className="summary-box small" style={{ margin: 0 }}>
              <strong>Insurance responsibility:</strong> {st.insurance}. This is shown on the assessment, the approval summary and the offer.
            </p>
          )}
        </section>

        {/* ------------------------------------------------ obligations + DSR */}
        <section className="card" id="affordability" aria-labelledby="h-aff">
          <h2 id="h-aff">Existing obligations and preliminary DSR</h2>
          <p className="small muted">
            DSR = (existing monthly obligations + proposed monthly repayment) ÷ {props.limits.denominator ?? "the configured income basis"} × 100. Threshold: {props.limits.dsrMax ? `${props.limits.dsrMax}%` : "not configured"}.
          </p>
          <fieldset className="subfield">
            <legend>Existing financial obligations (monthly)</legend>
            {obligations.length === 0 && <p className="small muted" style={{ margin: 0 }}>No existing obligations recorded. Add every loan or facility the customer is repaying.</p>}
            {obligations.map((o, i) => (
              <div className="obligation" key={i}>
                <Field id={`obligations.${i}.lender`} label="Lender" error={fe(`obligations.${i}.lender`)}>
                  <input id={`obligations.${i}.lender`} value={o.lender} onChange={(e) => setObligations(obligations.map((x, j) => (j === i ? { ...x, lender: e.target.value } : x)))} />
                </Field>
                <Field id={`obligations.${i}.facilityType`} label="Facility type">
                  <input id={`obligations.${i}.facilityType`} value={o.facilityType} onChange={(e) => setObligations(obligations.map((x, j) => (j === i ? { ...x, facilityType: e.target.value } : x)))} />
                </Field>
                <Field id={`obligations.${i}.monthly`} label="Monthly repayment" error={fe(`obligations.${i}.monthly`)}>
                  <AmountInput id={`obligations.${i}.monthly`} value={o.monthly} onChange={(v) => setObligations(obligations.map((x, j) => (j === i ? { ...x, monthly: v } : x)))} />
                </Field>
                <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove obligation ${i + 1}`} onClick={() => setObligations(obligations.filter((_, j) => j !== i))}>
                  <Trash2 className="icon" aria-hidden="true" />
                </button>
              </div>
            ))}
            <div className="row">
              <button type="button" className="btn btn-sm" onClick={() => setObligations([...obligations, { lender: "", facilityType: "", monthly: "", outstanding: "" }])}>
                <Plus className="icon" aria-hidden="true" /> Add obligation
              </button>
              <span className="spacer" />
              <strong className="tnum">Total existing: {formatNaira(obligationsTotal)} / month</strong>
            </div>
          </fieldset>
          <div className="grid-2">
            <Field id="incomeBasisKobo" label={`Income basis for DSR${props.limits.denominator ? ` (${props.limits.denominator})` : ""}`} required error={fe("incomeBasisKobo")}>
              <AmountInput id="incomeBasisKobo" value={money.incomeBasisKobo ?? ""} onChange={setM("incomeBasisKobo")} invalid={!!fe("incomeBasisKobo")} />
            </Field>
            <Field id="proposedMonthlyObligationKobo" label="Proposed monthly repayment (estimate)" hint="Used only until the rate convention is configured; afterwards it is calculated from the terms.">
              <AmountInput id="proposedMonthlyObligationKobo" value={money.proposedMonthlyObligationKobo ?? ""} onChange={setM("proposedMonthlyObligationKobo")} />
            </Field>
            <Field id="incomeBasisNote" label="How the income basis was derived">
              <input id="incomeBasisNote" value={t.incomeBasisNote} onChange={set("incomeBasisNote")} placeholder="e.g. average of last 6 months' salary credits" />
            </Field>
          </div>
          {r.preliminary && (
            <div className={`dsr-box ${r.preliminary.result === "PASS" ? "pass" : r.preliminary.result === "FAIL" ? "fail" : "blocked"}`} role="status">
              <div className="dsr-figure">
                <span className="small muted">Preliminary DSR (last saved)</span>
                <strong className="tnum">{r.preliminary.dsr ? `${r.preliminary.dsr}%` : "—"}</strong>
                <span className="small">threshold {r.preliminary.maxPercent ?? "not configured"}% · {r.preliminary.result}</span>
              </div>
              <ul className="small">
                {r.preliminary.formula.map((f) => (
                  <li key={f}>{f}</li>
                ))}
                {r.preliminary.checks.filter((c) => !c.pass).map((c) => (
                  <li key={c.rule} className="err">
                    {c.rule}: {c.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* ------------------------------------------------ beneficiary */}
        {props.beneficiaryRequired && (
          <section className="card" id="beneficiary" aria-labelledby="h-ben">
            <h2 id="h-ben">Vendor and beneficiary account</h2>
            <div className="grid-2">
              <Field id="vendorId" label="Vendor" required error={fe("vendorId")}>
                <SearchSelect
                  id="vendorId"
                  value={t.vendorId ?? ""}
                  onChange={(v) => setT({ ...t, vendorId: v, vendorAccountId: "" })}
                  options={props.vendors.map((v) => ({ value: v.vendorId, label: v.vendorName, hint: v.vendorEmail ?? undefined }))}
                  placeholder="Search vendors"
                  invalid={!!fe("vendorId")}
                />
              </Field>
              <Field id="vendorAccountId" label="Approved bank account" required error={fe("vendorAccountId")}>
                <select id="vendorAccountId" value={t.vendorAccountId ?? ""} onChange={set("vendorAccountId")} disabled={!vendor} aria-invalid={!!fe("vendorAccountId")}>
                  <option value="">{vendor ? "Select the account…" : "Select a vendor first"}</option>
                  {vendor?.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.bank} · {a.number} · {a.label}
                      {a.status !== "VERIFIED" ? ` (${a.status.toLowerCase().replace("_", " ")})` : ""}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {account && (
              <dl className="kv-inline">
                <div>
                  <dt>Bank</dt>
                  <dd>{account.bank}</dd>
                </div>
                <div>
                  <dt>Account number</dt>
                  <dd className="mono">{account.number}</dd>
                </div>
                <div>
                  <dt>Account name</dt>
                  <dd>{account.label}</dd>
                </div>
                <div>
                  <dt>Verification</dt>
                  <dd>
                    <span className={`badge ${account.status === "VERIFIED" ? "badge-green" : "badge-warn"}`}>{account.status === "UNAVAILABLE" ? "Pending manual verification (no name-enquiry integration)" : account.status}</span>
                  </dd>
                </div>
              </dl>
            )}
            {vendor?.vendorEmail && <p className="small muted" style={{ margin: 0 }}>Vendor email: {vendor.vendorEmail}. Upload the vendor&apos;s confirmation email under Documents.</p>}
          </section>
        )}

        {/* ------------------------------------------------ origination */}
        {(isDo || props.privacyConsents.length > 0) && (
          <section className="card" id="origination" aria-labelledby="h-orig">
            <h2 id="h-orig">Origination</h2>
            {isDo && (
              <>
                <p className="small muted">Originating outlet (routes the request to its Outlet Service Supervisor). Kept separate from the customer and delivery addresses.</p>
                <div className="grid-4">
                  <Field id="loc-state" label="State" required>
                    <select id="loc-state" value={locState} onChange={(e) => { setLocState(e.target.value); setLocCity(""); setLocType(""); setT({ ...t, outletLocationId: "" }); }}>
                      <option value="">Choose…</option>
                      {states.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </Field>
                  <Field id="loc-city" label="Town or city" required>
                    <select id="loc-city" value={locCity} disabled={!locState} onChange={(e) => { setLocCity(e.target.value); setLocType(""); setT({ ...t, outletLocationId: "" }); }}>
                      <option value="">{locState ? "Choose…" : "Choose a state first"}</option>
                      {cities.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </Field>
                  <Field id="loc-type" label="Outlet type" required>
                    <select id="loc-type" value={locType} disabled={!locCity} onChange={(e) => { setLocType(e.target.value); setT({ ...t, outletLocationId: "" }); }}>
                      <option value="">{locCity ? "Choose…" : "Choose a town first"}</option>
                      {types.map((s) => <option key={s} value={s}>{s === "ALTBOX" ? "Altbox" : s === "ALTSHOP" ? "Altshop" : "Branch"}</option>)}
                    </select>
                  </Field>
                  <Field id="outletLocationId" label="Outlet" required error={fe("outletLocationId")}>
                    <select id="outletLocationId" value={t.outletLocationId ?? ""} disabled={!locType} onChange={set("outletLocationId")} aria-invalid={!!fe("outletLocationId")}>
                      <option value="">{locType ? "Choose…" : "Choose an outlet type first"}</option>
                      {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}{o.oss ? "" : " (no supervisor mapped)"}</option>)}
                    </select>
                  </Field>
                </div>
                <Field id="assignedRmId" label="Assigned Relationship Manager" hint="Supplies the RM credit proposal, the business-visit evidence and the photograph with the business." required error={fe("assignedRmId")}>
                  <SearchSelect id="assignedRmId" value={t.assignedRmId ?? ""} onChange={(v) => setT({ ...t, assignedRmId: v })} options={props.rms.map((x) => ({ value: x.id, label: x.label }))} placeholder="Search Relationship Managers" invalid={!!fe("assignedRmId")} />
                </Field>
              </>
            )}
            {props.privacyConsents.map((c) => (
              <label key={c.code} className="check">
                <input type="checkbox" checked={!!consents.find((x) => x.code === c.code)?.granted} onChange={(e) => setConsents([...consents.filter((x) => x.code !== c.code), { code: c.code, granted: e.target.checked, recordedAt: null }])} />
                <span>
                  Customer permission recorded: {c.purpose}
                  {fe(`consent_${c.code}`) && <span className="err"> {fe(`consent_${c.code}`)}</span>}
                </span>
              </label>
            ))}
          </section>
        )}

        {/* ------------------------------------------------ documents (status; uploads are below the form) */}
        <section className="card" id="documents" aria-labelledby="h-docs">
          <h2 id="h-docs">Required documents</h2>
          <div className="table-wrap">
          <table className="data responsive matrix">
            <caption className="sr-only">Document requirements for this product and profile</caption>
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Requirement</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {r.matrix.map((m) => (
                <tr key={m.code}>
                  <td data-label="Document">
                    {m.label}
                    {m.note && <div className="small muted">{m.note}</div>}
                  </td>
                  <td className="small" data-label="Requirement">{m.applies ? m.requirement.toLowerCase() : "not required at this amount"}</td>
                  <td data-label="Status">
                    <span className={`badge ${STATUS_BADGE[m.status] ?? ""}`}>{m.status.replace("_", " ").toLowerCase()}</span>
                    <div className="small muted">{m.detail}</div>
                  </td>
                </tr>
              ))}
              {r.photos && (
                <tr>
                  <td data-label="Document">Business photographs</td>
                  <td className="small" data-label="Requirement">At least {r.photos.required} distinct angles{r.photos.rmPhotoRequired ? " + RM with the business" : ""}</td>
                  <td data-label="Status">
                    <span className={`badge ${r.photos.distinctAngles >= r.photos.required && (!r.photos.rmPhotoRequired || r.photos.rmPhotoPresent) ? "badge-green" : "badge-red"}`}>
                      {r.photos.distinctAngles} angle{r.photos.distinctAngles === 1 ? "" : "s"}
                      {r.photos.rmPhotoRequired ? (r.photos.rmPhotoPresent ? " · RM photo present" : " · RM photo missing") : ""}
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>Upload documents in the panel below this form. Statements and payslips need their coverage dates; photographs need their angle.</p>
        </section>

        {/* ------------------------------------------------ review */}
        <section className="card" id="review" aria-labelledby="h-review">
          <h2 id="h-review">Review and submit</h2>
          <dl className="review-list">
            <div><dt>Customer</dt><dd>{T === "LIMITED" ? t.companyName : t.customerName}{t.businessName ? ` trading as ${t.businessName}` : ""} · {t.phone || "no phone"} <a href="#customer">Edit</a></dd></div>
            <div><dt>Facility</dt><dd>{money.requestedAmountKobo ? `₦${groupAmount(money.requestedAmountKobo)}` : "amount missing"} over {tenor || "?"} months{st ? ` · ${st.label} ${st.rate}` : ""} <a href="#facility">Edit</a></dd></div>
            <div><dt>DSR</dt><dd>{r.preliminary?.dsr ? `${r.preliminary.dsr}% (threshold ${r.preliminary.maxPercent ?? "?"}%)` : "not calculated yet"} <a href="#affordability">Edit</a></dd></div>
            {props.beneficiaryRequired && <div><dt>Beneficiary</dt><dd>{account ? `${vendor?.vendorName} · ${account.bank} · ${account.number}` : "not selected"} <a href="#beneficiary">Edit</a></dd></div>}
            {isDo && <div><dt>Outlet / RM</dt><dd>{props.locations.find((l) => l.id === t.outletLocationId)?.name ?? "outlet not selected"} · {props.rms.find((x) => x.id === t.assignedRmId)?.label ?? "RM not assigned"} <a href="#origination">Edit</a></dd></div>}
            <div><dt>Credit proposal</dt><dd>{r.proposal.required ? (r.proposal.present ? `version ${r.proposal.versionNo}${r.proposal.missing.length ? ` (incomplete: ${r.proposal.missing.join(", ")})` : ""}` : "not written yet") : "not required"} <a href="#proposal">Edit</a></dd></div>
          </dl>
          {(Object.keys(r.fieldErrors).length > 0 || r.blockers.length > 0) && (
            <div className="alert alert-error" role="status">
              <AlertTriangle className="icon" aria-hidden="true" />
              <div>
                <strong>Before you can submit ({Object.keys(r.fieldErrors).length + r.blockers.length} item{Object.keys(r.fieldErrors).length + r.blockers.length === 1 ? "" : "s"}, as last saved):</strong>
                <ul>
                  {r.blockers.map((b) => <li key={b}>{b}</li>)}
                  {Object.entries(r.fieldErrors).map(([k, v]) => <li key={k}>{v}</li>)}
                </ul>
              </div>
            </div>
          )}
          {r.ready && !dirty && (
            <div className="alert alert-success" role="status">
              <CheckCircle2 className="icon" aria-hidden="true" />
              <span>All requirements are met. Submitting sends the request to {isDo ? "the Outlet Service Supervisor" : "your Team Lead"}.</span>
            </div>
          )}
          {dirty && <p className="small muted">You have unsaved changes; saving refreshes the checklist.</p>}
          <Buttons isCorrection={props.isCorrection} setIntent={setIntent} dirty={dirty} />
        </section>
      </form>
    </div>
  );
}
