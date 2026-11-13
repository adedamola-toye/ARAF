"use client";
import { createContext, startTransition, useActionState, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { IncidentPanel, type FailureReport } from "./Incident";
import type { IncidentView } from "@/lib/incident-messages";

export interface FormState {
  ok?: boolean;
  error?: string | null;
  fields?: Record<string, string>;
  message?: string | null;
  data?: unknown;
  nonce?: number;
  /** Technical failure recorded by the server (see toActionError). */
  incident?: IncidentView & { retry: boolean };
  /** Technical failure seen only by the browser (a crash or a lost response). */
  clientIncident?: FailureReport;
}
type Action = (prev: FormState, fd: FormData) => Promise<FormState>;

/** Pending state of the enclosing ActionForm (or of a plain form action). */
const PendingContext = createContext(false);
export function useActionPending() {
  const ctx = useContext(PendingContext);
  const { pending } = useFormStatus();
  return ctx || pending;
}

export function SubmitButton({ children, className = "btn btn-primary", name, value, disabled }: { children: ReactNode; className?: string; name?: string; value?: string; disabled?: boolean }) {
  const pending = useActionPending();
  return (
    <button type="submit" className={className} name={name} value={value} disabled={pending || disabled} aria-disabled={pending || disabled}>
      {pending ? "Working…" : children}
    </button>
  );
}

/** Lets the incident panel resubmit exactly what the user sent (same idempotency key). */
const ResubmitContext = createContext<(() => void) | null>(null);

export function FormMessages({ state }: { state: FormState }) {
  const resubmit = useContext(ResubmitContext);
  const router = useRouter();
  if (state.incident || state.clientIncident)
    return <IncidentPanel key={state.nonce} preset={state.incident ?? null} report={state.clientIncident ?? null} onResubmit={resubmit ?? undefined} onCheckStatus={() => router.refresh()} />;
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
  const lastSubmission = useRef<FormData | null>(null);
  const [state, formAction, pending] = useActionState(async (prev: FormState, fd: FormData): Promise<FormState> => {
    try {
      return await action(prev, fd);
    } catch (e) {
      const err = e as Error & { digest?: string };
      if (/^NEXT_/.test(String(err?.digest ?? ""))) throw e; // redirects and other Next.js control flow
      // The server failed past its handler (it has a digest) or the browser never got an answer (no digest).
      return {
        ok: false,
        error: "A technical problem stopped this. Your entries are kept.",
        clientIncident: err?.digest ? { kind: "client", digest: err.digest, name: err.name } : { kind: "network", name: err?.name ?? "Error", message: err?.message ?? null },
        nonce: Date.now(),
      };
    }
  }, {});
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
  // Submitted through onSubmit rather than the action prop: React resets uncontrolled fields after a
  // form action, which would wipe what the user typed when the server rejects the input.
  return (
    <ResubmitContext.Provider
      value={() => {
        const fd = lastSubmission.current;
        if (fd && !pending) startTransition(() => formAction(fd));
      }}
    >
      <PendingContext.Provider value={pending}>
        <form
          ref={ref}
          className={className}
          encType={encType}
          onSubmit={(e) => {
            e.preventDefault();
            if (pending) return;
            const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
            const fd = new FormData(e.currentTarget, submitter && submitter.getAttribute("name") ? submitter : undefined);
            lastSubmission.current = fd;
            startTransition(() => formAction(fd));
          }}
        >
          <input type="hidden" name="idempotencyKey" value={key} />
          {showMessages && <FormMessages state={state} />}
          {typeof children === "function" ? children(state) : children}
        </form>
      </PendingContext.Provider>
    </ResubmitContext.Provider>
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
