"use client";
import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { AmountInput } from "@/components/inputs";
import { taskActionAction } from "../actions";
import {
  closeFacilityAction,
  decideExceptionAction,
  finalAssessmentAction,
  fulfilmentTaskAction,
  paymentEventAction,
  repaymentAction,
  restructureDecisionAction,
  reviewDocumentAction,
  servicingAction,
  suspensionAction,
  withdrawAction,
} from "../retail-actions";

type Hidden = Record<string, string>;
const Hiddens = ({ h }: { h: Hidden }) => (
  <>
    {Object.entries(h).map(([k, v]) => (
      <input key={k} type="hidden" name={k} value={v} />
    ))}
  </>
);

/** Business review decision with mandatory comments; Team Lead also records visit comments and the RM photo confirmation. */
export function BusinessDecisionForm({ hidden, action, label, visitRequired, rmPhotoRequired, doneHref, hint }: { hidden: Hidden; action: string; label: string; visitRequired: boolean; rmPhotoRequired: boolean; doneHref: string; hint: string }) {
  return (
    <ActionForm action={taskActionAction} doneHref={doneHref}>
      <Hiddens h={{ ...hidden, action }} />
      <div className="field">
        <label htmlFor="bd-reason">
          Recommendation and supporting comments<span className="req" aria-hidden="true"> *</span>
        </label>
        <textarea id="bd-reason" name="reason" rows={4} required minLength={10} />
        <span className="hint">{hint}</span>
      </div>
      {visitRequired && (
        <div className="field">
          <label htmlFor="bd-visit">
            Management visit comments<span className="req" aria-hidden="true"> *</span>
          </label>
          <textarea id="bd-visit" name="visitComments" rows={3} required minLength={20} />
          <span className="hint">Required for this product and profile: what you observed at the visit or how you validated it.</span>
        </div>
      )}
      {rmPhotoRequired && (
        <label className="check">
          <input type="checkbox" name="rmPhotoConfirmed" />
          <span>I have looked at the business photographs and one clearly shows the Relationship Manager with the business. (Your confirmation; the system does not check image content.)</span>
        </label>
      )}
      <div>
        <SubmitButton>{label}</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function FinalAssessmentForm({ applicationId, defaults }: { applicationId: string; defaults: { incomeBasis: string; principal: string; tenor: string; statementFrom: string; statementTo: string; obligations: { lender: string; monthly: string }[]; denominatorLabel: string; capApplies: boolean } }) {
  const [income, setIncome] = useState(defaults.incomeBasis);
  const [principal, setPrincipal] = useState(defaults.principal);
  const [obl, setObl] = useState(defaults.obligations.length ? defaults.obligations : [{ lender: "", monthly: "" }]);
  const [charges, setCharges] = useState<{ label: string; amount: string }[]>([]);
  const [turnover, setTurnover] = useState("");
  return (
    <ActionForm action={finalAssessmentAction}>
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="incomeBasis" value={income} />
      <input type="hidden" name="principal" value={principal} />
      <input type="hidden" name="turnoverForCap" value={turnover} />
      <div className="grid-2">
        <div className="field">
          <label htmlFor="fa-income">{/^verified\b/i.test(defaults.denominatorLabel) ? defaults.denominatorLabel.replace(/^v/, "V") : `Verified ${defaults.denominatorLabel}`}</label>
          <AmountInput id="fa-income" value={income} onChange={setIncome} />
        </div>
        <div className="field">
          <label htmlFor="fa-note">Basis and evidence</label>
          <input id="fa-note" name="incomeBasisNote" placeholder="e.g. average of 6 months' credits" />
        </div>
        <div className="field">
          <label htmlFor="fa-from">Statement period from</label>
          <input id="fa-from" name="statementFrom" type="date" defaultValue={defaults.statementFrom} />
        </div>
        <div className="field">
          <label htmlFor="fa-to">Statement period to</label>
          <input id="fa-to" name="statementTo" type="date" defaultValue={defaults.statementTo} />
        </div>
        <div className="field">
          <label htmlFor="fa-principal">Principal</label>
          <AmountInput id="fa-principal" value={principal} onChange={setPrincipal} />
        </div>
        <div className="field">
          <label htmlFor="fa-tenor">Tenor (months)</label>
          <input id="fa-tenor" name="tenor" inputMode="numeric" defaultValue={defaults.tenor} />
        </div>
        {defaults.capApplies && (
          <div className="field">
            <label htmlFor="fa-turnover">Turnover for principal cap</label>
            <AmountInput id="fa-turnover" value={turnover} onChange={setTurnover} />
          </div>
        )}
      </div>
      <fieldset className="subfield">
        <legend>Existing monthly obligations (verified)</legend>
        {obl.map((o, i) => (
          <div className="row" key={i} style={{ alignItems: "end" }}>
            <div className="field" style={{ flex: 2 }}>
              <label htmlFor={`fa-l-${i}`}>Lender</label>
              <input id={`fa-l-${i}`} name="ob_lender" value={o.lender} onChange={(e) => setObl(obl.map((x, j) => (j === i ? { ...x, lender: e.target.value } : x)))} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor={`fa-m-${i}`}>Monthly</label>
              <AmountInput id={`fa-m-${i}`} value={o.monthly} onChange={(v) => setObl(obl.map((x, j) => (j === i ? { ...x, monthly: v } : x)))} />
              <input type="hidden" name="ob_monthly" value={o.monthly} />
            </div>
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => setObl([...obl, { lender: "", monthly: "" }])}>
          Add obligation
        </button>
      </fieldset>
      <fieldset className="subfield">
        <legend>Applicable charges (shown separately)</legend>
        {charges.map((c, i) => (
          <div className="row" key={i} style={{ alignItems: "end" }}>
            <div className="field" style={{ flex: 2 }}>
              <label htmlFor={`fa-cl-${i}`}>Charge</label>
              <input id={`fa-cl-${i}`} name="ch_label" value={c.label} onChange={(e) => setCharges(charges.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor={`fa-ca-${i}`}>Amount</label>
              <AmountInput id={`fa-ca-${i}`} value={c.amount} onChange={(v) => setCharges(charges.map((x, j) => (j === i ? { ...x, amount: v } : x)))} />
              <input type="hidden" name="ch_amount" value={c.amount} />
            </div>
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => setCharges([...charges, { label: "", amount: "" }])}>
          Add charge
        </button>
      </fieldset>
      <div>
        <SubmitButton className="btn btn-dark">Calculate and save final assessment</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function BookFacilityForm({ hidden, principal, defaultDue, doneHref }: { hidden: Hidden; principal: string; defaultDue: string; doneHref: string }) {
  const [amount, setAmount] = useState(principal);
  return (
    <ActionForm action={taskActionAction} doneHref={doneHref}>
      <Hiddens h={{ ...hidden, action: "BOOK_FACILITY", principal: amount }} />
      <p className="small muted" style={{ margin: 0 }}>Booking records the facility in core banking. It does not mark any payment as made: payment is confirmed and reconciled separately by the Disbursement team.</p>
      <div className="field">
        <label htmlFor="bk-ref">Core banking facility reference</label>
        <input id="bk-ref" name="bookingRef" required />
      </div>
      <div className="field">
        <label htmlFor="bk-amt">Principal booked (must equal the approved principal)</label>
        <AmountInput id="bk-amt" value={amount} onChange={setAmount} />
      </div>
      <div className="field">
        <label htmlFor="bk-due">First repayment date</label>
        <input id="bk-due" name="firstDueDate" type="date" defaultValue={defaultDue} required />
      </div>
      <div>
        <SubmitButton>Book facility</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function PaymentEventForm({ applicationId, evidence, principal }: { applicationId: string; evidence: { id: string; label: string }[]; principal: string }) {
  const [amount, setAmount] = useState(principal);
  const [type, setType] = useState("CONFIRMED");
  return (
    <ActionForm action={paymentEventAction} resetOnSuccess>
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="amount" value={amount} />
      <div className="grid-2">
        <div className="field">
          <label htmlFor="pe-type">Outcome</label>
          <select id="pe-type" name="eventType" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="INITIATED">Initiated (outcome not yet known)</option>
            <option value="CONFIRMED">Confirmed (with evidence)</option>
            <option value="FAILED">Failed</option>
            <option value="REVERSED">Reversed</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="pe-ref">Payment reference</label>
          <input id="pe-ref" name="paymentRef" required />
        </div>
        <div className="field">
          <label htmlFor="pe-amt">Amount</label>
          <AmountInput id="pe-amt" value={amount} onChange={setAmount} />
        </div>
        <div className="field">
          <label htmlFor="pe-date">Value date</label>
          <input id="pe-date" name="valueDate" type="date" />
        </div>
      </div>
      <fieldset className="subfield">
        <legend>Evidence (payment advice / statement)</legend>
        {evidence.length === 0 && <p className="small muted" style={{ margin: 0 }}>Upload the payment evidence first.</p>}
        {evidence.map((e) => (
          <label key={e.id} className="check">
            <input type="checkbox" name="evidence" value={e.id} />
            {e.label}
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor="pe-note">Note</label>
        <input id="pe-note" name="note" />
      </div>
      <div>
        <SubmitButton className="btn btn-dark">Record payment outcome</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function FulfilmentForm({ applicationId, kind, label, evidence }: { applicationId: string; kind: string; label: string; evidence: { id: string; label: string }[] }) {
  return (
    <ActionForm action={fulfilmentTaskAction}>
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="kind" value={kind} />
      <div className="field">
        <label htmlFor={`ff-${kind}`}>{label}: what was done</label>
        <input id={`ff-${kind}`} name="note" placeholder={kind === "POS_DEPLOYMENT" ? "POS terminal ID and deployment date" : "Delivery note / handover reference"} required />
      </div>
      {evidence.map((e) => (
        <label key={e.id} className="check">
          <input type="checkbox" name="evidence" value={e.id} />
          {e.label}
        </label>
      ))}
      <div>
        <SubmitButton className="btn btn-sm btn-dark" disabled={!evidence.length}>
          Mark {label.toLowerCase()} complete
        </SubmitButton>
      </div>
    </ActionForm>
  );
}

export function DocReview({ documentId }: { documentId: string }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(true)}>
        Review…
      </button>
    );
  return (
    <ActionForm action={reviewDocumentAction} className="row">
      <input type="hidden" name="documentId" value={documentId} />
      <input name="reason" placeholder="Reason (required to reject)" aria-label="Reason" />
      <SubmitButton className="btn btn-sm btn-danger" name="decision" value="REJECTED">
        Reject
      </SubmitButton>
      <SubmitButton className="btn btn-sm" name="decision" value="ACCEPTED">
        Accept
      </SubmitButton>
    </ActionForm>
  );
}

export function ReasonForm({ kind, hidden, label, danger }: { kind: "withdraw" | "suspend" | "resume"; hidden: Hidden; label: string; danger?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" className={`btn btn-sm ${danger ? "btn-danger" : ""}`} onClick={() => setOpen(true)}>
        {label}…
      </button>
    );
  return (
    <ActionForm action={kind === "withdraw" ? withdrawAction : suspensionAction}>
      <Hiddens h={{ ...hidden, ...(kind === "withdraw" ? {} : { mode: kind }) }} />
      <div className="field">
        <label htmlFor={`rf-${kind}`}>{label}: reason</label>
        <textarea id={`rf-${kind}`} name="reason" required minLength={5} rows={2} />
      </div>
      <div className="row">
        <SubmitButton className={`btn btn-sm ${danger ? "btn-danger" : "btn-dark"}`}>Confirm</SubmitButton>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}

export function ExceptionDecision({ exceptionId }: { exceptionId: string }) {
  return (
    <ActionForm action={decideExceptionAction}>
      <input type="hidden" name="exceptionId" value={exceptionId} />
      <div className="field">
        <label htmlFor={`exd-${exceptionId}`}>Decision basis</label>
        <textarea id={`exd-${exceptionId}`} name="note" rows={2} required minLength={5} />
      </div>
      <div className="row">
        <SubmitButton className="btn btn-sm btn-primary" name="decision" value="APPROVE">
          Approve exception
        </SubmitButton>
        <SubmitButton className="btn btn-sm btn-danger" name="decision" value="DECLINE">
          Decline
        </SubmitButton>
      </div>
    </ActionForm>
  );
}

export function ServicingForms({ facilityId, evidence, canClose, restructurePending, decisionOnly = false }: { facilityId: string; evidence: { id: string; label: string }[]; canClose: boolean; restructurePending: { id: string; note: string; canDecide: boolean }[]; decisionOnly?: boolean }) {
  const [amount, setAmount] = useState("");
  return (
    <div className="stack">
      {!decisionOnly && (<>
      <ActionForm action={repaymentAction} resetOnSuccess>
        <input type="hidden" name="facilityId" value={facilityId} />
        <input type="hidden" name="amount" value={amount} />
        <strong className="small">Record repayment</strong>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="rp-type">Type</label>
            <select id="rp-type" name="eventType">
              <option value="RECEIVED">Received</option>
              <option value="REVERSED">Reversal</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="rp-ref">Reference</label>
            <input id="rp-ref" name="reference" required />
          </div>
          <div className="field">
            <label htmlFor="rp-amt">Amount</label>
            <AmountInput id="rp-amt" value={amount} onChange={setAmount} />
          </div>
          <div className="field">
            <label htmlFor="rp-date">Value date</label>
            <input id="rp-date" name="valueDate" type="date" required />
          </div>
        </div>
        {evidence.map((e) => (
          <label key={e.id} className="check">
            <input type="checkbox" name="evidence" value={e.id} />
            {e.label}
          </label>
        ))}
        <div>
          <SubmitButton className="btn btn-sm btn-dark">Record</SubmitButton>
        </div>
      </ActionForm>
      <ActionForm action={servicingAction} resetOnSuccess>
        <input type="hidden" name="facilityId" value={facilityId} />
        <strong className="small">Arrears follow-up, recovery or restructuring</strong>
        <div className="field">
          <label htmlFor="sv-kind">Type</label>
          <select id="sv-kind" name="kind">
            <option value="ARREARS_FOLLOW_UP">Arrears follow-up</option>
            <option value="RECOVERY_NOTE">Recovery note</option>
            <option value="RESTRUCTURE_REQUEST">Restructuring request</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="sv-note">Details</label>
          <textarea id="sv-note" name="note" rows={2} required />
        </div>
        <div className="field">
          <label htmlFor="sv-terms">Proposed terms (restructuring only)</label>
          <input id="sv-terms" name="proposedTerms" />
        </div>
        <div>
          <SubmitButton className="btn btn-sm">Save</SubmitButton>
        </div>
      </ActionForm>
      </>)}
      {restructurePending.map((r) => (
        <div key={r.id} className="summary-box small">
          Restructure requested: {r.note}
          {r.canDecide && (
            <ActionForm action={restructureDecisionAction}>
              <input type="hidden" name="actionId" value={r.id} />
              <input name="note" aria-label="Decision note" placeholder="Decision note" required />
              <div className="row">
                <SubmitButton className="btn btn-sm btn-primary" name="decision" value="APPROVE">Approve</SubmitButton>
                <SubmitButton className="btn btn-sm btn-danger" name="decision" value="DECLINE">Decline</SubmitButton>
              </div>
            </ActionForm>
          )}
        </div>
      ))}
      {canClose && (
        <ActionForm action={closeFacilityAction}>
          <input type="hidden" name="facilityId" value={facilityId} />
          <SubmitButton className="btn btn-sm btn-primary">Close settled facility</SubmitButton>
        </ActionForm>
      )}
    </div>
  );
}

/** Submit the offer pack after confirming the structure's contractual steps were completed in order. */
export function ContractSubmit({ hidden, doneHref, disabled }: { hidden: Hidden; doneHref: string; disabled: boolean }) {
  return (
    <ActionForm action={taskActionAction} doneHref={doneHref}>
      <Hiddens h={{ ...hidden, action: "SUBMIT_PACK" }} />
      <label className="check">
        <input type="checkbox" name="contractStepsConfirmed" />
        <span>I confirm the contractual steps above were completed in order and the evidence is uploaded.</span>
      </label>
      <div>
        <SubmitButton disabled={disabled}>Submit pack to Credit Officer 3</SubmitButton>
      </div>
    </ActionForm>
  );
}
