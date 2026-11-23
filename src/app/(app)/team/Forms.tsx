"use client";
import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { designateAction, editMemberAction } from "./actions";

export function EditMember({ m }: { m: { id: string; fullName: string; businessUnit: string } }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(true)}>
        Edit
      </button>
    );
  return (
    <ActionForm action={editMemberAction}>
      {(st) => (
        <>
          <input type="hidden" name="staffId" value={m.id} />
          <div className="field">
            <label htmlFor={`fn-${m.id}`}>Full name</label>
            <input id={`fn-${m.id}`} name="fullName" defaultValue={m.fullName} required aria-invalid={!!st.fields?.fullName} />
            {st.fields?.fullName && <span className="err">{st.fields.fullName}</span>}
          </div>
          <div className="field">
            <label htmlFor={`bu-${m.id}`}>Business unit</label>
            <input id={`bu-${m.id}`} name="businessUnit" defaultValue={m.businessUnit} />
          </div>
          <div className="row">
            <SubmitButton className="btn btn-sm">Save</SubmitButton>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function Designate({ staffId, designated }: { staffId: string; designated: boolean }) {
  return (
    <ActionForm action={designateAction} className="row">
      <input type="hidden" name="staffId" value={staffId} />
      <input type="hidden" name="on" value={designated ? "0" : "1"} />
      <input name="reason" aria-label="Reason" placeholder="Reason" required style={{ maxWidth: 220 }} />
      <SubmitButton className={designated ? "btn btn-sm" : "btn btn-sm btn-dark"}>{designated ? "Remove" : "Designate"}</SubmitButton>
    </ActionForm>
  );
}
