"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { recordRepaymentAction, reverseRepaymentAction } from "./actions";

/** Record one repayment on a facility (payment date, amount, payment reference as evidence). */
export function RecordRepaymentForm({ id, today, suggested }: { id: string; today: string; suggested: string }) {
  return (
    <ActionForm action={recordRepaymentAction} resetOnSuccess className="stack alt-repay-form">
      {(st) => (
        <>
          <input type="hidden" name="id" value={id} />
          <h3 className="section-title" style={{ margin: 0 }}>
            Record a repayment
          </h3>
          <div className="grid-3">
            <div className="field">
              <label htmlFor="paidOn">Payment date</label>
              <input id="paidOn" name="paidOn" type="date" required max={today} aria-invalid={!!st.fields?.paidOn} />
              {st.fields?.paidOn && <p className="err">{st.fields.paidOn}</p>}
            </div>
            <div className="field">
              <label htmlFor="amount">Amount (₦)</label>
              <input id="amount" name="amount" inputMode="decimal" required placeholder={suggested} aria-invalid={!!st.fields?.amount} />
              {st.fields?.amount && <p className="err">{st.fields.amount}</p>}
            </div>
            <div className="field">
              <label htmlFor="reference">Payment reference</label>
              <input id="reference" name="reference" required aria-invalid={!!st.fields?.reference} aria-describedby="reference-h" />
              <p id="reference-h" className="small muted" style={{ margin: 0 }}>
                From the bank statement or receipt.
              </p>
              {st.fields?.reference && <p className="err">{st.fields.reference}</p>}
            </div>
          </div>
          <div className="field">
            <label htmlFor="note">Note (optional)</label>
            <input id="note" name="note" />
          </div>
          <div>
            <SubmitButton>Record repayment</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

/** Reverse a repayment (Unit Head or Super Admin who did not record it), with a reason. */
export function ReverseRepaymentForm({ repaymentId }: { repaymentId: string }) {
  return (
    <details className="alt-reverse">
      <summary className="btn btn-ghost btn-sm">Reverse…</summary>
      <ActionForm action={reverseRepaymentAction} className="stack">
        {(st) => (
          <>
            <input type="hidden" name="repaymentId" value={repaymentId} />
            <div className="field">
              <label htmlFor={`rev-${repaymentId}`}>Reason for the reversal</label>
              <input id={`rev-${repaymentId}`} name="reason" required minLength={10} aria-invalid={!!st.fields?.reason} />
              {st.fields?.reason && <p className="err">{st.fields.reason}</p>}
            </div>
            <div>
              <SubmitButton className="btn btn-sm">Reverse this repayment</SubmitButton>
            </div>
          </>
        )}
      </ActionForm>
    </details>
  );
}
