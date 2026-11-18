"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { setOrgLinkAction } from "./actions";

export function LinkForm({ staffId, relation, current, managers }: { staffId: string; relation: string; current: string | null; managers: { id: string; name: string }[] }) {
  return (
    <ActionForm action={setOrgLinkAction} className="ic-reassign">
      {(st) => (
        <>
          <input type="hidden" name="staffId" value={staffId} />
          <input type="hidden" name="relation" value={relation} />
          <select name="managerId" defaultValue={current ?? ""} aria-label="Reports to">
            <option value="">Not set</option>
            {managers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <input name="reason" required minLength={10} placeholder="Reason" aria-label="Reason for the change" />
          <SubmitButton className="btn btn-sm">Save</SubmitButton>
          {st.fields?.reason && <span className="err">{st.fields.reason}</span>}
        </>
      )}
    </ActionForm>
  );
}
