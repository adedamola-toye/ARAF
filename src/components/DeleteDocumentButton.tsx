"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteDocumentAction } from "@/app/(app)/requests/actions";

/** Remove a document uploaded in error while the request is a draft or under correction. */
export function DeleteDocumentButton({ documentId, label = "Remove" }: { documentId: string; label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="row" style={{ gap: 6, display: "inline-flex", alignItems: "center" }}>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`Remove this document? This cannot be undone.`)) return;
          setError(null);
          startTransition(async () => {
            const r = await deleteDocumentAction(documentId);
            if (r.ok) router.refresh();
            else setError(r.error ?? "Could not remove the document.");
          });
        }}
      >
        {pending ? "Removing…" : label}
      </button>
      {error && <span className="small err">{error}</span>}
    </span>
  );
}
