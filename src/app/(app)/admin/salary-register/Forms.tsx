"use client";
import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { decideImportAction, holdAction, repaymentAction, saveRecordAction, uploadRegisterAction } from "./actions";

export function UploadForm() {
  return (
    <ActionForm action={uploadRegisterAction} encType="multipart/form-data">
      <div className="field">
        <label htmlFor="reg-file">Salary register CSV</label>
        <input id="reg-file" name="file" type="file" accept=".csv,text/csv" required />
        <span className="hint">You will see a preview with every error before anything changes.</span>
      </div>
      <div>
        <SubmitButton>Upload and preview</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function DecideImport({ importId, valid }: { importId: string; valid: number }) {
  return (
    <ActionForm action={decideImportAction} className="row">
      <input type="hidden" name="importId" value={importId} />
      <SubmitButton disabled={!valid} name="decision" value="APPLY">
        Apply {valid} valid row{valid === 1 ? "" : "s"}
      </SubmitButton>
      <SubmitButton className="btn btn-ghost" name="decision" value="DISCARD">
        Discard
      </SubmitButton>
    </ActionForm>
  );
}

export interface StaffOption {
  id: string;
  label: string;
}

export function RecordForm({ staff, initial }: { staff: StaffOption[]; initial?: { staffId: string; staffNumber: string; monthlySalary: string; accountName: string; employmentStatus: string; salaryAsOf: string } }) {
  return (
    <ActionForm action={saveRecordAction} resetOnSuccess={!initial}>
      {(st) => {
        const err = (k: string) => st.fields?.[k];
        return (
          <>
            {initial ? (
              <input type="hidden" name="staffId" value={initial.staffId} />
            ) : (
              <div className="field">
                <label htmlFor="rf-staff">Employee</label>
                <select id="rf-staff" name="staffId" required defaultValue="">
                  <option value="">Choose…</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
                {err("staffId") && <span className="err">{err("staffId")}</span>}
              </div>
            )}
            <div className="grid-2">
              <div className="field">
                <label htmlFor="rf-no">Staff ID</label>
                <input id="rf-no" name="staffNumber" defaultValue={initial?.staffNumber} required aria-invalid={!!err("staffNumber")} />
                {err("staffNumber") && <span className="err">{err("staffNumber")}</span>}
              </div>
              <div className="field">
                <label htmlFor="rf-sal">Verified monthly salary (₦)</label>
                <input id="rf-sal" name="monthlySalary" inputMode="decimal" defaultValue={initial?.monthlySalary} required aria-invalid={!!err("monthlySalary")} autoComplete="off" />
                {err("monthlySalary") && <span className="err">{err("monthlySalary")}</span>}
              </div>
              <div className="field">
                <label htmlFor="rf-acc">Salary account number</label>
                <input id="rf-acc" name="accountNumber" inputMode="numeric" required aria-invalid={!!err("accountNumber")} autoComplete="off" placeholder={initial ? "Re-enter to confirm or change" : "10 digits"} />
                {err("accountNumber") && <span className="err">{err("accountNumber")}</span>}
              </div>
              <div className="field">
                <label htmlFor="rf-name">Account name</label>
                <input id="rf-name" name="accountName" defaultValue={initial?.accountName} required aria-invalid={!!err("accountName")} />
                {err("accountName") && <span className="err">{err("accountName")}</span>}
              </div>
              <div className="field">
                <label htmlFor="rf-emp">Employment status</label>
                <select id="rf-emp" name="employmentStatus" defaultValue={initial?.employmentStatus ?? "ACTIVE"}>
                  {["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED", "EXITED"].map((x) => (
                    <option key={x} value={x}>
                      {x
                        .replace("_", " ")
                        .toLowerCase()
                        .replace(/^./, (c) => c.toUpperCase())}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="rf-asof">Salary verified for (payroll date)</label>
                <input id="rf-asof" name="salaryAsOf" type="date" defaultValue={initial?.salaryAsOf} required aria-invalid={!!err("salaryAsOf")} />
                {err("salaryAsOf") && <span className="err">{err("salaryAsOf")}</span>}
              </div>
            </div>
            <div className="field">
              <label htmlFor="rf-reason">Reason and source</label>
              <input id="rf-reason" name="reason" required placeholder="e.g. November 2026 payroll" aria-invalid={!!err("reason")} />
              {err("reason") && <span className="err">{err("reason")}</span>}
            </div>
            <div>
              <SubmitButton>{initial ? "Save changes" : "Add record"}</SubmitButton>
            </div>
          </>
        );
      }}
    </ActionForm>
  );
}

export function HoldForm({ staffId, held }: { staffId: string; held: boolean }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(true)}>
        {held ? "Release hold" : "Put on hold"}
      </button>
    );
  return (
    <ActionForm action={holdAction} className="stack">
      <input type="hidden" name="staffId" value={staffId} />
      <input type="hidden" name="hold" value={held ? "0" : "1"} />
      <input name="reason" aria-label="Reason" placeholder="Reason" required />
      <div className="row">
        <SubmitButton className="btn btn-sm">{held ? "Release" : "Hold"}</SubmitButton>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}

export function RepaymentForm({ requestId, today }: { requestId: string; today: string }) {
  return (
    <ActionForm action={repaymentAction} resetOnSuccess>
      {(st) => {
        const err = (k: string) => st.fields?.[k];
        return (
          <>
            <input type="hidden" name="requestId" value={requestId} />
            <div className="grid-2">
              <div className="field">
                <label htmlFor={`ra-${requestId}`}>Amount repaid (₦)</label>
                <input id={`ra-${requestId}`} name="amount" inputMode="decimal" required aria-invalid={!!err("amount")} />
                {err("amount") && <span className="err">{err("amount")}</span>}
              </div>
              <div className="field">
                <label htmlFor={`rd-${requestId}`}>Value date</label>
                <input id={`rd-${requestId}`} name="valueDate" type="date" defaultValue={today} required />
                {err("valueDate") && <span className="err">{err("valueDate")}</span>}
              </div>
              <div className="field">
                <label htmlFor={`rr-${requestId}`}>Payroll or transaction reference</label>
                <input id={`rr-${requestId}`} name="reference" required aria-invalid={!!err("reference")} autoComplete="off" />
                {err("reference") && <span className="err">{err("reference")}</span>}
              </div>
              <div className="field">
                <label htmlFor={`rs-${requestId}`}>How it was repaid</label>
                <select id={`rs-${requestId}`} name="source" defaultValue="PAYROLL_DEDUCTION">
                  <option value="PAYROLL_DEDUCTION">Payroll deduction</option>
                  <option value="TRANSFER">Transfer by the employee</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>
            </div>
            <div>
              <SubmitButton className="btn btn-sm">Record confirmed repayment</SubmitButton>
            </div>
          </>
        );
      }}
    </ActionForm>
  );
}
