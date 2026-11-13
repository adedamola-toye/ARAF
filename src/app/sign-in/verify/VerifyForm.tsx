"use client";
import { IncidentPanel } from "@/components/Incident";
import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { resendOtpAction, verifyOtpAction } from "../actions";

/** Initiator categories are shown first and in bold; the choice opens a workspace the user already holds. */
const WORKSPACES = [
  { v: "RM", l: "1. Relationship Managers", strong: true },
  { v: "DELIGHT_OFFICER", l: "2. Delight Officers / Smile Associates", strong: true },
  { v: "STAFF", l: "Review, credit, operations and administration staff", strong: false },
  { v: "ANM", l: "Agent Network Manager (WakeelBoost)", strong: false },
  { v: "MERCHANT_OFFICER", l: "Merchant Officer (WakeelBoost)", strong: false },
];

export function VerifyForm({ next, as, expiresAt, ttlMs }: { next: string; as: string; expiresAt: number; ttlMs: number }) {
  const [state, action, pending] = useActionState(verifyOtpAction, {});
  const [resend, resendAction, resending] = useActionState(resendOtpAction, {});
  const [deadline, setDeadline] = useState(expiresAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (resend.ok) setDeadline(Date.now() + ttlMs);
  }, [resend, ttlMs]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor((deadline - now) / 1000));
  const expired = left === 0;
  const msg = pending
    ? "Verifying…"
    : state.error ?? resend.error ?? resend.message ?? (expired ? "The code has expired. Request a new one." : `Code expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}.`);
  const isError = !!(state.error || resend.error || expired);
  return (
    <>
      {(state.incident ?? resend.incident) && <IncidentPanel key={(state.incident ? state : resend).nonce} preset={state.incident ?? resend.incident} onCheckStatus={() => location.reload()} />}
      <form action={action} className="auth-form">
        <input type="hidden" name="next" value={next} />
        <label htmlFor="code">One-time code</label>
        <input id="code" name="code" className="otp-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus aria-describedby="otp-feedback" aria-invalid={!!state.error} />
        <fieldset className="ws-choice">
          <legend>Open workspace</legend>
          {WORKSPACES.map((w) => (
            <label key={w.v}>
              <input type="radio" name="workspace" value={w.v} defaultChecked={(as || "STAFF") === w.v} />
              <span>{w.strong ? <strong>{w.l}</strong> : w.l}</span>
            </label>
          ))}
        </fieldset>
        <button type="submit" className="auth-continue" disabled={pending}>
          Continue <span aria-hidden="true">↗</span>
        </button>
        <p id="otp-feedback" className={`auth-feedback ${isError ? "error" : ""}`} role="status" aria-live="polite">
          {msg}
        </p>
        <p className="auth-feedback" style={{ marginTop: 0 }}>
          Permissions come from your role assignments; the workspace choice only opens a view you already hold.
        </p>
      </form>
      <form action={resendAction} className="auth-form" style={{ marginTop: 4 }}>
        <p className="auth-feedback" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button type="submit" className="btn btn-sm btn-ghost" style={{ padding: 0, minHeight: 0, color: "var(--link)" }} disabled={resending}>
            {resending ? "Sending…" : "Resend code"}
          </button>
          <Link href={`/sign-in?next=${encodeURIComponent(next)}`}>Use a different email</Link>
        </p>
      </form>
    </>
  );
}
