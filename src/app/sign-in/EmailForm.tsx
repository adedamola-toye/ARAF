"use client";
import { useActionState } from "react";
import { requestOtpAction } from "./actions";
import { FormMessages, SubmitButton } from "@/components/forms";

export function EmailForm({ as, next }: { as: string; next: string }) {
  const [state, action] = useActionState(requestOtpAction, {});
  return (
    <form action={action} className="stack">
      <FormMessages state={state} />
      <input type="hidden" name="as" value={as} />
      <input type="hidden" name="next" value={next} />
      <div className="field">
        <label htmlFor="email">Work email</label>
        <input id="email" name="email" type="email" autoComplete="username" required placeholder="firstname.lastname@altbank.ng" aria-invalid={!!state.fields?.email} />
      </div>
      <SubmitButton>Send one-time code</SubmitButton>
    </form>
  );
}
