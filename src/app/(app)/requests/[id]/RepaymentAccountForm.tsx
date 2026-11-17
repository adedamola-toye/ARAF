"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { saveRepaymentAccountAction } from "./closing-actions";

export function RepaymentAccountForm({ applicationId, a, banks }: { applicationId: string; a: { bankName: string; accountNumber: string; accountName: string; branch: string; townCity: string } | null; banks: string[] }) {
  return (
    <ActionForm action={saveRepaymentAccountAction} className="stack">
      {(st) => (
        <>
          <input type="hidden" name="applicationId" value={applicationId} />
          <div className="field">
            <label htmlFor="ra-bank">Customer&apos;s bank</label>
            <input id="ra-bank" name="bankName" list="ra-banks" defaultValue={a?.bankName ?? ""} required autoComplete="off" />
            <datalist id="ra-banks">
              {banks.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
            {st.fields?.bankName && <span className="err">{st.fields.bankName}</span>}
          </div>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="ra-no">Account number</label>
              <input id="ra-no" name="accountNumber" inputMode="numeric" pattern="\d{10}" maxLength={10} defaultValue={a?.accountNumber ?? ""} required />
              {st.fields?.accountNumber && <span className="err">{st.fields.accountNumber}</span>}
            </div>
            <div className="field">
              <label htmlFor="ra-name">Account name</label>
              <input id="ra-name" name="accountName" defaultValue={a?.accountName ?? ""} required />
              {st.fields?.accountName && <span className="err">{st.fields.accountName}</span>}
            </div>
            <div className="field">
              <label htmlFor="ra-branch">Branch (optional)</label>
              <input id="ra-branch" name="branch" defaultValue={a?.branch ?? ""} />
            </div>
            <div className="field">
              <label htmlFor="ra-town">Town / city (optional)</label>
              <input id="ra-town" name="townCity" defaultValue={a?.townCity ?? ""} />
            </div>
          </div>
          <div>
            <SubmitButton>{a ? "Update repayment account" : "Save repayment account"}</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
