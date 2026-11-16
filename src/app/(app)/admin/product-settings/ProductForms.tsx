"use client";
import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import type { General } from "@/lib/product-settings";
import { discardDraftAction, dismissProposalAction, saveGeneralAction, startDraftAction } from "./actions";

export function StartDraft({ productCode, kind, refValue, replace, label, primary, small, confirm, update }: { productCode: string; kind: "SUPPLIED" | "BLANK" | "VERSION" | "PROPOSAL"; refValue?: string; replace?: boolean; label: string; primary?: boolean; small?: boolean; confirm?: string; update?: string }) {
  return (
    <ActionForm action={startDraftAction} className="ps-inline-form">
      <input type="hidden" name="productCode" value={productCode} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="ref" value={refValue ?? ""} />
      <input type="hidden" name="replace" value={replace ? "true" : "false"} />
      <input type="hidden" name="update" value={update ?? ""} />
      <span
        onClickCapture={(e) => {
          if (confirm && !window.confirm(confirm)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <SubmitButton className={`btn${primary ? " btn-primary" : ""}${small ? " btn-sm" : ""}`}>{label}</SubmitButton>
      </span>
    </ActionForm>
  );
}

export function DiscardDraft({ productCode }: { productCode: string }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        Discard draft
      </button>
    );
  return (
    <ActionForm action={discardDraftAction} className="ps-inline-form">
      <input type="hidden" name="productCode" value={productCode} />
      <span className="small">Discard all unpublished changes? The published version is not affected.</span>
      <SubmitButton className="btn btn-danger btn-sm">Discard draft</SubmitButton>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
        Keep it
      </button>
    </ActionForm>
  );
}

export function DismissProposal({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        Dismiss
      </button>
    );
  return (
    <ActionForm action={dismissProposalAction}>
      <input type="hidden" name="id" value={id} />
      <div className="field">
        <label htmlFor={`dismiss-${id}`}>Why is it being dismissed?</label>
        <input id={`dismiss-${id}`} name="reason" required minLength={10} placeholder="e.g. Superseded by the approved 2026 policy" />
      </div>
      <div className="row">
        <SubmitButton className="btn btn-danger btn-sm">Dismiss proposal</SubmitButton>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}

export function GeneralForm({ productCode, general, ceiling }: { productCode: string; general: General; ceiling: [string, string][] }) {
  const [all, setAll] = useState(general.originationRoles === null);
  return (
    <ActionForm action={saveGeneralAction}>
      {(state) => (
        <>
          <input type="hidden" name="productCode" value={productCode} />
          <div className="grid-2">
            <div className="field">
              <label htmlFor="g-name">Product name</label>
              <input id="g-name" name="name" defaultValue={general.name} required />
              {state.fields?.["general.name"] && <span className="err">{state.fields["general.name"]}</span>}
            </div>
            <div className="field">
              <label htmlFor="g-owner">Product owner</label>
              <input id="g-owner" name="owner" defaultValue={general.owner} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="g-desc">Description</label>
            <textarea id="g-desc" name="description" rows={2} defaultValue={general.description} />
          </div>
          <label className="check">
            <input type="checkbox" name="active" defaultChecked={general.active} />
            <span>Open for new applications</span>
          </label>
          <fieldset className="ps-checks">
            <legend>Who can originate this product</legend>
            <label className="check small">
              <input type="checkbox" name="allRoles" checked={all} onChange={(e) => setAll(e.target.checked)} />
              <span>Every permitted role ({ceiling.map(([, l]) => l).join(", ")})</span>
            </label>
            {!all && (
              <div className="ps-check-row ps-indent">
                {ceiling.map(([v, l]) => (
                  <label key={v} className="check small">
                    <input type="checkbox" name="originationRoles" value={v} defaultChecked={general.originationRoles?.includes(v) ?? true} />
                    <span>{l}</span>
                  </label>
                ))}
              </div>
            )}
            {state.fields?.["general.originationRoles"] && <span className="err">{state.fields["general.originationRoles"]}</span>}
          </fieldset>
          <div className="field">
            <label htmlFor="g-reason">Reason for the change</label>
            <textarea id="g-reason" name="reason" rows={2} required minLength={20} placeholder="At least 20 characters, e.g. the approving memo" />
            {state.fields?.reason && <span className="err">{state.fields.reason}</span>}
          </div>
          <div>
            <SubmitButton>Save general settings</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
