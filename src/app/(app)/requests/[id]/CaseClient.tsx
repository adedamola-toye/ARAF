"use client";
import { useRef, useState } from "react";
import { AlertTriangle, Calculator, CheckCircle2, Eye, FilePlus2, Pencil, ShieldCheck } from "lucide-react";
import { ActionForm, FormMessages, ReasonAction, SubmitButton, type FormState } from "@/components/forms";
import { assessmentAction, generateOfferAction, reminderAction, revealAction, taskActionAction } from "../actions";

type Hidden = Record<string, string>;
const Hiddens = ({ h }: { h: Hidden }) => (
  <>
    {Object.entries(h).map(([k, v]) => (
      <input key={k} type="hidden" name={k} value={v} />
    ))}
  </>
);

export function ReminderButton({ applicationId }: { applicationId: string }) {
  return (
    <ActionForm action={reminderAction} className="row">
      <input type="hidden" name="applicationId" value={applicationId} />
      <SubmitButton className="btn btn-sm">Send reminder</SubmitButton>
    </ActionForm>
  );
}

/** One-click task action (Endorse, Approve, Proceed, Forward, Resubmit, Complete Process …). */
export function TaskButton({ hidden, action, label, primary = true, confirm, doneHref, disabled }: { hidden: Hidden; action: string; label: string; primary?: boolean; confirm?: string; doneHref: string; disabled?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement | null>(null);
  return (
    <ActionForm action={taskActionAction} doneHref={doneHref}>
      <Hiddens h={{ ...hidden, action }} />
      {confirm ? (
        <>
          <button
            type="button"
            className={`btn ${primary ? "btn-primary" : ""}`}
            disabled={disabled}
            onClick={(e) => {
              form.current = e.currentTarget.form;
              dialog.current?.showModal();
            }}
          >
            {label}
          </button>
          <dialog ref={dialog} className="modal" aria-labelledby={`dlg-${action}`}>
            <div className="modal-body">
              <h2 id={`dlg-${action}`}>{label}</h2>
              <p className="muted" style={{ margin: 0 }}>
                {confirm}
              </p>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => dialog.current?.close()} autoFocus>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  dialog.current?.close();
                  form.current?.requestSubmit();
                }}
              >
                Confirm
              </button>
            </div>
          </dialog>
        </>
      ) : (
        <div>
          <SubmitButton className={`btn ${primary ? "btn-primary" : ""}`} disabled={disabled}>
            {label}
          </SubmitButton>
        </div>
      )}
    </ActionForm>
  );
}

export function ReasonButton({ hidden, action, label, danger, doneHref }: { hidden: Hidden; action: string; label: string; danger?: boolean; doneHref: string }) {
  return <ReasonAction action={taskActionAction} hidden={{ ...hidden, action }} label={label} danger={danger} doneHref={doneHref} />;
}

/**
 * First credit review approval. The server enforces the three-report, assessment and invoice
 * gates; the UI shows the exact "Do not forget to log invoice" dialog with Cancel and Confirm.
 */
export function FirstReviewApprove({ hidden, ready, doneHref }: { hidden: Hidden; ready: boolean; doneHref: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement | null>(null);
  const confirmed = useRef<HTMLInputElement>(null);
  const [invoiceLogged, setInvoiceLogged] = useState(false);
  return (
    <ActionForm action={taskActionAction} doneHref={doneHref}>
      {(_state: FormState) => (
        <>
          <Hiddens h={{ ...hidden, action: "APPROVE" }} />
          <input ref={confirmed} type="hidden" name="invoiceDialogConfirmed" value="false" />
          <label className="toggle">
            <input type="checkbox" name="invoiceLogged" checked={invoiceLogged} onChange={(e) => setInvoiceLogged(e.target.checked)} />
            Logged invoice on invoice portal
          </label>
          <span className="small muted">Staff attestation. No invoice-portal integration is connected.</span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ready}
            aria-describedby={!ready ? "approve-blocked" : undefined}
            onClick={(e) => {
              form.current = e.currentTarget.form;
              if (confirmed.current) confirmed.current.value = "false";
              dialog.current?.showModal();
            }}
          >
            Approve
          </button>
          {!ready && (
            <p id="approve-blocked" className="blocked" style={{ margin: 0 }}>
              <AlertTriangle className="icon" aria-hidden="true" />
              Approval is blocked until three credit reports are uploaded and the APR / DSR assessment is saved for the current version.
            </p>
          )}
          <dialog ref={dialog} className="modal" aria-labelledby="invoice-dialog-title" aria-describedby="invoice-dialog-desc">
            <div className="modal-body">
              <h2 id="invoice-dialog-title">Do not forget to log invoice</h2>
              <p id="invoice-dialog-desc" className="muted" style={{ margin: 0 }}>
                {invoiceLogged ? "You have confirmed the invoice is logged on the invoice portal." : 'You have not switched on "Logged invoice on invoice portal". The approval will be refused until you do.'}
              </p>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => dialog.current?.close()} autoFocus>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (confirmed.current) confirmed.current.value = "true";
                  dialog.current?.close();
                  form.current?.requestSubmit();
                }}
              >
                Confirm
              </button>
            </div>
          </dialog>
        </>
      )}
    </ActionForm>
  );
}

