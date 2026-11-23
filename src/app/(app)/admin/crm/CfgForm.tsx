"use client";
import { useId, type ReactNode } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { crmConfigAction } from "./actions";

/** A configuration form: the fields, a mandatory reason, and Save. Changes publish immediately after validation. */
export function CfgForm({ kind, hidden = {}, children, submit = "Save", compact = false }: { kind: string; hidden?: Record<string, string>; children: ReactNode; submit?: string; compact?: boolean }) {
  const id = useId();
  return (
    <ActionForm action={crmConfigAction} className="stack">
      <input type="hidden" name="kind" value={kind} />
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {children}
      <div className="field" style={compact ? { margin: 0 } : undefined}>
        <label htmlFor={`${id}-reason`}>Reason for the change (required)</label>
        <input id={`${id}-reason`} name="reason" required minLength={10} placeholder="e.g. Agreed with the CX Head on 20 Nov" />
      </div>
      <div>
        <SubmitButton>{submit}</SubmitButton>
      </div>
    </ActionForm>
  );
}
