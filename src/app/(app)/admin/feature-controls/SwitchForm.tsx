"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { switchAction } from "./actions";

export function SwitchForm({ k, enabled }: { k: string; enabled: boolean }) {
  return (
    <ActionForm action={switchAction} resetOnSuccess>
      {(st) => (
        <>
          <input type="hidden" name="key" value={k} />
          <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
          <div className="field">
            <label htmlFor={`r-${k}`}>Reason for changing it</label>
            <input id={`r-${k}`} name="reason" aria-invalid={!!st.fields?.reason} placeholder="e.g. Approved by Head of Retail, memo 12/2026" />
            {st.fields?.reason && <p className="err">{st.fields.reason}</p>}
          </div>
          <div>
            <SubmitButton className={enabled ? "btn" : "btn btn-primary"}>{enabled ? "Turn OFF" : "Turn ON"}</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