/** Disbursement Officer 1: CRMS review. Visually distinct from DO2's booking. */
export function CrmsOkay({ hidden, doneHref }: { hidden: Hidden; doneHref: string }) {
  const [on, setOn] = useState(false);
  return (
    <ActionForm action={taskActionAction} doneHref={doneHref}>
      <Hiddens h={{ ...hidden, action: "OKAY" }} />
      <label className="toggle">
        <input type="checkbox" name="crmsLogged" checked={on} onChange={(e) => setOn(e.target.checked)} />
        Logged CRMS
      </label>
      <span className="small muted">Staff attestation. No CRMS integration is connected.</span>
      {!on && (
        <p className="blocked" style={{ margin: 0 }}>
          <AlertTriangle className="icon" aria-hidden="true" />
          Switch on “Logged CRMS” before selecting Okay.
        </p>
      )}
      <div>
        <SubmitButton disabled={!on}>Okay</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function GenerateOffer({ applicationId, hasOffer, templateLabel }: { applicationId: string; hasOffer: boolean; templateLabel: string }) {
  return (
    <ActionForm action={generateOfferAction}>
      <input type="hidden" name="applicationId" value={applicationId} />
      <p className="small muted" style={{ margin: 0 }}>
        Template: {templateLabel}
      </p>
      <div>
        <SubmitButton className={hasOffer ? "btn" : "btn btn-primary"}>
          <FilePlus2 className="icon" aria-hidden="true" />
          {hasOffer ? "Regenerate offer (new version)" : "Generate offer letter"}
        </SubmitButton>
      </div>
    </ActionForm>
  );
}

export interface CalcField {
  key: string;
  label: string;
  kind: string;
  value: string;
  options?: { value: string; label: string }[];
  optional?: boolean;
}
export function AssessmentForm({ applicationId, fields, calculatorLabel }: { applicationId: string; fields: CalcField[]; calculatorLabel: string }) {
  const [started] = useState(() => new Date().toISOString());
  return (
    <ActionForm action={assessmentAction}>
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="startedAt" value={started} />
      <p className="small muted" style={{ margin: 0 }}>
        <Calculator className="icon" aria-hidden="true" /> {calculatorLabel}
      </p>
      <div className="grid-2">
        {fields.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={`calc-${f.key}`}>
              {f.label}
              {f.kind === "money" ? " (₦)" : ""}
            </label>
            {f.kind === "select" ? (
              <select id={`calc-${f.key}`} name={f.key} defaultValue={f.value}>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input id={`calc-${f.key}`} name={f.key} defaultValue={f.value} inputMode="decimal" required={!f.optional && f.kind !== "money"} />
            )}
          </div>
        ))}
      </div>
      <div>
        <SubmitButton className="btn btn-dark">Calculate and save APR / DSR</SubmitButton>
      </div>
    </ActionForm>
  );
}

