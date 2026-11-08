"use client";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";

export interface FormState {
  ok?: boolean;
  error?: string | null;
  fields?: Record<string, string>;
  message?: string | null;
  data?: unknown;
  nonce?: number;
}
type Action = (prev: FormState, fd: FormData) => Promise<FormState>;

export function SubmitButton({ children, className = "btn btn-primary", name, value, disabled }: { children: ReactNode; className?: string; name?: string; value?: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} name={name} value={value} disabled={pending || disabled} aria-disabled={pending || disabled}>
      {pending ? "Working…" : children}
    </button>
  );
}

export function FormMessages({ state }: { state: FormState }) {
  if (!state.error && !state.message) return null;
  const fieldErrors = state.fields ? Object.entries(state.fields) : [];
  return (
    <div role={state.error ? "alert" : "status"} className={`alert ${state.error ? "alert-error" : "alert-success"}`}>
      <span>
      {state.error ? <strong>Not completed: </strong> : null}
      {state.error ?? state.message}
      {fieldErrors.length > 0 && (
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {fieldErrors.map(([k, v]) => (
            <li key={k}>{v}</li>
          ))}
        </ul>
      )}
      </span>
    </div>
  );
}

/**
 * Server-action form with inline error display. Hidden idempotency key is regenerated after each
 * successful submission; duplicate clicks while pending are blocked and replayed server-side.
 */
export function ActionForm({
  action,
  children,
  className = "stack",
  refreshOnSuccess = true,
  resetOnSuccess = false,
  encType,
  showMessages = true,
  doneHref,
}: {
  action: Action;
  children: ReactNode | ((state: FormState) => ReactNode);
  className?: string;
  refreshOnSuccess?: boolean;
  resetOnSuccess?: boolean;
  encType?: "multipart/form-data";
  showMessages?: boolean;
  /** After success, navigate here (e.g. the case page with ?done=1 to show the committed result). */
  doneHref?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (state.ok) {
      setKey(crypto.randomUUID());
      if (resetOnSuccess) ref.current?.reset();
      if (doneHref) router.replace(doneHref);
      else if (refreshOnSuccess) router.refresh();
    }
  }, [state, refreshOnSuccess, resetOnSuccess, router, doneHref]);
  return (
    <form ref={ref} action={formAction} className={className} encType={encType}>
      <input type="hidden" name="idempotencyKey" value={key} />
      {showMessages && <FormMessages state={state} />}
      {typeof children === "function" ? children(state) : children}
    </form>
  );
}

/** A reason-required action (Reject / Return / Send for Correction). */
export function ReasonAction({
  action,
  hidden,
  label,
  danger = false,
  placeholder = "Reason (required)",
  doneHref,
}: {
  action: Action;
  hidden: Record<string, string>;
  label: string;
  danger?: boolean;
  placeholder?: string;
  doneHref?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" className={`btn ${danger ? "btn-danger" : ""}`} onClick={() => setOpen(true)}>
        {label}…
      </button>
    );
  return (
    <ActionForm action={action} doneHref={doneHref}>
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <div className="field">
        <label htmlFor={`reason-${label}`}>{label}: reason</label>
        <textarea id={`reason-${label}`} name="reason" required minLength={3} placeholder={placeholder} />
      </div>
      <div className="row">
        <SubmitButton className={`btn ${danger ? "btn-danger" : "btn-dark"}`}>Confirm {label.toLowerCase()}</SubmitButton>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}
