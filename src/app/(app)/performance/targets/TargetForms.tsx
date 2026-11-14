"use client";
import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { AmountInput, SearchSelect } from "@/components/inputs";
import { decideTargetAction, proposeTargetAction } from "../actions";

export function ProposeTargetForm({ month, people, teams }: { month: string; people: { id: string; label: string }[]; teams: string[] }) {
  const [scope, setScope] = useState<"STAFF" | "TEAM">("STAFF");
  const [metric, setMetric] = useState<"DISBURSED_VALUE" | "DISBURSED_COUNT">("DISBURSED_VALUE");
  const [staffId, setStaffId] = useState("");
  const [amount, setAmount] = useState("");
  return (
    <ActionForm action={proposeTargetAction} resetOnSuccess>
      {(state) => {
        const fe = state.fields ?? {};
        return (
          <>
            <div className="grid-4">
              <div className="field">
                <label htmlFor="t-scope">For</label>
                <select id="t-scope" name="scopeType" value={scope} onChange={(e) => setScope(e.target.value as "STAFF" | "TEAM")}>
                  <option value="STAFF">A person</option>
                  <option value="TEAM">A team</option>
                </select>
              </div>
              {scope === "STAFF" ? (
                <div className="field">
                  <label htmlFor="t-staff">Relationship Manager or Team Lead</label>
                  <input type="hidden" name="staffId" value={staffId} />
                  <SearchSelect id="t-staff" value={staffId} onChange={setStaffId} options={people.map((p) => ({ value: p.id, label: p.label }))} placeholder="Search people" invalid={!!fe.staffId} />
                  {fe.staffId && <p className="err">{fe.staffId}</p>}
                </div>
              ) : (
                <div className="field">
                  <label htmlFor="t-team">Team</label>
                  <select id="t-team" name="team" defaultValue="" aria-invalid={!!fe.team}>
                    <option value="">Choose…</option>
                    {teams.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  {fe.team && <p className="err">{fe.team}</p>}
                </div>
              )}
              <div className="field">
                <label htmlFor="t-metric">Measure</label>
                <select id="t-metric" name="metric" value={metric} onChange={(e) => setMetric(e.target.value as "DISBURSED_VALUE" | "DISBURSED_COUNT")}>
                  <option value="DISBURSED_VALUE">Disbursed value (₦)</option>
                  <option value="DISBURSED_COUNT">Disbursed requests (number)</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="t-month">Month</label>
                <input id="t-month" type="month" name="month" min={month} defaultValue={month} aria-invalid={!!fe.month} />
                {fe.month && <p className="err">{fe.month}</p>}
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="t-value">{metric === "DISBURSED_VALUE" ? "Target amount (₦)" : "Number of disbursed requests"}</label>
                {metric === "DISBURSED_VALUE" ? (
                  <>
                    <input type="hidden" name="value" value={amount} />
                    <AmountInput id="t-value" value={amount} onChange={setAmount} invalid={!!fe.value} />
                  </>
                ) : (
                  <input id="t-value" name="value" inputMode="numeric" aria-invalid={!!fe.value} />
                )}
                {fe.value && <p className="err">{fe.value}</p>}
              </div>
              <div className="field">
                <label htmlFor="t-reason">Reason or source</label>
                <input id="t-reason" name="reason" placeholder="e.g. FY budget allocation, March" aria-invalid={!!fe.reason} />
                {fe.reason && <p className="err">{fe.reason}</p>}
              </div>
            </div>
            <div>
              <SubmitButton>Propose target</SubmitButton>
            </div>
          </>
        );
      }}
    </ActionForm>
  );
}

export function DecideTargetForm({ id, canDecide, canWithdraw }: { id: string; canDecide: boolean; canWithdraw: boolean }) {
  return (
    <ActionForm action={decideTargetAction} className="stack">
      <input type="hidden" name="id" value={id} />
      {canDecide && <input name="note" placeholder="Note (required to reject)" aria-label="Decision note" />}
      <div className="row">
        {canDecide && (
          <>
            <SubmitButton name="decision" value="APPROVE" className="btn btn-primary btn-sm">
              Approve
            </SubmitButton>
            <SubmitButton name="decision" value="REJECT" className="btn btn-danger btn-sm">
              Reject
            </SubmitButton>
          </>
        )}
        {canWithdraw && (
          <SubmitButton name="decision" value="WITHDRAW" className="btn btn-sm">
            Withdraw
          </SubmitButton>
        )}
      </div>
    </ActionForm>
  );
}