const naira = (s: string) => {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s.replace(/[,₦\s]/g, ""));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
};
const fmt = (k: number) => "₦" + (k / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Disbursement Officer 2: record the booking, review a confirmation summary, then click Disbursed.
 * Duplicate submission is prevented server-side (idempotency key, one disbursement per request,
 * unique transaction reference).
 */
export function BookingForm({ hidden, approved, defaultDate, doneHref }: { hidden: Hidden; approved: string; defaultDate: string; doneHref: string }) {
  const [rows, setRows] = useState([{ dueDate: "", amount: "" }]);
  const [amount, setAmount] = useState(approved);
  const [date, setDate] = useState(defaultDate);
  const [ref, setRef] = useState("");
  const [review, setReview] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const check = () => {
    if (naira(amount) === null || naira(amount)! <= 0) return "Enter the disbursed amount.";
    if (!date) return "Enter the disbursement date.";
    if (!/^[A-Za-z0-9\-/_.]{4,64}$/.test(ref.trim())) return "Enter the transaction reference (4–64 letters, digits or - / _ .).";
    if (rows.some((r) => !r.dueDate || naira(r.amount) === null)) return "Complete every repayment date and amount.";
    return null;
  };
  const total = rows.reduce((s, r) => s + (naira(r.amount) ?? 0), 0);
  return (
    <ActionForm action={taskActionAction} doneHref={doneHref}>
      <Hiddens h={{ ...hidden, action: "DISBURSED" }} />
      <input type="hidden" name="schedule" value={JSON.stringify(rows)} />
      <input type="hidden" name="amount" value={amount} />
      <input type="hidden" name="disbursedOn" value={date} />
      <input type="hidden" name="transactionRef" value={ref.trim()} />
      {!review ? (
        <>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="bk-amount">Disbursed amount (₦)</label>
              <input id="bk-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              <span className="hint">Approved: ₦{approved}</span>
            </div>
            <div className="field">
              <label htmlFor="bk-date">Disbursement date</label>
              <input id="bk-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label htmlFor="bk-ref">Transaction reference</label>
              <input id="bk-ref" value={ref} onChange={(e) => setRef(e.target.value)} autoComplete="off" />
            </div>
          </div>
          <fieldset style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 12, margin: 0 }}>
            <legend className="small" style={{ fontWeight: 700, padding: "0 4px" }}>
              Repayment date or instalment schedule
            </legend>
            {rows.map((r, i) => (
              <div className="row" key={i} style={{ marginBottom: 8 }}>
                <input aria-label={`Instalment ${i + 1} due date`} type="date" value={r.dueDate} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))} style={{ width: 160 }} />
                <input aria-label={`Instalment ${i + 1} amount in naira`} placeholder="Amount (₦)" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} style={{ width: 150 }} inputMode="decimal" />
                {rows.length > 1 && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove instalment ${i + 1}`}>
                    Remove
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => setRows([...rows, { dueDate: "", amount: "" }])}>
              Add instalment
            </button>
          </fieldset>
          {problem && (
            <p className="blocked" role="alert" style={{ margin: 0 }}>
              <AlertTriangle className="icon" aria-hidden="true" />
              {problem}
            </p>
          )}
          <div>
            <button
              type="button"
              className="btn btn-dark"
              onClick={() => {
                const p = check();
                setProblem(p);
                if (!p) setReview(true);
              }}
            >
              <Eye className="icon" aria-hidden="true" /> Review booking
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="summary-box" role="region" aria-label="Booking confirmation summary" tabIndex={-1} ref={(el) => el?.focus()}>
            <p className="eyebrow">Confirm booking</p>
            <table className="kv">
              <tbody>
                <tr><th>Disbursed amount</th><td className="tnum"><strong>{fmt(naira(amount)!)}</strong></td></tr>
                <tr><th>Disbursement date</th><td>{date}</td></tr>
                <tr><th>Transaction reference</th><td className="mono">{ref.trim()}</td></tr>
                <tr><th>Repayments</th><td>{rows.map((r, i) => <div key={i} className="tnum">{r.dueDate} · {fmt(naira(r.amount) ?? 0)}</div>)}<div className="small muted">Total scheduled {fmt(total)}</div></td></tr>
              </tbody>
            </table>
            <p className="small muted" style={{ margin: "8px 0 0" }}>
              <ShieldCheck className="icon" aria-hidden="true" /> Records the booking only. This system does not transfer funds. Credit Officer 3 and the initiator are notified.
            </p>
          </div>
          <div className="row">
            <button type="button" className="btn" onClick={() => setReview(false)}>
              <Pencil className="icon" aria-hidden="true" /> Edit
            </button>
            <SubmitButton>
              Disbursed <CheckCircle2 className="icon" aria-hidden="true" />
            </SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function RevealIdentifiers({ applicationId }: { applicationId: string }) {
  return (
    <ActionForm action={revealAction} refreshOnSuccess={false} showMessages={false}>
      {(state) => {
        const d = state.data as { bvn: string | null; tin: string | null; directors: { fullName: string; bvn: string }[] } | undefined;
        return (
          <>
            <input type="hidden" name="applicationId" value={applicationId} />
            <FormMessages state={{ error: state.error }} />
            {d ? (
              <div className="highlight small" role="status">
                {d.bvn && <div>BVN: <span className="mono">{d.bvn}</span></div>}
                {d.tin && <div>TIN: <span className="mono">{d.tin}</span></div>}
                {d.directors.map((x, i) => (
                  <div key={i}>
                    {x.fullName}: <span className="mono">{x.bvn}</span>
                  </div>
                ))}
                <div className="muted">This reveal was recorded in the audit trail.</div>
              </div>
            ) : (
              <div>
                <SubmitButton className="btn btn-sm">
                  <Eye className="icon" aria-hidden="true" /> Reveal identifiers (audited)
                </SubmitButton>
              </div>
            )}
          </>
        );
      }}
    </ActionForm>
  );
}

