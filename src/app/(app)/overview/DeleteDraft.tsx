"use client";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { deleteDraftAction } from "./actions";

/** Two-step delete: the first click asks for confirmation, naming the draft. */
export function DeleteDraft({ id, label }: { id: string; label: string }) {
  const [ask, setAsk] = useState(false);
  if (!ask)
    return (
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAsk(true)} aria-label={`Delete draft ${label}`}>
        <Trash2 className="icon" aria-hidden="true" /> Delete
      </button>
    );
  return (
    <ActionForm action={deleteDraftAction} className="row" refreshOnSuccess>
      <input type="hidden" name="applicationId" value={id} />
      <span className="small">Delete {label}?</span>
      <SubmitButton className="btn btn-sm btn-danger">Delete draft</SubmitButton>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAsk(false)}>
        Keep
      </button>
    </ActionForm>
  );
}
