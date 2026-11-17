"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { reassignAction, saveOfficersAction } from "./actions";

export function OfficersForm({ emails }: { emails: string }) {
  return (
    <ActionForm action={saveOfficersAction} className="stack">
      {(st) => (
        <>
          <div className="field">
            <label htmlFor="ic-emails">Officer emails (first is primary, then backups; one per line)</label>
            <textarea id="ic-emails" name="emails" rows={3} defaultValue={emails} required />
            {st.fields?.emails && <span className="err">{st.fields.emails}</span>}
          </div>
          <div className="field">
            <label htmlFor="ic-reason">Reason for the change</label>
            <textarea id="ic-reason" name="reason" rows={2} required minLength={20} />
            {st.fields?.reason && <span className="err">{st.fields.reason}</span>}
          </div>
          <div>
            <SubmitButton>Save officers</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function ReassignForm({ id, officers }: { id: string; officers: { id: string; name: string }[] }) {
  return (
    <ActionForm action={reassignAction} className="ic-reassign">
      <input type="hidden" name="confirmationId" value={id} />
      <select name="officerId" required aria-label="Officer" defaultValue="">
        <option value="" disabled>
          Choose officer…
        </option>
        {officers.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <input name="reason" required minLength={20} placeholder="Reason (20+ characters)" aria-label="Reason" />
      <SubmitButton className="btn btn-sm">Reassign</SubmitButton>
    </ActionForm>
  );
}
