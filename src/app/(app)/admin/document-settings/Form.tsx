"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { saveDocumentSettingsAction } from "./actions";

type V = Record<"bankName" | "bankAddress" | "beneficiaryName" | "beneficiaryBank" | "beneficiaryAccount" | "beneficiaryEmail" | "beneficiaryPhone" | "charge" | "vatPercent", string>;

const F: [keyof V, string, string?][] = [
  ["bankName", "Bank name (printed on documents)"],
  ["bankAddress", "Bank address (optional)"],
  ["beneficiaryName", "Remita beneficiary name", "e.g. The Alternative Bank"],
  ["beneficiaryBank", "Beneficiary bank"],
  ["beneficiaryAccount", "Beneficiary account number"],
  ["beneficiaryEmail", "Beneficiary email"],
  ["beneficiaryPhone", "Beneficiary phone (optional)"],
  ["charge", "Remita charge per debit (NGN, optional)", "e.g. 1000"],
  ["vatPercent", "VAT on charges (%)", "e.g. 7.5"],
];

export function DocumentSettingsForm({ v }: { v: V }) {
  return (
    <ActionForm action={saveDocumentSettingsAction}>
      {(st) => (
        <>
          <div className="grid-2">
            {F.map(([k, label, ph]) => (
              <div className="field" key={k}>
                <label htmlFor={`ds-${k}`}>{label}</label>
                <input id={`ds-${k}`} name={k} defaultValue={v[k]} placeholder={ph} />
                {st.fields?.[k] && <span className="err">{st.fields[k]}</span>}
              </div>
            ))}
          </div>
          <div className="field">
            <label htmlFor="ds-reason">Reason for the change</label>
            <textarea id="ds-reason" name="reason" rows={2} required minLength={20} />
            {st.fields?.reason && <span className="err">{st.fields.reason}</span>}
          </div>
          <div>
            <SubmitButton>Save document settings</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
