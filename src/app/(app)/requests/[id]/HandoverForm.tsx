"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { updateHandoverAction } from "./closing-actions";

export function HandoverForm({ applicationId, group, status }: { applicationId: string; group: string; status: string }) {
  return (
    <ActionForm action={updateHandoverAction} className="stack">
      {(st) => (
        <>
          <input type="hidden" name="applicationId" value={applicationId} />
          <input type="hidden" name="group" value={group} />
          {status === "SENT" && (
            <div>
              <SubmitButton className="btn btn-sm" name="to" value="RECEIVED">
                Mark received
              </SubmitButton>
            </div>
          )}
          <div className="field">
            <label htmlFor={`ho-${group}`}>Review comments</label>
            <textarea id={`ho-${group}`} name="comments" rows={2} />
            {st.fields?.comments && <span className="err">{st.fields.comments}</span>}
          </div>
          <div>
            <SubmitButton className="btn btn-sm btn-primary" name="to" value="REVIEWED">
              Mark reviewed
            </SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
