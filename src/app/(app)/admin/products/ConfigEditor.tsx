"use client";
import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { AmountInput, amountToKobo } from "@/components/inputs";
import { decideConfigAction, proposeConfigAction, productActiveAction } from "../retail-admin-actions";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Cfg = any;

const CONVENTIONS: [string, string][] = [["", "Not configured"], ["FLAT_PER_ANNUM", "Flat per annum"], ["FLAT_FOR_TENOR", "Flat once for the tenor"], ["FLAT_PER_MONTH", "Flat per month"]];
const INSURANCE: [string, string][] = [["", "Not configured"], ["CUSTOMER", "Customer bears the cost"], ["BANK", "Bank bears the cost"], ["NOT_APPLICABLE", "Not applicable"]];
const DENOMS: [string, string][] = [["", "Not configured"], ["VERIFIED_MONTHLY_NET_SALARY", "Verified monthly net salary"], ["VERIFIED_MONTHLY_GROSS_SALARY", "Verified monthly gross salary"], ["AVERAGE_MONTHLY_BUSINESS_TURNOVER", "Average monthly business turnover"], ["AVERAGE_MONTHLY_NET_CASH_INFLOW", "Average monthly net cash inflow"], ["AVERAGE_MONTHLY_NET_PROFIT", "Average monthly net profit"]];
const TRI: [string, string][] = [["", "Not configured"], ["true", "Yes"], ["false", "No"]];
const k2n = (k: number | null) => (k === null || k === undefined ? "" : String(k / 100));

