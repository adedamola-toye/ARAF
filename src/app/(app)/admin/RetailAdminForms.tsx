"use client";
import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { DigitsInput, SearchSelect, type SearchOption } from "@/components/inputs";
import { accountStatusAction, importInstitutionsAction, registerVendorAction, saveInstitutionAction, saveLocationAction, serviceTargetAction, vendorStatusAction, verifyAccountAction } from "./retail-admin-actions";

export interface LocationFormValue { id?: string; state: string; city: string; outletType: string; name: string; address: string; ossStaffId: string; team: string; active: boolean }

export function LocationForm({ value, states, supervisors, label }: { value: LocationFormValue; states: string[]; supervisors: { id: string; label: string }[]; label: string }) {
  return (
    <ActionForm action={saveLocationAction} resetOnSuccess={!value.id}>
      {value.id && <input type="hidden" name="id" value={value.id} />}
      <div className="grid-4">
        <div className="field"><label htmlFor={`st-${value.id ?? "new"}`}>State</label><select id={`st-${value.id ?? "new"}`} name="state" defaultValue={value.state} required><option value="">Choose…</option>{states.map((s) => <option key={s}>{s}</option>)}</select></div>
        <div className="field"><label htmlFor={`ci-${value.id ?? "new"}`}>Town or city</label><input id={`ci-${value.id ?? "new"}`} name="city" defaultValue={value.city} required /></div>
        <div className="field"><label htmlFor={`ty-${value.id ?? "new"}`}>Outlet type</label><select id={`ty-${value.id ?? "new"}`} name="outletType" defaultValue={value.outletType}><option value="BRANCH">Branch</option><option value="ALTBOX">Altbox</option><option value="ALTSHOP">Altshop</option></select></div>
        <div className="field"><label htmlFor={`nm-${value.id ?? "new"}`}>Outlet name</label><input id={`nm-${value.id ?? "new"}`} name="name" defaultValue={value.name} required /></div>
        <div className="field"><label htmlFor={`ad-${value.id ?? "new"}`}>Address</label><input id={`ad-${value.id ?? "new"}`} name="address" defaultValue={value.address} /></div>
        <div className="field"><label htmlFor={`os-${value.id ?? "new"}`}>Outlet Service Supervisor</label><select id={`os-${value.id ?? "new"}`} name="ossStaffId" defaultValue={value.ossStaffId}><option value="">None (requests go to the exception queue)</option>{supervisors.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></div>
        <div className="field"><label htmlFor={`tm-${value.id ?? "new"}`}>Team</label><input id={`tm-${value.id ?? "new"}`} name="team" defaultValue={value.team} placeholder="e.g. RETAIL-LAGOS-1" /></div>
        <label className="check" style={{ alignSelf: "end" }}><input type="checkbox" name="active" defaultChecked={value.active} /> Active</label>
      </div>
      <div><SubmitButton className="btn btn-sm btn-dark">{label}</SubmitButton></div>
    </ActionForm>
  );
}

export function InstitutionForm() {
  return (
    <ActionForm action={saveInstitutionAction} resetOnSuccess>
      <div className="grid-4">
        <div className="field"><label htmlFor="fi-code">Institution code</label><input id="fi-code" name="code" required /></div>
        <div className="field"><label htmlFor="fi-name">Name</label><input id="fi-name" name="name" required /></div>
        <div className="field"><label htmlFor="fi-cat">Category</label><select id="fi-cat" name="category"><option value="COMMERCIAL">Commercial bank</option><option value="MERCHANT">Merchant bank</option><option value="NON_INTEREST">Non-interest bank</option><option value="MICROFINANCE">Microfinance bank</option><option value="OTHER">Other</option></select></div>
        <div className="field"><label htmlFor="fi-reg">Regulatory status</label><select id="fi-reg" name="regulatoryStatus"><option value="UNCONFIRMED">Unconfirmed</option><option value="CONFIRMED_ACTIVE">Confirmed active (CBN)</option><option value="REVOKED">Licence revoked</option></select></div>
        <div className="field"><label htmlFor="fi-al">Aliases (separate with ;)</label><input id="fi-al" name="aliases" /></div>
        <div className="field"><label htmlFor="fi-rt">Routing codes (PROVIDER=CODE;…)</label><input id="fi-rt" name="routing" placeholder="NIP=000000" /></div>
        <div className="field"><label htmlFor="fi-src">Source reference</label><input id="fi-src" name="sourceReference" placeholder="CBN list dated …" /></div>
        <div className="stack" style={{ alignSelf: "end" }}>
          <label className="check"><input type="checkbox" name="paymentSupported" /> Supported by payment provider</label>
          <label className="check"><input type="checkbox" name="active" defaultChecked /> Active</label>
        </div>
      </div>
      <div><SubmitButton className="btn btn-sm btn-dark">Save institution</SubmitButton></div>
    </ActionForm>
  );
}

export function InstitutionImport() {
  return (
    <ActionForm action={importInstitutionsAction} encType="multipart/form-data">
      <div className="grid-2">
        <div className="field"><label htmlFor="fi-file">CSV file</label><input id="fi-file" name="file" type="file" accept=".csv" required /><span className="hint">Columns: code, name, category, regulatory_status, payment_supported, active, aliases (;), routing_codes (NIP=…;…), source_reference. Add-and-update; nothing is deleted.</span></div>
        <div className="field"><label htmlFor="fi-srcname">Source</label><input id="fi-srcname" name="source" placeholder="e.g. CBN-2026-10 + provider list" required /></div>
      </div>
      <div><SubmitButton className="btn btn-sm">Import</SubmitButton></div>
    </ActionForm>
  );
}

export function VendorRegisterForm({ institutions }: { institutions: SearchOption[] }) {
  const [inst, setInst] = useState("");
  const [acct, setAcct] = useState("");
  return (
    <ActionForm action={registerVendorAction} resetOnSuccess>
      <input type="hidden" name="institutionId" value={inst} />
      <input type="hidden" name="accountNumber" value={acct} />
      <div className="grid-3">
        <div className="field"><label htmlFor="vr-name">Vendor name</label><input id="vr-name" name="name" required /></div>
        <div className="field"><label htmlFor="vr-email">Vendor email</label><input id="vr-email" name="email" type="email" required /></div>
        <div className="field"><label htmlFor="vr-phone">Phone (11 digits, optional)</label><input id="vr-phone" name="phone" type="tel" inputMode="tel" maxLength={11} /></div>
        <div className="field"><label htmlFor="vr-rc">CAC number</label><input id="vr-rc" name="registrationNumber" /></div>
        <div className="field"><label htmlFor="vr-addr">Address</label><input id="vr-addr" name="address" /></div>
      </div>
      <div className="grid-3">
        <div className="field"><label htmlFor="vr-bank">Bank or MFB</label><SearchSelect id="vr-bank" value={inst} onChange={setInst} options={institutions} placeholder="Search by name or alias" /></div>
        <div className="field"><label htmlFor="vr-acct">Account number</label><DigitsInput id="vr-acct" kind="bvn" length={10} fieldLabel="Account number" value={acct} onChange={setAcct} /></div>
        <div className="field"><label htmlFor="vr-an">Account name</label><input id="vr-an" name="accountName" required /></div>
      </div>
      <div><SubmitButton className="btn btn-dark">Register vendor</SubmitButton></div>
    </ActionForm>
  );
}

export function VerifyAccountForm({ accountId }: { accountId: string }) {
  return (
    <ActionForm action={verifyAccountAction}>
      <input type="hidden" name="accountId" value={accountId} />
      <div className="grid-2">
        <div className="field"><label htmlFor={`va-n-${accountId}`}>Verification evidence</label><input id={`va-n-${accountId}`} name="note" required placeholder="e.g. bank confirmation letter ref, call-back record" /></div>
        <div className="field"><label htmlFor={`va-r-${accountId}`}>Account name confirmed as</label><input id={`va-r-${accountId}`} name="resolvedAccountName" /></div>
      </div>
      <div className="row">
        <SubmitButton className="btn btn-sm btn-primary" name="outcome" value="VERIFIED">Mark verified</SubmitButton>
        <SubmitButton className="btn btn-sm btn-danger" name="outcome" value="FAILED">Verification failed</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function StatusToggle({ kind, id, active }: { kind: "vendor" | "account"; id: string; active: boolean }) {
  return (
    <ActionForm action={kind === "vendor" ? vendorStatusAction : accountStatusAction} className="row">
      <input type="hidden" name={kind === "vendor" ? "vendorId" : "accountId"} value={id} />
      <input type="hidden" name="status" value={active ? "INACTIVE" : "ACTIVE"} />
      <input name="reason" aria-label="Reason" placeholder="Reason" required />
      <SubmitButton className="btn btn-sm">{active ? "Deactivate" : "Activate"}</SubmitButton>
    </ActionForm>
  );
}

export function ServiceTargetForm({ stage, hours, recipients, staff }: { stage: string; hours: number | null; recipients: string[]; staff: { id: string; label: string }[] }) {
  return (
    <ActionForm action={serviceTargetAction} className="row">
      <input type="hidden" name="stage" value={stage} />
      <input name="targetHours" type="number" min={1} max={2160} defaultValue={hours ?? ""} aria-label="Target hours" placeholder="hours" style={{ width: 90 }} />
      <select name="recipients" multiple defaultValue={recipients} aria-label="Escalation recipients" size={3} style={{ minWidth: 220 }}>
        {staff.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <SubmitButton className="btn btn-sm">Save</SubmitButton>
    </ActionForm>
  );
}
