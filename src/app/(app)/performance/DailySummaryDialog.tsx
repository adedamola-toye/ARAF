"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { markSummarySeenAction } from "./actions";

/** Shown once per Lagos day to Relationship Managers and Team Leads; closing it records that it was seen. */
export function DailySummaryDialog({ name, children }: { name: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);
  const close = () => {
    ref.current?.close();
  };
  return (
    <dialog ref={ref} className="modal modal-wide" aria-labelledby="perf-dlg-title" onClose={() => void markSummarySeenAction()}>
      <div className="modal-body">
        <h2 id="perf-dlg-title">Good day{name ? `, ${name.split(/\s+/)[0]}` : ""}: your performance today</h2>
        {children}
      </div>
      <div className="modal-actions">
        <Link href="/performance" className="btn" onClick={close}>
          Open full view
        </Link>
        <button type="button" className="btn btn-primary" onClick={close} autoFocus>
          Continue to work
        </button>
      </div>
    </dialog>
  );
}
