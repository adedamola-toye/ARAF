"use client";
import { useRef, useState } from "react";
import { ActionForm, FormMessages, ReasonAction, SubmitButton, type FormState } from "@/components/forms";
import {
  assessmentAction,
  generateOfferAction,
  reminderAction,
  revealAction,
  taskActionAction,
  uploadDocumentAction,
} from "../actions";

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

/** A one-click task action (Endorse, Approve, Proceed, Forward, Resubmit, Complete Process ...). */
export function TaskButton({ hidden, action, label, primary = true, confirm }: { hidden: Hidden; action: string; label: string; primary?: boolean; confirm?: string }) {
  return (
    <ActionForm action={taskActionAction}>
      <Hiddens h={{ ...hidden, action }} />
      <ConfirmingSubmit label={label} primary={primary} confirm={confirm} />
    </ActionForm>
  );
}

function ConfirmingSubmit({ label, primary, confirm }: { label: string; primary: boolean; confirm?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <SubmitButton className={`btn ${primary ? "btn-primary" : ""}`}>
      <span
        ref={ref}
        onClick={(e) => {
          if (confirm && !window.confirm(confirm)) e.preventDefault();
        }}
      >
        {label}
      </span>
    </SubmitButton>
  );
}

export function ReasonButton({ hidden, action, label, danger }: { hidden: Hidden; action: string; label: string; danger?: boolean }) {
  return <ReasonAction action={taskActionAction} hidden={{ ...hidden, action }} label={label} danger={danger} />;
}

/**
 * First credit review approval. The server enforces the three-report, assessment and invoice
 * gates; the UI additionally shows the exact "Do not forget to log invoice" dialog.
 */
export function FirstReviewApprove({ hidden, ready }: { hidden: Hidden; ready: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const confirmed = useRef<HTMLInputElement>(null);
  const [invoiceLogged, setInvoiceLogged] = useState(false);
  return (
    <ActionForm action={taskActionAction}>
      {(state: FormState) => (
        <>
          <Hiddens h={{ ...hidden, action: "APPROVE" }} />
          <input ref={confirmed} type="hidden" name="invoiceDialogConfirmed" value="false" />
          <label className="toggle">
            <input type="checkbox" name="invoiceLogged" checked={invoiceLogged} onChange={(e) => setInvoiceLogged(e.target.checked)} />
            Logged invoice on invoice portal
          </label>
          <span className="small muted">Staff attestation. No invoice-portal integration is connected yet.</span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ready}
            onClick={(e) => {
              form.current = (e.currentTarget as HTMLButtonElement).form;
              dialog.current?.showModal();
            }}
          >
            Approve
          </button>
          {!ready && <span className="small muted">Complete the checklist above to enable approval.</span>}
          <dialog ref={dialog} className="modal" aria-labelledby="invoice-dialog-title">
            <div className="modal-body">
              <h2 id="invoice-dialog-title">Do not forget to log invoice</h2>
              <p className="muted" style={{ margin: 0 }}>
                {invoiceLogged ? "You have confirmed the invoice is logged on the invoice portal." : 'You have not toggled "Logged invoice on invoice portal". Approval will be refused until you do.'}
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
          {state.ok && <span className="sr-only">Approved</span>}
        </>
      )}
    </ActionForm>
  );
}

