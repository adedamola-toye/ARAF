"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { savePericulumAction, testPericulumAction } from "./actions";

export function CredentialsForm({ v }: { v: { clientId: string; baseUrl: string; authUrl: string; hasSecret: boolean } }) {
  return (
    <ActionForm action={savePericulumAction} resetOnSuccess={false}>
      {(st) => (
        <>
          <div className="field">
            <label htmlFor="clientId">API Client ID</label>
            <input id="clientId" name="clientId" defaultValue={v.clientId} autoComplete="off" spellCheck={false} aria-invalid={!!st.fields?.clientId} />
            <p className="small muted">Insights portal → Settings → API Credentials → API CLIENT ID.</p>
            {st.fields?.clientId && <p className="err">{st.fields.clientId}</p>}
          </div>
          <div className="field">
            <label htmlFor="clientSecret">API Secret Key</label>
            <input
              id="clientSecret"
              name="clientSecret"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={v.hasSecret ? "Saved: leave blank to keep it" : "Paste the API SECRET KEY"}
              aria-invalid={!!st.fields?.clientSecret}
            />
            <p className="small muted">Use the portal&apos;s Copy button. It is stored encrypted and never shown again.</p>
            {st.fields?.clientSecret && <p className="err">{st.fields.clientSecret}</p>}
          </div>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="baseUrl">API base URL</label>
              <input id="baseUrl" name="baseUrl" defaultValue={v.baseUrl} spellCheck={false} aria-invalid={!!st.fields?.baseUrl} />
              <p className="small muted">ARAF adds /statements itself; pasting …/statements is fine.</p>
              {st.fields?.baseUrl && <p className="err">{st.fields.baseUrl}</p>}
            </div>
            <div className="field">
              <label htmlFor="authUrl">Token URL</label>
              <input id="authUrl" name="authUrl" defaultValue={v.authUrl} spellCheck={false} aria-invalid={!!st.fields?.authUrl} />
              <p className="small muted">Only change this if Periculum gives you a different one.</p>
              {st.fields?.authUrl && <p className="err">{st.fields.authUrl}</p>}
            </div>
          </div>
          <div className="field">
            <label htmlFor="reason">Reason</label>
            <input id="reason" name="reason" placeholder="e.g. Live credentials issued by Periculum" aria-invalid={!!st.fields?.reason} />
            {st.fields?.reason && <p className="err">{st.fields.reason}</p>}
          </div>
          <div>
            <SubmitButton>Save connection</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function TestSignIn({ disabled }: { disabled: boolean }) {
  return (
    <ActionForm action={testPericulumAction}>
      <p className="small muted" style={{ margin: 0 }}>
        Requests an access token only. No statement is sent and nothing is charged.
      </p>
      <div>
        <SubmitButton className="btn" disabled={disabled}>
          Test sign-in
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
