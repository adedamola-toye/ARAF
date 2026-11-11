"use client";
import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { SearchSelect, DigitsInput } from "@/components/inputs";
import { proposeBeneficiaryAction, requestExceptionAction, saveProposalAction } from "../../retail-actions";

export function ProposalForm({ applicationId, fields, content, canEdit, authorNote }: { applicationId: string; fields: { key: string; label: string; hint: string; required: boolean }[]; content: Record<string, string>; canEdit: boolean; authorNote: string }) {
  if (!canEdit)
    return (
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>{authorNote}</p>
        {fields.map((f) => (
          <div key={f.key}>
            <strong className="small">{f.label}</strong>
            <p style={{ margin: "2px 0 0", whiteSpace: "pre-wrap" }}>{content[f.key] || <span className="muted">Not written yet</span>}</p>
          </div>
        ))}
      </div>
    );
  return (
    <ActionForm action={saveProposalAction}>
      <input type="hidden" name="applicationId" value={applicationId} />
      <p className="small muted" style={{ margin: 0 }}>{authorNote} Each save creates a new version; earlier versions are kept.</p>
      {fields.map((f) => (
        <div className="field" key={f.key}>
          <label htmlFor={`p_${f.key}`}>
            {f.label}
            {f.required && <span className="req" aria-hidden="true"> *</span>}
          </label>
          <textarea id={`p_${f.key}`} name={`p_${f.key}`} rows={3} defaultValue={content[f.key] ?? ""} />
          <span className="hint">{f.hint}</span>
        </div>
      ))}
      <div>
        <SubmitButton>Save credit proposal</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function BeneficiaryProposalForm({ applicationId, vendors, institutions }: { applicationId: string; vendors: { value: string; label: string }[]; institutions: { value: string; label: string; hint?: string; aliases?: string[] }[] }) {
  const [vendorId, setVendorId] = useState("");
  const [institution, setInstitution] = useState("");
  const [acct, setAcct] = useState("");
  return (
    <ActionForm action={proposeBeneficiaryAction} resetOnSuccess>
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="vendorId" value={vendorId} />
      <input type="hidden" name="institutionId" value={institution} />
      <input type="hidden" name="accountNumber" value={acct} />
      <p className="small muted" style={{ margin: 0 }}>
        Use this when the vendor or its account is not yet in the register. The account stays pending until a vendor register officer verifies it; selecting a bank does not approve an account.
      </p>
      <div className="field">
        <label htmlFor="nb-vendor">Existing vendor (optional)</label>
        <SearchSelect id="nb-vendor" value={vendorId} onChange={setVendorId} options={vendors} placeholder="Search vendors, or leave empty for a new vendor" />
      </div>
      {!vendorId && (
        <div className="grid-2">
          <div className="field">
            <label htmlFor="vendorName">New vendor name</label>
            <input id="vendorName" name="vendorName" />
          </div>
          <div className="field">
            <label htmlFor="vendorEmail">Vendor email</label>
            <input id="vendorEmail" name="vendorEmail" type="email" />
          </div>
          <div className="field">
            <label htmlFor="vendorPhone">Vendor phone (optional)</label>
            <input id="vendorPhone" name="vendorPhone" type="tel" inputMode="tel" maxLength={11} />
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor="nb-bank">Vendor bank (banks and microfinance banks)</label>
        <SearchSelect id="nb-bank" value={institution} onChange={setInstitution} options={institutions} placeholder="Search by bank name or alias" />
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="nb-acct">Account number (NUBAN)</label>
          <DigitsInput id="nb-acct" kind="bvn" length={10} fieldLabel="Account number" value={acct} onChange={setAcct} placeholder="10 digits" />
        </div>
        <div className="field">
          <label htmlFor="accountName">Account name</label>
          <input id="accountName" name="accountName" />
          <span className="hint">Name enquiry: not available (no approved integration). The register team verifies with evidence.</span>
        </div>
      </div>
      <div>
        <SubmitButton className="btn">Capture vendor account for verification</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function ExceptionRequestForm({ applicationId, type, evidence, authority }: { applicationId: string; type: "AFS" | "DSR"; evidence: { id: string; label: string }[]; authority: string }) {
  return (
    <ActionForm action={requestExceptionAction} resetOnSuccess>
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="type" value={type} />
      <p className="small muted" style={{ margin: 0 }}>Decided by: {authority}. Upload the supporting evidence first (as exception evidence).</p>
      <div className="field">
        <label htmlFor={`ex-${type}`}>Reason for the {type} exception</label>
        <textarea id={`ex-${type}`} name="reason" rows={3} required minLength={10} />
      </div>
      <fieldset className="subfield">
        <legend>Evidence</legend>
        {evidence.length === 0 && <p className="small muted" style={{ margin: 0 }}>No evidence uploaded yet.</p>}
        {evidence.map((e) => (
          <label key={e.id} className="check">
            <input type="checkbox" name="evidence" value={e.id} />
            {e.label}
          </label>
        ))}
      </fieldset>
      <div>
        <SubmitButton className="btn" disabled={!evidence.length}>
          Request {type} exception
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
