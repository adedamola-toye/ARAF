"use client";
import { useActionState } from "react";
import { verifyOtpAction } from "../actions";
import { FormMessages, SubmitButton } from "@/components/forms";

export function VerifyForm({ next }: { next: string }) {
  const [state, action] = useActionState(verifyOtpAction, {});
  return (
    <form action={action} className="stack">
      <FormMessages state={state} />
      <input type="hidden" name="next" value={next} />
      <div className="field">
        <label htmlFor="code">One-time code</label>
        <input id="code" name="code" className="otp-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus />
      </div>
      <SubmitButton>Verify and sign in</SubmitButton>
    </form>
  );
}