export function CrmsOkay({ hidden }: { hidden: Hidden }) {
  return (
    <ActionForm action={taskActionAction}>
      <Hiddens h={{ ...hidden, action: "OKAY" }} />
      <label className="toggle">
        <input type="checkbox" name="crmsLogged" />
        Logged CRMS
      </label>
      <span className="small muted">Staff attestation. No CRMS integration is connected yet.</span>
      <div>
        <SubmitButton>Okay</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function UploadForm({ applicationId, categories, replaces }: { applicationId: string; categories: { code: string; label: string }[]; replaces?: { id: string; label: string }[] }) {
  return (
    <ActionForm action={uploadDocumentAction} resetOnSuccess encType="multipart/form-data">
      <input type="hidden" name="applicationId" value={applicationId} />
      <div className="field">
        <label htmlFor={`cat-${applicationId}`}>Document type</label>
        <select id={`cat-${applicationId}`} name="category" required>
          {categories.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      {replaces && replaces.length > 0 && (
        <div className="field">
          <label htmlFor={`rep-${applicationId}`}>Replaces (optional)</label>
          <select id={`rep-${applicationId}`} name="replacesDocumentId" defaultValue="">
            <option value="">New document</option>
            {replaces.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <span className="hint">Single-file categories are versioned automatically; previous versions are kept.</span>
        </div>
      )}
      <div className="field">
        <label htmlFor={`file-${applicationId}`}>File (PDF, PNG, JPG, DOCX, XLSX)</label>
        <input id={`file-${applicationId}`} type="file" name="file" required accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx" />
      </div>
      <div>
        <SubmitButton className="btn btn-dark">Upload</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function GenerateOffer({ applicationId, hasOffer }: { applicationId: string; hasOffer: boolean }) {
  return (
    <ActionForm action={generateOfferAction}>
      <input type="hidden" name="applicationId" value={applicationId} />
      <div>
        <SubmitButton className={hasOffer ? "btn" : "btn btn-primary"}>{hasOffer ? "Regenerate offer (new version)" : "Generate offer letter"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

export interface CalcField {
  key: string;
  label: string;
  kind: string;
  value: string;
}
export function AssessmentForm({ applicationId, fields, calculatorLabel }: { applicationId: string; fields: CalcField[]; calculatorLabel: string }) {
  const [started] = useState(() => new Date().toISOString());
  return (
    <ActionForm action={assessmentAction}>
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="startedAt" value={started} />
      <p className="small muted" style={{ margin: 0 }}>
        Calculator: {calculatorLabel}
      </p>
      <div className="grid-2">
        {fields.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={`calc-${f.key}`}>
              {f.label}
              {f.kind === "money" ? " (₦)" : ""}
            </label>
            <input id={`calc-${f.key}`} name={f.key} defaultValue={f.value} inputMode="decimal" required={f.kind !== "money"} />
          </div>
        ))}
      </div>
      <div>
        <SubmitButton className="btn btn-dark">Calculate and save APR / DSR</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function BookingForm({ hidden, approved, defaultDate }: { hidden: Hidden; approved: string; defaultDate: string }) {
  const [rows, setRows] = useState([{ dueDate: "", amount: "" }]);
  return (
    <ActionForm action={taskActionAction}>
      <Hiddens h={{ ...hidden, action: "DISBURSED" }} />
      <input type="hidden" name="schedule" value={JSON.stringify(rows)} />
      <div className="grid-2">
        <div className="field">
          <label htmlFor="amount">Disbursed amount (₦)</label>
          <input id="amount" name="amount" defaultValue={approved} inputMode="decimal" required />
          <span className="hint">Approved: ₦{approved}</span>
        </div>
        <div className="field">
          <label htmlFor="disbursedOn">Disbursement date</label>
          <input id="disbursedOn" name="disbursedOn" type="date" defaultValue={defaultDate} required />
        </div>
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label htmlFor="transactionRef">Transaction reference</label>
          <input id="transactionRef" name="transactionRef" required pattern="[A-Za-z0-9\-/_.]{4,64}" />
        </div>
      </div>
      <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12 }}>
        <legend className="small" style={{ fontWeight: 700 }}>
          Repayment date or instalment schedule
        </legend>
        {rows.map((r, i) => (
          <div className="row" key={i} style={{ marginBottom: 8 }}>
            <input aria-label={`Instalment ${i + 1} due date`} type="date" value={r.dueDate} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))} style={{ width: 170 }} required />
            <input aria-label={`Instalment ${i + 1} amount`} placeholder="Amount (₦)" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} style={{ width: 160 }} inputMode="decimal" required />
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
      <p className="small muted" style={{ margin: 0 }}>
        Records the booking only. This system does not transfer funds.
      </p>
      <div>
        <SubmitButton>Disbursed</SubmitButton>
      </div>
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
                {d.bvn && (
                  <div>
                    BVN: <span className="mono">{d.bvn}</span>
                  </div>
                )}
                {d.tin && (
                  <div>
                    TIN: <span className="mono">{d.tin}</span>
                  </div>
                )}
                {d.directors.map((x, i) => (
                  <div key={i}>
                    {x.fullName}: <span className="mono">{x.bvn}</span>
                  </div>
                ))}
                <div className="muted">This reveal was recorded in the audit trail.</div>
              </div>
            ) : (
              <div>
                <SubmitButton className="btn btn-sm">Reveal restricted identifiers (audited)</SubmitButton>
              </div>
            )}
          </>
        );
      }}
    </ActionForm>
  );
}
