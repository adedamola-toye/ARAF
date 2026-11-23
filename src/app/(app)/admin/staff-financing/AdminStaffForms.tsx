"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { staffSettingsAction, staffTemplateAction } from "../../staff-request/actions";

export function StaffSettingsForm({ current, categories, unitHeads }: { current: { deductionPercent: string; minAmount: string; maxAmount: string; tenorOptions: string; requiredDocuments: string[]; unitHeadId: string; eligibilityMode: string; eligibilityPercent: string; salaryRecordMaxAgeDays: string }; categories: { code: string; label: string }[]; unitHeads: { id: string; label: string }[] }) {
  return (
    <ActionForm action={staffSettingsAction} className="stack" >
      {(state) => {
        const err = (k: string) => state.fields?.[k];
        return (
          <>
            <div className="field">
              <label htmlFor="sf-uh">Unit Head for the staff route</label>
              <select id="sf-uh" name="unitHeadId" defaultValue={current.unitHeadId} aria-invalid={!!err("unitHeadId")}>
                <option value="">Not configured (forwarding is blocked)</option>
                {unitHeads.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
              <span className={err("unitHeadId") ? "err" : "hint"}>{err("unitHeadId") ?? "Every request the Product Manager forwards goes to this person, who must hold the Unit Head role."}</span>
            </div>
            <fieldset className="field">
              <legend>How eligibility is established</legend>
              <label className="check">
                <input type="radio" name="eligibilityMode" value="MANUAL" defaultChecked={current.eligibilityMode !== "SALARY_REGISTER"} /> Manual: the applicant enters their account and the Product Manager verifies salary (SeedFi check applies)
              </label>
              <label className="check">
                <input type="radio" name="eligibilityMode" value="SALARY_REGISTER" defaultChecked={current.eligibilityMode === "SALARY_REGISTER"} /> Automatic from the salary register (no SeedFi check for this product; approvals unchanged)
              </label>
            </fieldset>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="sf-ep">Eligibility (% of verified monthly salary)</label>
                <input id="sf-ep" name="eligibilityPercent" defaultValue={current.eligibilityPercent} inputMode="decimal" aria-invalid={!!err("eligibilityPercent")} />
                {err("eligibilityPercent") && <span className="err">{err("eligibilityPercent")}</span>}
              </div>
              <div className="field">
                <label htmlFor="sf-age">Salary record valid for (days)</label>
                <input id="sf-age" name="salaryRecordMaxAgeDays" defaultValue={current.salaryRecordMaxAgeDays} inputMode="numeric" aria-invalid={!!err("salaryRecordMaxAgeDays")} />
                <span className={err("salaryRecordMaxAgeDays") ? "err" : "hint"}>{err("salaryRecordMaxAgeDays") ?? "Older records are treated as outdated until refreshed."}</span>
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="sf-d">Deduction (% of gross)</label>
                <input id="sf-d" name="deductionPercent" defaultValue={current.deductionPercent} inputMode="decimal" aria-invalid={!!err("deductionPercent")} />
                {err("deductionPercent") && <span className="err">{err("deductionPercent")}</span>}
              </div>
              <div className="field">
                <label htmlFor="sf-t">Tenor options (months)</label>
                <input id="sf-t" name="tenorOptions" defaultValue={current.tenorOptions} placeholder="Leave blank to not collect a tenor" aria-invalid={!!err("tenorOptions")} />
                {err("tenorOptions") && <span className="err">{err("tenorOptions")}</span>}
              </div>
              <div className="field">
                <label htmlFor="sf-min">Minimum amount (₦)</label>
                <input id="sf-min" name="minAmount" defaultValue={current.minAmount} inputMode="decimal" />
                {err("minAmount") && <span className="err">{err("minAmount")}</span>}
              </div>
              <div className="field">
                <label htmlFor="sf-max">Maximum amount (₦)</label>
                <input id="sf-max" name="maxAmount" defaultValue={current.maxAmount} inputMode="decimal" />
                {err("maxAmount") && <span className="err">{err("maxAmount")}</span>}
              </div>
            </div>
            <fieldset className="subfield">
              <legend>Documents required at submission</legend>
              {categories.map((c) => (
                <label key={c.code} className="check">
                  <input type="checkbox" name="requiredDocuments" value={c.code} defaultChecked={current.requiredDocuments.includes(c.code)} />
                  <span>{c.label}</span>
                </label>
              ))}
            </fieldset>
            <div className="field">
              <label htmlFor="sf-r">Reason and source of the change</label>
              <textarea id="sf-r" name="reason" rows={2} aria-invalid={!!err("reason")} />
              {err("reason") && <span className="err">{err("reason")}</span>}
            </div>
            <div className="action-bar">
              <SubmitButton>Save new version</SubmitButton>
            </div>
          </>
        );
      }}
    </ActionForm>
  );
}

export function StaffTemplateForm({ initial }: { initial: string }) {
  return (
    <ActionForm action={staffTemplateAction} className="stack">
      <div className="field">
        <label htmlFor="st-b">Offer letter wording (HTML with placeholders)</label>
        <textarea id="st-b" name="bodyHtml" rows={12} defaultValue={initial} style={{ fontFamily: "var(--mono)", fontSize: 12.5 }} />
      </div>
      <div className="field">
        <label htmlFor="st-n">Notes (source and approval reference)</label>
        <input id="st-n" name="notes" />
      </div>
      <div className="action-bar">
        <SubmitButton>Save as a new draft version</SubmitButton>
      </div>
    </ActionForm>
  );
}
