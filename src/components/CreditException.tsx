"use client";
import { useState } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { ActionForm, SubmitButton } from "./forms";

export interface ExceptionView {
  status: string;
  rmReason: string;
  raisedBy: string | null;
  raisedAt: string;
  failed: { person: string; score: number | null; checkedAt: string }[];
  tl: { name: string | null; at: string | null; recommendation: string | null; remarks: string | null };
  uh: { name: string | null; at: string | null; recommendation: string | null; remarks: string | null };
  dh: { name: string | null; at: string | null; recommendation: string | null; remarks: string | null };
}

const REC: Record<string, string> = { PROCEED: "Recommend proceeding", RETURN: "Return to the RM", DECLINE: "Decline" };
const STATUS: Record<string, string> = {
  PENDING_REVIEW: "Credit Score Exception — Pending Review",
  APPROVED: "Credit Score Exception — Approved through the workflow",
  DECLINED: "Credit Score Exception — Declined",
  WITHDRAWN: "Credit Score Exception — Withdrawn",
  SUPERSEDED: "Credit Score Exception — Superseded by a later check",
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

/** RM: low-score result with Proceed with Reason (before submission). */
export function ProceedWithReason({ applicationId, failed, existingReason, action }: { applicationId: string; failed: { person: string; score: number | null }[]; existingReason: string | null; action: (p: object, fd: FormData) => Promise<object> }) {
  const [open, setOpen] = useState(!!existingReason);
  return (
    <section className="card credit-exception" aria-labelledby="ce-h">
      <h2 id="ce-h">
        <ShieldAlert className="icon" aria-hidden="true" /> Credit Assessment Unsuccessful
      </h2>
      <p style={{ marginTop: 0 }}>
        SeedFi returned a low credit score result{failed.length ? ` (${failed.map((f) => `${f.person}: ${f.score ?? "score not returned"}`).join("; ")})` : ""}. You may submit this application for further review by providing a justification. <strong>Proceeding does not constitute credit approval.</strong>
      </p>
      {existingReason && (
        <p className="small">
          <span className="badge badge-warn">Credit Score Exception — Pending Review</span> Your justification: “{existingReason}”
        </p>
      )}
      {!open ? (
        <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
          Proceed with Reason
        </button>
      ) : (
        <ActionForm action={action as never}>
          <input type="hidden" name="applicationId" value={applicationId} />
          <div className="field">
            <label htmlFor="ce-reason">Reason for Proceeding Despite Low Credit Score</label>
            <textarea id="ce-reason" name="exceptionReason" rows={4} required minLength={20} defaultValue={existingReason ?? ""} placeholder="Explain the customer's circumstances and why the request merits review (e.g. verified recent income, settled obligations)." />
            <span className="hint">Recorded against the SeedFi result, which is kept unchanged. The Team Lead and Unit Head will see it.</span>
          </div>
          <div>
            <SubmitButton>{existingReason ? "Update justification" : "Save justification and continue"}</SubmitButton>
          </div>
        </ActionForm>
      )}
    </section>
  );
}

/** Reviewer banner (Team Lead, Unit Head and everyone after): the exception stays visible throughout. */
export function ExceptionBanner({ e, heading }: { e: ExceptionView; heading: string }) {
  return (
    <section className="credit-exception-banner" role="alert" aria-labelledby="ceb-h">
      <h2 id="ceb-h">
        <AlertTriangle className="icon" aria-hidden="true" /> {heading}
      </h2>
      <p className="small" style={{ margin: "0 0 8px" }}>
        <strong>{STATUS[e.status] ?? e.status}</strong> · Proceeding does not constitute credit approval and bypasses no approval, document or disbursement control.
      </p>
      <dl className="ce-grid">
        <div>
          <dt>Original SeedFi result</dt>
          <dd>{e.failed.map((f) => `${f.person}: Seed Score ${f.score ?? "not returned"} (low score), ${when(f.checkedAt)}`).join("; ")}</dd>
        </div>
        <div>
          <dt>RM&apos;s justification</dt>
          <dd>
            “{e.rmReason}” <span className="muted">— {e.raisedBy}, {when(e.raisedAt)}</span>
          </dd>
        </div>
        {(["tl", "uh", "dh"] as const).map((k) =>
          e[k].at ? (
            <div key={k}>
              <dt>{k === "tl" ? "Team Lead" : k === "uh" ? "Unit Head" : "Divisional Head"} acknowledgement</dt>
              <dd>
                {e[k].name}, {when(e[k].at)} · {REC[e[k].recommendation ?? ""] ?? ""} · “{e[k].remarks}”
              </dd>
            </div>
          ) : null,
        )}
      </dl>
    </section>
  );
}

/** The assigned reviewer's acknowledgement (required before their decision is accepted). */
export function ExceptionAckForm({ applicationId, action }: { applicationId: string; action: (p: object, fd: FormData) => Promise<object> }) {
  return (
    <ActionForm action={action as never} className="stack ce-ack">
      <input type="hidden" name="applicationId" value={applicationId} />
      <label className="check">
        <input type="checkbox" name="exceptionAcknowledged" required />
        <span>I acknowledge that SeedFi returned a low credit score and that this request proceeds as an exception.</span>
      </label>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="ce-rec">Your recommendation on the exception</label>
          <select id="ce-rec" name="exceptionRecommendation" required defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            <option value="PROCEED">Recommend proceeding</option>
            <option value="RETURN">Return to the RM</option>
            <option value="DECLINE">Decline</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ce-rem">Remarks on the exception</label>
          <textarea id="ce-rem" name="exceptionRemarks" rows={2} required minLength={10} />
        </div>
      </div>
      <div>
        <SubmitButton>Acknowledge exception</SubmitButton>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Then record your decision below (approve, return or decline) as usual.</p>
    </ActionForm>
  );
}
