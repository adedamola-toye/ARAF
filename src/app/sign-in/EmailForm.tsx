"use client";
import { useActionState, useRef } from "react";
import { requestOtpAction } from "./actions";

export function EmailForm({ as, next, returning }: { as: string; next: string; returning: boolean }) {
  const [state, action, pending] = useActionState(requestOtpAction, {});
  const input = useRef<HTMLInputElement>(null);
  const feedback = pending ? "Sending your one-time code…" : state.error ?? (returning ? "Staff sign-in. You will return to the requested case." : "Staff sign-in.");
  return (
    <form
      action={action}
      className="auth-form"
      noValidate
      onSubmit={(e) => {
        const el = input.current!;
        const v = el.value.trim().toLowerCase();
        el.setCustomValidity(v.endsWith("@altbank.ng") ? "" : "Use your @altbank.ng email.");
        if (!el.reportValidity()) e.preventDefault();
      }}
    >
      <input type="hidden" name="as" value={as} />
      <input type="hidden" name="next" value={next} />
      <label htmlFor="email">Work email</label>
      <input
        ref={input}
        id="email"
        name="email"
        type="email"
        autoComplete="username"
        placeholder="you@altbank.ng"
        required
        aria-invalid={!!state.error}
        aria-describedby="email-feedback"
        onInput={(e) => e.currentTarget.setCustomValidity("")}
      />
      <button type="submit" className="auth-continue" disabled={pending}>
        Continue <span aria-hidden="true">↗</span>
      </button>
      <p id="email-feedback" className={`auth-feedback ${state.error ? "error" : ""}`} role="status">
        {feedback}
      </p>
    </form>
  );
}
