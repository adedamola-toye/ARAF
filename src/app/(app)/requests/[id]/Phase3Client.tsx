"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { attemptAction, holdAction, releaseAction, resolveAttemptAction } from "../../disbursements/actions";

export function HoldForm({ appId }: { appId: string }) {
  return (
    <ActionForm action={holdAction} resetOnSuccess>
      {(st) => (
        <>
          <input type="hidden" name="applicationId" value={appId} />
          <div className="field">
            <label htmlFor="hold-reason">Reason for the hold</label>
            <textarea id="hold-reason" name="reason" rows={2} aria-invalid={!!st.fields?.reason} />
            {st.fields?.reason && <p className="err">{st.fields.reason}</p>}
          </div>
          <div>
            <SubmitButton className="btn btn-sm">Put on hold</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function ReleaseForm({ appId }: { appId: string }) {
  return (
    <ActionForm action={releaseAction} resetOnSuccess>
      {(st) => (
        <>
          <input type="hidden" name="applicationId" value={appId} />
          <div className="field">
            <label htmlFor="release-note">How it was resolved</label>
            <input id="release-note" name="note" aria-invalid={!!st.fields?.note} />
            {st.fields?.note && <p className="err">{st.fields.note}</p>}
          </div>
          <div>
            <SubmitButton className="btn btn-sm">Release hold</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function AttemptForm({ appId }: { appId: string }) {
  return (
    <ActionForm action={attemptAction} resetOnSuccess>
      {(st) => (
        <>
          <input type="hidden" name="applicationId" value={appId} />
          <fieldset className="field">
            <legend>Outcome</legend>
            <label className="check">
              <input type="radio" name="outcome" value="FAILED" defaultChecked /> Failed: core banking rejected it
            </label>
            <label className="check">
              <input type="radio" name="outcome" value="UNCERTAIN" /> Uncertain: not known whether it posted
            </label>
          </fieldset>
          <div className="field">
            <label htmlFor="att-ref">Transaction reference, if any</label>
            <input id="att-ref" name="attemptedRef" autoComplete="off" aria-invalid={!!st.fields?.attemptedRef} />
            {st.fields?.attemptedRef && <p className="err">{st.fields.attemptedRef}</p>}
          </div>
          <div className="field">
            <label htmlFor="att-amt">Amount attempted (₦), if known</label>
            <input id="att-amt" name="amount" inputMode="decimal" aria-invalid={!!st.fields?.amount} />
            {st.fields?.amount && <p className="err">{st.fields.amount}</p>}
          </div>
          <div className="field">
            <label htmlFor="att-note">What happened</label>
            <textarea id="att-note" name="note" rows={2} aria-invalid={!!st.fields?.note} />
            {st.fields?.note && <p className="err">{st.fields.note}</p>}
          </div>
          <div>
            <SubmitButton className="btn btn-sm">Record attempt</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function ResolveAttemptForm({ attemptId }: { attemptId: string }) {
  return (
    <ActionForm action={resolveAttemptAction} resetOnSuccess>
      {(st) => (
        <>
          <input type="hidden" name="attemptId" value={attemptId} />
          <fieldset className="field">
            <legend>Verified in core banking</legend>
            <label className="check">
              <input type="radio" name="resolution" value="NOT_POSTED" defaultChecked /> It did not post
            </label>
            <label className="check">
              <input type="radio" name="resolution" value="POSTED" /> It posted
            </label>
          </fieldset>
          <div className="field">
            <label htmlFor={`pr-${attemptId}`}>Posted reference (if it posted)</label>
            <input id={`pr-${attemptId}`} name="postedRef" autoComplete="off" aria-invalid={!!st.fields?.postedRef} />
            {st.fields?.postedRef && <p className="err">{st.fields.postedRef}</p>}
          </div>
          <div className="field">
            <label htmlFor={`rn-${attemptId}`}>How you verified it</label>
            <input id={`rn-${attemptId}`} name="note" aria-invalid={!!st.fields?.note} />
            {st.fields?.note && <p className="err">{st.fields.note}</p>}
          </div>
          <div>
            <SubmitButton className="btn btn-sm">Record verification</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
