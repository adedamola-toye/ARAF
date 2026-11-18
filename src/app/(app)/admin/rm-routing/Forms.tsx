"use client";
import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { classifyRmAction, provisionRbeAction, routingAssignmentAction } from "./actions";

type Opt = { id: string; name: string };

export function ClassifyForm({ staffId, segment, dbcRegion, rbeId, businessUnit, rbes }: { staffId: string; segment: string | null; dbcRegion: string | null; rbeId: string | null; businessUnit: string | null; rbes: Opt[] }) {
  const [seg, setSeg] = useState(segment ?? "");
  return (
    <ActionForm action={classifyRmAction} className="ic-reassign">
      {(st) => (
        <>
          <input type="hidden" name="staffId" value={staffId} />
          <select name="segment" value={seg} onChange={(e) => setSeg(e.target.value)} aria-label="Does this Relationship Manager belong to DBC?" required>
            <option value="" disabled>
              Belongs to DBC?
            </option>
            <option value="DBC">Yes — DBC</option>
            <option value="NON_DBC">No — Non-DBC</option>
          </select>
          {seg === "DBC" && (
            <select name="dbcRegion" defaultValue={dbcRegion ?? ""} aria-label="DBC region" required>
              <option value="" disabled>
                DBC region
              </option>
              <option value="SOUTH_WEST">South &amp; West</option>
              <option value="NORTH">North</option>
            </select>
          )}
          {seg === "NON_DBC" && (
            <select name="rbeId" defaultValue={rbeId ?? ""} aria-label="Regional Business Executive" required>
              <option value="" disabled>
                Who is this RM&apos;s RBE?
              </option>
              {rbes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          <input name="businessUnit" defaultValue={businessUnit ?? ""} placeholder="Business unit" aria-label="Business unit" maxLength={80} />
          <input name="reason" required minLength={10} placeholder="Reason" aria-label="Reason for the change" />
          <SubmitButton className="btn btn-sm">Save</SubmitButton>
          {Object.values(st.fields ?? {}).map((m) => (
            <span key={m} className="err">
              {m}
            </span>
          ))}
        </>
      )}
    </ActionForm>
  );
}

export function AssignmentForm({ routingKey, current, unitHeads }: { routingKey: string; current: string | null; unitHeads: Opt[] }) {
  return (
    <ActionForm action={routingAssignmentAction} className="ic-reassign">
      {() => (
        <>
          <input type="hidden" name="key" value={routingKey} />
          <select name="staffId" defaultValue={current ?? ""} aria-label="Approver">
            <option value="">Not set</option>
            {unitHeads.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <input name="reason" required minLength={10} placeholder="Reason" aria-label="Reason for the change" />
          <SubmitButton className="btn btn-sm">Save</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function ProvisionRbeForm() {
  return (
    <ActionForm action={provisionRbeAction} className="grid-2">
      {(st) => (
        <>
          <div className="field">
            <label htmlFor="rbe-email">Work email</label>
            <input id="rbe-email" name="email" type="email" required autoComplete="off" />
            {st.fields?.email && <span className="err">{st.fields.email}</span>}
          </div>
          <div className="field">
            <label htmlFor="rbe-name">Full name</label>
            <input id="rbe-name" name="fullName" required minLength={3} />
            {st.fields?.fullName && <span className="err">{st.fields.fullName}</span>}
          </div>
          <div className="field">
            <label htmlFor="rbe-bu">Business unit</label>
            <input id="rbe-bu" name="businessUnit" maxLength={80} />
          </div>
          <div className="field" style={{ alignSelf: "end" }}>
            <SubmitButton className="btn">Provision RBE</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