function Sel({ id, label, value, options, onChange }: { id: string; label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={value === "" ? "unset" : ""}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}
function Txt({ id, label, value, onChange, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} className={value === "" ? "unset" : ""} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function ConfigEditor({ productCode, initial, roles, canPropose }: { productCode: string; initial: Cfg; roles: [string, string][]; canPropose: boolean }) {
  const [cfg, setCfg] = useState<Cfg>(initial);
  const [advanced, setAdvanced] = useState(false);
  const [raw, setRaw] = useState(JSON.stringify(initial, null, 2));
  const upd = (fn: (c: Cfg) => void) => {
    const c = JSON.parse(JSON.stringify(cfg));
    fn(c);
    setCfg(c);
    setRaw(JSON.stringify(c, null, 2));
  };
  const roleOpts: [string, string][] = [["", "Not configured"], ...roles];
  const nOrNull = (v: string) => (v === "" ? null : Number.parseInt(v, 10));
  return (
    <ActionForm action={proposeConfigAction}>
      <input type="hidden" name="productCode" value={productCode} />
      <input type="hidden" name="config" value={advanced ? raw : JSON.stringify(cfg)} />
      <p className="small muted" style={{ margin: 0 }}>Fields shown as “Not configured” block the actions listed above. Nothing is filled in automatically. A different person holding the configuration approver role must approve the change.</p>
      <div className="grid-3">
        <Sel id={`${productCode}-hou`} label="Head of Unit stage" value={cfg.businessReview.headOfUnitStage ?? ""} options={[["", "Not configured"], ["DISTINCT", "Distinct stage after Head of Retail Sales"], ["NOT_REQUIRED", "Not required"]]} onChange={(v) => upd((c) => (c.businessReview.headOfUnitStage = v || null))} />
        <Sel id={`${productCode}-rr`} label="Restructuring approval role" value={cfg.servicing.restructureApproverRole ?? ""} options={roleOpts} onChange={(v) => upd((c) => (c.servicing.restructureApproverRole = v || null))} />
        <Txt id={`${productCode}-exp`} label="Draft expiry (days, blank = never)" value={cfg.draftExpiryDays ?? ""} onChange={(v) => upd((c) => (c.draftExpiryDays = nOrNull(v)))} />
      </div>
      {Object.entries(cfg.profiles).map(([p, r]: [string, any]) => (
        <fieldset key={p} className="subfield">
          <legend>{p === "SALARY_EARNER" ? "Salary earners" : "Business owners"} {r.enabled ? "" : "(disabled)"}</legend>
          <div className="grid-3">
            <div className="field">
              <label htmlFor={`${productCode}-${p}-max`}>Maximum financing</label>
              <AmountInput id={`${productCode}-${p}-max`} value={k2n(r.maxAmountKobo)} onChange={(v) => upd((c) => (c.profiles[p].maxAmountKobo = v ? amountToKobo(v) : null))} />
            </div>
            <Txt id={`${productCode}-${p}-ten`} label="Maximum tenor (months)" value={r.maxTenorMonths ?? ""} onChange={(v) => upd((c) => (c.profiles[p].maxTenorMonths = nOrNull(v)))} />
            <Txt id={`${productCode}-${p}-dsr`} label="Maximum DSR (%)" value={r.dsr.maxPercent ?? ""} onChange={(v) => upd((c) => (c.profiles[p].dsr.maxPercent = v || null))} />
            <Sel id={`${productCode}-${p}-den`} label="DSR denominator" value={r.dsr.denominator ?? ""} options={DENOMS} onChange={(v) => upd((c) => (c.profiles[p].dsr.denominator = v || null))} />
            <Sel id={`${productCode}-${p}-dex`} label="DSR exceptions permitted" value={String(r.dsr.exceptionAllowed)} options={[["false", "No"], ["true", "Yes"]]} onChange={(v) => upd((c) => (c.profiles[p].dsr.exceptionAllowed = v === "true"))} />
            <Sel id={`${productCode}-${p}-der`} label="DSR exception authority" value={r.dsr.exceptionApproverRole ?? ""} options={roleOpts} onChange={(v) => upd((c) => (c.profiles[p].dsr.exceptionApproverRole = v || null))} />
            <Txt id={`${productCode}-${p}-stm`} label="Bank statement period (months)" value={r.statementMonths ?? ""} onChange={(v) => upd((c) => (c.profiles[p].statementMonths = nOrNull(v)))} />
            {p === "SALARY_EARNER" && <Txt id={`${productCode}-${p}-psm`} label="Payslip / salary history (months)" value={r.payslipMonths ?? ""} onChange={(v) => upd((c) => (c.profiles[p].payslipMonths = nOrNull(v)))} />}
            <Txt id={`${productCode}-${p}-age`} label="Statement recency (days, blank = not checked)" value={r.statementMaxAgeDays ?? ""} onChange={(v) => upd((c) => (c.profiles[p].statementMaxAgeDays = nOrNull(v)))} />
            <Sel id={`${productCode}-${p}-vis`} label="Management visit required" value={r.visitRequired === null ? "" : String(r.visitRequired)} options={TRI} onChange={(v) => upd((c) => (c.profiles[p].visitRequired = v === "" ? null : v === "true"))} />
            <Sel id={`${productCode}-${p}-eq`} label="Equity contribution applies" value={r.equityContribution.applies === null ? "" : String(r.equityContribution.applies)} options={TRI} onChange={(v) => upd((c) => (c.profiles[p].equityContribution.applies = v === "" ? null : v === "true"))} />
            {r.equityContribution.applies && <Txt id={`${productCode}-${p}-eqm`} label="Minimum equity (%)" value={r.equityContribution.minPercent ?? ""} onChange={(v) => upd((c) => (c.profiles[p].equityContribution.minPercent = v || null))} />}
            <Sel id={`${productCode}-${p}-cap`} label="Principal-to-turnover cap (separate from DSR)" value={String(r.principalTurnoverCap.applies)} options={[["false", "Does not apply"], ["true", "Applies"]]} onChange={(v) => upd((c) => (c.profiles[p].principalTurnoverCap.applies = v === "true"))} />
            {r.principalTurnoverCap.applies && <Txt id={`${productCode}-${p}-capm`} label="Cap (% of turnover)" value={r.principalTurnoverCap.maxPercent ?? ""} onChange={(v) => upd((c) => (c.profiles[p].principalTurnoverCap.maxPercent = v || null))} />}
            {r.afs && (
              <>
                <div className="field">
                  <label htmlFor={`${productCode}-${p}-afs`}>AFS required above</label>
                  <AmountInput id={`${productCode}-${p}-afs`} value={k2n(r.afs.thresholdKobo)} onChange={(v) => upd((c) => (c.profiles[p].afs.thresholdKobo = v ? amountToKobo(v) : null))} />
                </div>
                <Sel id={`${productCode}-${p}-afr`} label="AFS exception authority" value={r.afs.exceptionApproverRole ?? ""} options={roleOpts} onChange={(v) => upd((c) => (c.profiles[p].afs.exceptionApproverRole = v || null))} />
              </>
            )}
          </div>
          {r.assetEligibility.required && (
            <div className="field">
              <label htmlFor={`${productCode}-${p}-ae`}>Asset eligibility criteria</label>
              <textarea id={`${productCode}-${p}-ae`} rows={2} value={r.assetEligibility.criteria ?? ""} className={r.assetEligibility.criteria ? "" : "unset"} onChange={(e) => upd((c) => (c.profiles[p].assetEligibility.criteria = e.target.value || null))} />
            </div>
          )}
          {r.structures.map((st: any, i: number) => (
            <div key={st.code} className="grid-4" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
              <Txt id={`${productCode}-${p}-${st.code}-r`} label={`${st.code} rate (%)`} value={st.ratePercent ?? ""} onChange={(v) => upd((c) => (c.profiles[p].structures[i].ratePercent = v || null))} />
              <Sel id={`${productCode}-${p}-${st.code}-c`} label="Rate convention" value={st.rateConvention ?? ""} options={CONVENTIONS} onChange={(v) => upd((c) => (c.profiles[p].structures[i].rateConvention = v || null))} />
              <Sel id={`${productCode}-${p}-${st.code}-i`} label="Insurance" value={st.insuranceBearer ?? ""} options={INSURANCE} onChange={(v) => upd((c) => (c.profiles[p].structures[i].insuranceBearer = v || null))} />
              <Txt id={`${productCode}-${p}-${st.code}-s`} label="Contract sequence (steps separated by ;)" value={st.contractSequence === null ? "" : st.contractSequence.join("; ") || "(none)"} hint="Enter (none) when no structure-specific steps apply." onChange={(v) => upd((c) => (c.profiles[p].structures[i].contractSequence = v === "" ? null : v.trim() === "(none)" ? [] : v.split(";").map((x: string) => x.trim()).filter(Boolean)))} />
            </div>
          ))}
          {r.structures.length === 0 && <p className="small blocked">No financing structure is configured; use the advanced editor to add one.</p>}
        </fieldset>
      ))}
      <label className="check">
        <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
        Advanced: edit the full configuration (document matrix, structures, consents) as JSON
      </label>
      {advanced && <textarea aria-label="Configuration JSON" className="mono" rows={18} value={raw} onChange={(e) => setRaw(e.target.value)} />}
      <div className="grid-2">
        <div className="field">
          <label htmlFor={`${productCode}-eff`}>Effective from (Lagos date)</label>
          <input id={`${productCode}-eff`} name="effectiveFrom" type="date" required />
        </div>
        <div className="field">
          <label htmlFor={`${productCode}-reason`}>Reason and source of the change</label>
          <input id={`${productCode}-reason`} name="reason" required placeholder="e.g. Credit committee memo CC/2026/14" />
        </div>
      </div>
      <div>
        <SubmitButton disabled={!canPropose}>Propose new version</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function DecideConfig({ configId, mine, canApprove }: { configId: string; mine: boolean; canApprove: boolean }) {
  return (
    <ActionForm action={decideConfigAction}>
      <input type="hidden" name="configId" value={configId} />
      <div className="field">
        <label htmlFor={`dc-${configId}`}>Decision note</label>
        <input id={`dc-${configId}`} name="note" />
      </div>
      <div className="row">
        {canApprove && !mine && <SubmitButton className="btn btn-primary" name="decision" value="APPROVE">Approve</SubmitButton>}
        {(canApprove && !mine) && <SubmitButton className="btn btn-danger" name="decision" value="REJECT">Reject</SubmitButton>}
        {mine && <SubmitButton className="btn" name="decision" value="REJECT">Withdraw my proposal</SubmitButton>}
      </div>
      {!canApprove && !mine && <p className="small muted">Awaiting a product configuration approver.</p>}
    </ActionForm>
  );
}

export function ProductToggle({ code, active }: { code: string; active: boolean }) {
  return (
    <ActionForm action={productActiveAction} className="row">
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="active" value={String(!active)} />
      <SubmitButton className="btn btn-sm">{active ? "Close to new applications" : "Open to new applications"}</SubmitButton>
    </ActionForm>
  );
}
