"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Clock, RotateCcw, Upload } from "lucide-react";
import { ActionForm, FormMessages, SubmitButton, useActionPending, type FormState } from "@/components/forms";
import { AmountInput, amountToKobo } from "@/components/inputs";
import { bpsLabel, computeStaffFinancing, formatNairaKobo } from "@/lib/staff-financing";
import {
  saveStaffDraftAction,
  pmDecisionAction,
  headDecisionAction,
  submitSignedOfferAction,
  completeDisbursementAction,
  removeStaffDocumentAction,
  reassignAction,
} from "./actions";

type Action = (prev: FormState, fd: FormData) => Promise<FormState>;

// ------------------------------------------------------------------ calculator

export function CalculatorCard({ grossKobo, rateBps, live = false, audience = "applicant" }: { grossKobo: number | null; rateBps: number; live?: boolean; audience?: "applicant" | "reviewer" }) {
  const f = grossKobo && grossKobo > 0 ? computeStaffFinancing(grossKobo, rateBps) : null;
  return (
    <section className="calc" aria-labelledby="calc-title" aria-live={live ? "polite" : undefined}>
      <div className="calc-head">
        <p className="eyebrow" id="calc-title">
          Financing calculator
        </p>
        <span className="badge">{bpsLabel(rateBps)} deduction</span>
      </div>
      <dl className="calc-rows">
        <div>
          <dt>Gross financing amount</dt>
          <dd>{f ? formatNairaKobo(f.grossKobo) : "₦0.00"}</dd>
        </div>
        <div className="calc-minus">
          <dt>Deduction ({bpsLabel(rateBps)} of gross)</dt>
          <dd>− {f ? formatNairaKobo(f.deductionKobo) : "₦0.00"}</dd>
        </div>
      </dl>
      <div className="calc-net">
        <span>{audience === "applicant" ? "Net amount you will receive" : "Net disbursement amount"}</span>
        <strong>{f ? formatNairaKobo(f.netKobo) : "₦0.00"}</strong>
      </div>
      <p className="small muted calc-note">
        The {bpsLabel(rateBps)} deduction is taken from the gross amount at disbursement. Figures are recalculated by the bank&apos;s system when you submit; the
        submitted figures are the ones reviewed and approved.
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ origination

export interface OriginationValues {
  id: string;
  lockVersion: number;
  fullName: string;
  email: string;
  staffNumber: string;
  department: string;
  unit: string;
  phone: string;
  salaryAccountNumber: string;
  salaryAccountName: string;
  purpose: string;
  amount: string;
  tenorMonths: string;
  acknowledged: boolean;
  acknowledgedNetKobo: number | null;
  declaration: boolean;
}

export function OriginationForm({ v, rateBps, tenorOptions, minKobo, maxKobo, returned }: { v: OriginationValues; rateBps: number; tenorOptions: number[]; minKobo: number | null; maxKobo: number | null; returned: boolean }) {
  const [amount, setAmount] = useState(v.amount);
  const gross = amountToKobo(amount);
  const net = gross && gross > 0 ? computeStaffFinancing(gross, rateBps).netKobo : null;
  // An acknowledgement only counts for the figures it was given for.
  const [ackFor, setAckFor] = useState<number | null>(v.acknowledged ? v.acknowledgedNetKobo : null);
  const acknowledged = net !== null && ackFor === net;
  const [declaration, setDeclaration] = useState(v.declaration);
  const [lockVersion, setLockVersion] = useState(v.lockVersion);
  const over = maxKobo !== null && gross !== null && gross > maxKobo;
  const under = minKobo !== null && gross !== null && gross > 0 && gross < minKobo;
  return (
    <ActionForm action={saveStaffDraftAction} refreshOnSuccess showMessages={false}>
      {(state) => {
        const data = state.data as { lockVersion?: number } | undefined;
        if (data?.lockVersion && data.lockVersion !== lockVersion) queueMicrotask(() => setLockVersion(data.lockVersion!));
        const err = (k: string) => state.fields?.[k];
        return (
          <div className="origination">
            <input type="hidden" name="id" value={v.id} />
            <input type="hidden" name="lockVersion" value={lockVersion} />
            <input type="hidden" name="displayedNetKobo" value={net ?? ""} />
            <div className="origination-main stack">
              <section className="card" aria-labelledby="sec-profile">
                <div className="card-head">
                  <h2 id="sec-profile">Your details</h2>
                  <span className="small muted">Name and email come from your staff record</span>
                </div>
                <div className="grid-2">
                  <ReadOnly label="Staff name" value={v.fullName} />
                  <ReadOnly label="Staff email" value={v.email} />
                  <Field id="staffNumber" label="Staff ID" required defaultValue={v.staffNumber} error={err("staffNumber")} hint="As on your staff ID card" autoComplete="off" />
                  <Field id="phone" label="Phone number" required defaultValue={v.phone} error={err("phone")} inputMode="numeric" hint="11 digits, for example 08031234567" autoComplete="tel" />
                  <Field id="department" label="Department" required defaultValue={v.department} error={err("department")} />
                  <Field id="unit" label="Unit" required defaultValue={v.unit} error={err("unit")} />
                </div>
              </section>
              <section className="card" aria-labelledby="sec-account">
                <div className="card-head">
                  <h2 id="sec-account">Salary account</h2>
                  <span className="small muted">The net amount is paid into this account</span>
                </div>
                <div className="grid-2">
                  <Field id="salaryAccountNumber" label="Account number" required defaultValue={v.salaryAccountNumber} error={err("salaryAccountNumber")} inputMode="numeric" hint="10 digits" autoComplete="off" />
                  <Field id="salaryAccountName" label="Account name" required defaultValue={v.salaryAccountName} error={err("salaryAccountName")} autoComplete="off" />
                </div>
                <p className="small muted" style={{ margin: "10px 0 0" }}>
                  The Product Manager verifies this account manually against your salary records. The format check here is not a verification.
                </p>
              </section>
              <section className="card" aria-labelledby="sec-financing">
                <h2 id="sec-financing">Financing request</h2>
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="amount">
                      Amount requested <span className="req">*</span>
                    </label>
                    <AmountInput id="amount" value={amount} onChange={setAmount} invalid={!!err("amount") || over || under} describedBy="amount-help" max={maxKobo} />
                    <input type="hidden" name="amount" value={amount} />
                    <span id="amount-help" className={over || under || err("amount") ? "err" : "hint"}>
                      {err("amount") ?? (over ? `The maximum is ${formatNairaKobo(maxKobo)}.` : under ? `The minimum is ${formatNairaKobo(minKobo)}.` : "Gross amount, before the deduction.")}
                    </span>
                  </div>
                  {tenorOptions.length > 0 && (
                    <div className="field">
                      <label htmlFor="tenorMonths">
                        Repayment tenor <span className="req">*</span>
                      </label>
                      <select id="tenorMonths" name="tenorMonths" defaultValue={v.tenorMonths} aria-invalid={!!err("tenorMonths")}>
                        <option value="">Choose…</option>
                        {tenorOptions.map((t) => (
                          <option key={t} value={t}>
                            {t} months
                          </option>
                        ))}
                      </select>
                      {err("tenorMonths") && <span className="err">{err("tenorMonths")}</span>}
                    </div>
                  )}
                  <div className="field" style={{ gridColumn: "1 / -1" }}>
                    <label htmlFor="purpose">Purpose (optional)</label>
                    <textarea id="purpose" name="purpose" defaultValue={v.purpose} maxLength={500} rows={2} />
                  </div>
                </div>
              </section>
            </div>
            <aside className="origination-side stack" aria-label="Calculation and submission">
              <CalculatorCard grossKobo={gross} rateBps={rateBps} live />
              <section className="card stack" aria-labelledby="sec-confirm">
                <h2 id="sec-confirm" style={{ margin: 0 }}>
                  Confirm and submit
                </h2>
                <label className={`check ${err("acknowledgement") && !acknowledged ? "check-error" : ""}`}>
                  <input type="checkbox" name="acknowledge" checked={acknowledged} disabled={net === null} onChange={(e) => setAckFor(e.target.checked ? net : null)} />
                  <span>
                    I understand that {bpsLabel(rateBps)} ({net !== null && gross ? formatNairaKobo(gross - net) : "₦0.00"}) will be deducted and I will receive{" "}
                    <strong>{net !== null ? formatNairaKobo(net) : "₦0.00"}</strong>.
                  </span>
                </label>
                <label className={`check ${err("declaration") && !declaration ? "check-error" : ""}`}>
                  <input type="checkbox" name="declaration" checked={declaration} onChange={(e) => setDeclaration(e.target.checked)} />
                  <span>
                    I declare that the information I have given is true and complete, and I consent to the bank verifying my account, salary history and existing
                    repayment obligations to assess this request.
                  </span>
                </label>
                {err("documents") && <p className="err">{err("documents")}</p>}
                <FormMessages state={state} />
                <IntentButtons canSubmit={acknowledged && declaration} submitLabel={returned ? "Resubmit Financing Request" : "Submit Financing Request"} />
                {(!acknowledged || !declaration) && <p className="small muted" style={{ margin: 0 }}>Tick both confirmations to enable submission.</p>}
              </section>
            </aside>
          </div>
        );
      }}
    </ActionForm>
  );
}

/** Return / Decline buttons: the decision travels in the form's hidden "decision" field. */
function DecisionButton({ value, label, danger }: { value: string; label: string; danger?: boolean }) {
  const pending = useActionPending();
  return (
    <button
      type="submit"
      className={`btn ${danger ? "btn-danger" : ""}`}
      disabled={pending}
      onClick={(e) => {
        const f = e.currentTarget.form?.elements.namedItem("decision");
        if (f instanceof HTMLInputElement) f.value = value;
      }}
    >
      {label}
    </button>
  );
}

/** Save / Submit: the chosen intent travels in a hidden field set by the clicked button. */
function IntentButtons({ canSubmit, submitLabel }: { canSubmit: boolean; submitLabel: string }) {
  const pending = useActionPending();
  const intent = useRef<HTMLInputElement>(null);
  // No state change on click: a re-render before submission would reset the hidden field.
  const which = pending ? intent.current?.value : null;
  return (
    <div className="action-bar">
      <input ref={intent} type="hidden" name="intent" defaultValue="save" />
      <button type="submit" className="btn" disabled={pending} onClick={() => (intent.current!.value = "save")}>
        {pending && which === "save" ? "Saving…" : "Save draft"}
      </button>
      <button type="submit" className="btn btn-primary" disabled={pending || !canSubmit} aria-disabled={pending || !canSubmit} onClick={() => (intent.current!.value = "submit")}>
        {pending && which === "submit" ? "Submitting…" : submitLabel}
      </button>
    </div>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="readonly-value">{value || "—"}</span>
    </div>
  );
}

function Field({ id, label, required, defaultValue, error, hint, inputMode, autoComplete }: { id: string; label: string; required?: boolean; defaultValue: string; error?: string; hint?: string; inputMode?: "numeric" | "text"; autoComplete?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} {required && <span className="req">*</span>}
      </label>
      <input id={id} name={id} type="text" defaultValue={defaultValue} inputMode={inputMode} autoComplete={autoComplete} aria-invalid={!!error} aria-describedby={`${id}-help`} />
      {error ? (
        <span id={`${id}-help`} className="err">
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-help`} className="hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ uploads

type Phase = { kind: "idle" } | { kind: "uploading"; pct: number } | { kind: "done"; msg: string } | { kind: "error"; msg: string };

export function StaffUpload({ requestId, categories, title = "Upload a document" }: { requestId: string; categories: { code: string; label: string }[]; title?: string }) {
  const id = useId();
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState(categories[0]?.code ?? "");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [name, setName] = useState("");
  const send = () => {
    const f = file.current?.files?.[0];
    if (!f) return setPhase({ kind: "error", msg: "Choose a file first." });
    const fd = new FormData();
    fd.set("requestId", requestId);
    fd.set("category", category);
    fd.set("file", f);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/staff-requests/upload");
    xhr.upload.onprogress = (e) => e.lengthComputable && setPhase({ kind: "uploading", pct: Math.round((e.loaded / e.total) * 100) });
    xhr.onload = () => {
      let body: { ok?: boolean; error?: string; scanStatus?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status === 401) return (window.location.href = "/session-expired?reason=IDLE_TIMEOUT");
      if (body.ok) {
        setPhase({ kind: "done", msg: body.scanStatus === "QUARANTINED" ? `${f.name} uploaded; the malware scan will finish shortly.` : `${f.name} uploaded.` });
        if (file.current) file.current.value = "";
        setName("");
        router.refresh();
      } else setPhase({ kind: "error", msg: body.error ?? "The upload failed. Try again." });
    };
    xhr.onerror = () => setPhase({ kind: "error", msg: "Network error. Check your connection and retry." });
    setPhase({ kind: "uploading", pct: 0 });
    xhr.send(fd);
  };
  return (
    <div className="upload" role="group" aria-labelledby={`${id}-t`}>
      <strong id={`${id}-t`} className="small">
        {title}
      </strong>
      <div className="upload-row">
        {categories.length > 1 && (
          <div className="field">
            <label htmlFor={`${id}-c`}>Document type</label>
            <select id={`${id}-c`} value={category} onChange={(e) => setCategory(e.target.value)}>
              {categories.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field" style={{ flex: 2 }}>
          <label htmlFor={`${id}-f`}>File (PDF, JPG, PNG, DOCX or XLSX)</label>
          <input id={`${id}-f`} ref={file} type="file" accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx" onChange={(e) => setName(e.target.files?.[0]?.name ?? "")} />
        </div>
        <button type="button" className="btn" onClick={send} disabled={phase.kind === "uploading" || !name}>
          <Upload className="icon" aria-hidden="true" /> {phase.kind === "uploading" ? `Uploading ${phase.pct}%` : "Upload"}
        </button>
      </div>
      {phase.kind === "uploading" && (
        <div className="progress-bar" role="progressbar" aria-valuenow={phase.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
          <span style={{ width: `${phase.pct}%` }} />
        </div>
      )}
      {phase.kind === "done" && (
        <p className="small" role="status" style={{ margin: 0, color: "var(--success)" }}>
          <CheckCircle2 className="icon" aria-hidden="true" /> {phase.msg}
        </p>
      )}
      {phase.kind === "error" && (
        <p className="err" role="alert" style={{ margin: 0 }}>
          <AlertTriangle className="icon" aria-hidden="true" /> {phase.msg}{" "}
          <button type="button" className="btn btn-sm btn-ghost" onClick={send}>
            <RotateCcw className="icon" aria-hidden="true" /> Retry
          </button>
        </p>
      )}
    </div>
  );
}

export function RemoveDocButton({ documentId }: { documentId: string }) {
  return (
    <ActionForm action={removeStaffDocumentAction} className="inline-form" showMessages={false}>
      <input type="hidden" name="documentId" value={documentId} />
      <SubmitButton className="btn btn-sm btn-ghost">Remove</SubmitButton>
    </ActionForm>
  );
}

// ------------------------------------------------------------------ confirmation dialog

/** A button that opens a confirmation dialog; the form is submitted only from the dialog. */
export function ConfirmButton({ label, title, body, className = "btn btn-primary", confirmLabel, formId, disabled }: { label: string; title: string; body: React.ReactNode; className?: string; confirmLabel: string; formId: string; disabled?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className={className} onClick={() => ref.current?.showModal()} disabled={disabled} aria-disabled={disabled}>
        {label}
      </button>
      <dialog ref={ref} className="modal" aria-labelledby={`${formId}-dt`}>
        <div className="modal-body">
          <h2 id={`${formId}-dt`}>{title}</h2>
          <div className="small">{body}</div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" form={formId} className="btn btn-primary" name="confirmed" value="on" onClick={() => ref.current?.close()}>
            {confirmLabel}
          </button>
        </div>
      </dialog>
    </>
  );
}

// ------------------------------------------------------------------ Product Manager

export function PmReviewForm({ id, lockVersion, unitHeads, netLabel }: { id: string; lockVersion: number; unitHeads: { id: string; label: string; suggested: boolean }[]; netLabel: string }) {
  const [checks, setChecks] = useState({ accountVerified: false, salaryHistoryReviewed: false, repaymentWithinLimit: false });
  const all = checks.accountVerified && checks.salaryHistoryReviewed && checks.repaymentWithinLimit;
  const [uh, setUh] = useState(unitHeads.find((u) => u.suggested)?.id ?? (unitHeads.length === 1 ? unitHeads[0].id : ""));
  const [rec, setRec] = useState("");
  const formId = `pm-${id}`;
  const box = (k: keyof typeof checks, label: string, hint: string) => (
    <label className="check">
      <input type="checkbox" name={k} checked={checks[k]} onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })} />
      <span>
        <strong>{label}</strong>
        <span className="block small muted">{hint}</span>
      </span>
    </label>
  );
  return (
    <ActionForm action={pmDecisionAction} showMessages={false}>
      {(state) => (
        <div className="stack" id={formId + "-wrap"}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="lockVersion" value={lockVersion} />
          <input type="hidden" name="decision" defaultValue="FORWARD" />
          <fieldset className="checklist-gate">
            <legend>Mandatory eligibility checklist</legend>
            <p className="small muted" style={{ margin: "0 0 8px" }}>
              No payroll or core-banking system is connected, so you confirm each check yourself from the documents and bank records.
            </p>
            {box("accountVerified", "Staff account has been verified", "The salary account exists, is active and belongs to the applicant.")}
            {box("salaryHistoryReviewed", "Three months of salary history have been reviewed", "Payslips or account statement covering the last three months.")}
            {box("repaymentWithinLimit", "Repayment obligation is within 50% of take-home pay", "Including existing obligations.")}
            <p className={`small gate-state ${all ? "ok" : ""}`} role="status">
              {all ? <CheckCircle2 className="icon" aria-hidden="true" /> : <Clock className="icon" aria-hidden="true" />} {Object.values(checks).filter(Boolean).length} of 3 checks confirmed
            </p>
          </fieldset>
          <div className="grid-2">
            <div className="field">
              <label htmlFor={`${formId}-th`}>Verified take-home pay (optional)</label>
              <input id={`${formId}-th`} name="verifiedTakeHome" inputMode="decimal" placeholder="₦ monthly" />
            </div>
            <div className="field">
              <label htmlFor={`${formId}-mr`}>Monthly repayment obligation (optional)</label>
              <input id={`${formId}-mr`} name="monthlyRepayment" inputMode="decimal" placeholder="₦ monthly" />
            </div>
          </div>
          <div className="field">
            <label htmlFor={`${formId}-rec`}>Recommendation to the Unit Head</label>
            <textarea id={`${formId}-rec`} name="recommendation" rows={2} value={rec} onChange={(e) => setRec(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${formId}-uh`}>Designated Unit Head</label>
            <select id={`${formId}-uh`} name="unitHeadId" value={uh} onChange={(e) => setUh(e.target.value)}>
              <option value="">Choose…</option>
              {unitHeads.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                  {u.suggested ? " (matches applicant's unit)" : ""}
                </option>
              ))}
            </select>
            {!unitHeads.length && <span className="err">No eligible Unit Head is configured. Ask a Super Admin to assign the role.</span>}
          </div>
          <div className="field">
            <label htmlFor={`${formId}-c`}>Comments to the applicant (required to return or decline)</label>
            <textarea id={`${formId}-c`} name="comments" rows={2} />
          </div>
          <FormMessages state={state} />
          <div className="action-bar">
            <ConfirmButtonInline
              disabled={!all || !uh || !rec.trim()}
              fields={{ decision: "FORWARD" }}
              label="Forward to Unit Head"
              title="Forward to the Unit Head?"
              confirmLabel="Confirm and forward"
              body={<p>You confirm all three checks were completed manually. The request ({netLabel} net) goes to {unitHeads.find((u) => u.id === uh)?.label ?? "the Unit Head"}.</p>}
            />
            <DecisionButton value="RETURN" label="Return for correction" />
            <DecisionButton value="DECLINE" label="Decline request" danger />
          </div>
          {!all && <p className="small muted" style={{ margin: 0 }}>Forwarding is disabled until all three checks are confirmed, a recommendation is written and a Unit Head is chosen.</p>}
        </div>
      )}
    </ActionForm>
  );
}

