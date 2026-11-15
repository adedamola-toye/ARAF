"use client";
import { useId, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { VERIFICATION_MESSAGE, type Checklist } from "@/lib/approval-checklists";
import { useActionPending } from "./forms";

export interface VerifyProps {
  checklist: Checklist;
  /** Application / request reference shown in the dialog. */
  reference: string;
  /** The proposed decision as the user sees it (e.g. "Recommend to Head of Retail Sales"). */
  actionLabel: string;
  /** Lock version of the record the reviewer has open (stale versions are refused by the server). */
  viewedVersion: number;
}

/**
 * The "Before you proceed" verification. Renders the decision button; clicking it opens the checklist. Every
 * item must be ticked before Confirm is enabled; Confirm puts the acknowledgement in a hidden field and submits
 * the surrounding form. Cancel closes the dialog and leaves the form exactly as it was. Ticks are cleared each
 * time it opens, so every decision is acknowledged afresh.
 */
export function VerifyButton({ verify, label, className = "btn btn-primary", disabled, extra, onOpen, submitFields }: { verify: VerifyProps; label: string; className?: string; disabled?: boolean; extra?: React.ReactNode; onOpen?: () => void; submitFields?: Record<string, string> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const hidden = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const pending = useActionPending();
  const id = useId();
  const all = verify.checklist.items.every((i) => ticked[i.code]);
  return (
    <>
      <input ref={hidden} type="hidden" name="verification" defaultValue="" />
      <button
        ref={button}
        type="button"
        className={className}
        disabled={disabled || pending}
        onClick={() => {
          setTicked({});
          if (hidden.current) hidden.current.value = "";
          onOpen?.();
          dialog.current?.showModal();
        }}
      >
        {label}
      </button>
      <dialog ref={dialog} className="modal modal-verify" aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`}>
        <div className="modal-body">
          <h2 id={`${id}-t`} className="verify-title">
            <ShieldCheck className="icon" aria-hidden="true" /> Before you proceed
          </h2>
          <p id={`${id}-d`} className="muted" style={{ marginTop: 0 }}>
            {VERIFICATION_MESSAGE}
          </p>
          <dl className="verify-meta">
            <div>
              <dt>Application</dt>
              <dd className="mono">{verify.reference}</dd>
            </div>
            <div>
              <dt>Proposed action</dt>
              <dd>{verify.actionLabel}</dd>
            </div>
          </dl>
          {extra}
          <fieldset className="verify-list">
            <legend className="small">{verify.checklist.title}: confirm each item</legend>
            {verify.checklist.items.map((i) => (
              <label key={i.code} className="check">
                <input type="checkbox" checked={!!ticked[i.code]} onChange={(e) => setTicked((t) => ({ ...t, [i.code]: e.target.checked }))} />
                <span>{i.text}</span>
              </label>
            ))}
          </fieldset>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => dialog.current?.close()} autoFocus>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!all}
            aria-disabled={!all}
            onClick={() => {
              if (!all) return;
              if (hidden.current)
                hidden.current.value = JSON.stringify({ checklistId: verify.checklist.id, version: verify.checklist.version, items: verify.checklist.items.map((i) => i.code), viewedVersion: verify.viewedVersion });
              dialog.current?.close();
              const form = button.current?.form;
              if (!form) return;
              // Fields that identify the decision (e.g. decision=APPROVE) exist only for this submission.
              const added = Object.entries(submitFields ?? {}).map(([k, v]) => {
                const el = document.createElement("input");
                el.type = "hidden";
                el.name = k;
                el.value = v;
                form.appendChild(el);
                return el;
              });
              form.requestSubmit();
              setTimeout(() => added.forEach((el) => el.remove()), 0);
            }}
          >
            Confirm
          </button>
        </div>
      </dialog>
    </>
  );
}
