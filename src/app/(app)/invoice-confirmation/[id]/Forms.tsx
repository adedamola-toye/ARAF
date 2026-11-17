"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { completeConfirmationAction, returnConfirmationAction, uploadResponseAction } from "../actions";

export function UploadResponse({ id }: { id: string }) {
  return (
    <ActionForm action={uploadResponseAction} className="stack">
      {(st) => (
        <>
          <input type="hidden" name="confirmationId" value={id} />
          <div className="field">
            <label htmlFor="ic-file">Issuer&apos;s response (email, letter or screenshot as PDF or image)</label>
            <input id="ic-file" type="file" name="response" accept=".pdf,.png,.jpg,.jpeg,.docx" required />
            {st.fields?.response && <span className="err">{st.fields.response}</span>}
          </div>
          <div>
            <SubmitButton>Upload response</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function CompleteForm({ id, lockVersion, ready }: { id: string; lockVersion: number; ready: boolean }) {
  return (
    <ActionForm action={completeConfirmationAction} className="stack">
      <input type="hidden" name="confirmationId" value={id} />
      <input type="hidden" name="lockVersion" value={lockVersion} />
      <div className="field">
        <label htmlFor="ic-rem">Remarks (optional)</label>
        <textarea id="ic-rem" name="remarks" rows={2} placeholder="e.g. Confirmed by phone with the supplier's accounts officer." />
      </div>
      <div>
        <SubmitButton disabled={!ready}>Confirmation Completed</SubmitButton>
      </div>
      {!ready && <p className="small muted" style={{ margin: 0 }}>Upload the issuer&apos;s response first.</p>}
    </ActionForm>
  );
}

export function ReturnForm({ id, lockVersion }: { id: string; lockVersion: number }) {
  return (
    <ActionForm action={returnConfirmationAction} className="stack">
      <input type="hidden" name="confirmationId" value={id} />
      <input type="hidden" name="lockVersion" value={lockVersion} />
      <div className="field">
        <label htmlFor="ic-ret">Reason for returning</label>
        <textarea id="ic-ret" name="reason" rows={3} required minLength={20} placeholder="e.g. The supplier says invoice number and amount do not match their records." />
      </div>
      <div>
        <SubmitButton className="btn btn-danger">Return to initiator</SubmitButton>
      </div>
    </ActionForm>
  );
}