/** Confirmation dialog that submits its enclosing form with confirmed=on. */
function ConfirmButtonInline({ label, title, body, confirmLabel, disabled, fields = {}, danger }: { label: string; title: string; body: React.ReactNode; confirmLabel: string; disabled?: boolean; fields?: Record<string, string>; danger?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={() => ref.current?.showModal()} disabled={disabled} aria-disabled={disabled}>
        {label}
      </button>
      <dialog ref={ref} className="modal" aria-label={title}>
        <div className="modal-body">
          <h2>{title}</h2>
          <div className="small">{body}</div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button
            ref={btn}
            type="button"
            className="btn btn-primary"
            onClick={() => {
              ref.current?.close();
              const form = btn.current?.closest("form") ?? ref.current?.closest("form");
              if (!form) return;
              // Attach the confirmation and the decision for this one submission only.
              const added = Object.entries({ ...fields, confirmed: "on" }).flatMap(([k, v]) => {
                const existing = form.elements.namedItem(k);
                if (existing instanceof HTMLInputElement && existing.type === "hidden") {
                  existing.value = v;
                  return [];
                }
                const c = document.createElement("input");
                c.type = "hidden";
                c.name = k;
                c.value = v;
                form.appendChild(c);
                return c;
              });
              form.requestSubmit();
              setTimeout(() => added.forEach((c) => c.remove()), 0);
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </dialog>
    </>
  );
}

// ------------------------------------------------------------------ Unit Head / Divisional Head

export function HeadDecisionForm({ id, lockVersion, level, netLabel }: { id: string; lockVersion: number; level: "UH" | "DH"; netLabel: string }) {
  return (
    <ActionForm action={headDecisionAction} showMessages={false}>
      {(state) => (
        <div className="stack">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="lockVersion" value={lockVersion} />
          <input type="hidden" name="level" value={level} />
          <input type="hidden" name="decision" defaultValue="APPROVE" />
          <div className="field">
            <label htmlFor={`hd-${id}`}>Comments (required to return or decline; shown to the applicant)</label>
            <textarea id={`hd-${id}`} name="comments" rows={3} />
          </div>
          <FormMessages state={state} />
          <div className="action-bar">
            <ConfirmButtonInline
              fields={{ decision: "APPROVE" }}
              label={level === "DH" ? "Approve" : "Approve and forward to Divisional Head"}
              title={level === "DH" ? "Give final approval?" : "Approve and forward?"}
              confirmLabel={level === "DH" ? "Confirm final approval" : "Confirm and forward"}
              body={
                level === "DH" ? (
                  <p>The financing terms ({netLabel} net) will be locked and the offer letter process starts. Changes after this need a controlled amendment and reapproval.</p>
                ) : (
                  <p>The request goes to the Divisional Head for final approval.</p>
                )
              }
            />
            <DecisionButton value="RETURN" label="Return for clarification" />
            <DecisionButton value="DECLINE" label="Decline request" danger />
          </div>
        </div>
      )}
    </ActionForm>
  );
}

// ------------------------------------------------------------------ offer acceptance

export function Countdown({ deadline }: { deadline: string }) {
  const end = useMemo(() => new Date(deadline).getTime(), [deadline]);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (now === null) return <span className="countdown">…</span>;
  const ms = end - now;
  if (ms <= 0) return <span className="countdown expired">Deadline passed</span>;
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return (
    <span className={`countdown ${ms < 4 * 3600_000 ? "soon" : ""}`}>
      {h}h {String(m).padStart(2, "0")}m left
    </span>
  );
}

export function SignedOfferForm({ id, lockVersion, uploads }: { id: string; lockVersion: number; uploads: { id: string; label: string; clean: boolean }[] }) {
  const latest = uploads.at(-1);
  return (
    <ActionForm action={submitSignedOfferAction} showMessages={false}>
      {(state) => (
        <div className="stack">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="lockVersion" value={lockVersion} />
          {uploads.length > 0 ? (
            <div className="field">
              <label htmlFor={`so-${id}`}>Signed offer to submit</label>
              <select id={`so-${id}`} name="documentId" defaultValue={latest?.id}>
                {uploads.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                    {u.clean ? "" : " (scanning…)"}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>Upload the signed offer above, then submit it here.</p>
          )}
          <label className="check">
            <input type="checkbox" name="confirmed" />
            <span>This is the offer letter, signed by me, and I accept the offer on the stated terms.</span>
          </label>
          <FormMessages state={state} />
          <div className="action-bar">
            <SubmitButton className="btn btn-primary" disabled={!uploads.length}>
              Submit signed offer
            </SubmitButton>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

// ------------------------------------------------------------------ disbursement

export function CompleteDisbursementForm({ id, lockVersion, netKobo, evidence, today }: { id: string; lockVersion: number; netKobo: number; evidence: { id: string; label: string }[]; today: string }) {
  return (
    <ActionForm action={completeDisbursementAction} showMessages={false}>
      {(state) => {
        const err = (k: string) => state.fields?.[k];
        return (
          <div className="stack">
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="lockVersion" value={lockVersion} />
            <div className="grid-2">
              <div className="field">
                <label htmlFor={`tx-${id}`}>Core banking transaction reference</label>
                <input id={`tx-${id}`} name="transactionRef" autoComplete="off" aria-invalid={!!err("transactionRef")} />
                {err("transactionRef") && <span className="err">{err("transactionRef")}</span>}
              </div>
              <div className="field">
                <label htmlFor={`vd-${id}`}>Value date</label>
                <input id={`vd-${id}`} name="valueDate" type="date" max={today} defaultValue={today} aria-invalid={!!err("valueDate")} />
                {err("valueDate") && <span className="err">{err("valueDate")}</span>}
              </div>
              <div className="field">
                <label htmlFor={`am-${id}`}>Amount paid</label>
                <input id={`am-${id}`} name="amount" inputMode="decimal" placeholder={formatNairaKobo(netKobo)} aria-invalid={!!err("amount")} />
                <span className={err("amount") ? "err" : "hint"}>{err("amount") ?? `Must equal the approved net amount, ${formatNairaKobo(netKobo)}.`}</span>
              </div>
              <div className="field">
                <label htmlFor={`ev-${id}`}>Disbursement evidence</label>
                <select id={`ev-${id}`} name="evidenceDocumentId" defaultValue={evidence.at(-1)?.id} aria-invalid={!!err("evidenceDocumentId")}>
                  <option value="">Choose…</option>
                  {evidence.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.label}
                    </option>
                  ))}
                </select>
                {err("evidenceDocumentId") && <span className="err">{err("evidenceDocumentId")}</span>}
              </div>
            </div>
            <label className="check">
              <input type="checkbox" name="confirmed" />
              <span>I confirm the transfer has been completed in core banking for exactly this amount to the applicant&apos;s salary account.</span>
            </label>
            {err("confirmed") && <span className="err">{err("confirmed")}</span>}
            <FormMessages state={state} />
            <div className="action-bar">
              <SubmitButton className="btn btn-primary">Mark disbursement completed</SubmitButton>
            </div>
          </div>
        );
      }}
    </ActionForm>
  );
}

export function SimpleAction({ action, hidden, label, className = "btn btn-primary", children }: { action: Action; hidden: Record<string, string>; label: string; className?: string; children?: React.ReactNode }) {
  return (
    <ActionForm action={action}>
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {children}
      <div className="action-bar">
        <SubmitButton className={className}>{label}</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function ReassignForm({ id, current, officers }: { id: string; current: string | null; officers: { id: string; label: string }[] }) {
  return (
    <ActionForm action={reassignAction}>
      <input type="hidden" name="id" value={id} />
      <div className="field">
        <label htmlFor={`ra-${id}`}>{current ? `Reassign from ${current}` : "Assign a Disbursement Officer"}</label>
        <select id={`ra-${id}`} name="officerId" required>
          <option value="">Choose…</option>
          {officers.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`rr-${id}`}>Reason (recorded in the assignment history)</label>
        <input id={`rr-${id}`} name="reason" required minLength={3} />
      </div>
      <div className="action-bar">
        <SubmitButton className="btn btn-sm">{current ? "Reassign" : "Assign"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

export { ConfirmButtonInline };
