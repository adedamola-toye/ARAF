import Link from "next/link";
import { CheckCircle2, Circle } from "lucide-react";
import { db } from "@/server/db";
import { activeHold, attempts, canUseCad, preDisbursementChecklist } from "@/server/domain/cad";
import { formatLagos } from "@/server/time";
import { InspectForm } from "../../bouquets/BouquetForms";
import { AttemptForm, HoldForm, ReleaseForm, ResolveAttemptForm } from "./Phase3Client";

/** Shown when a Divisional Head opens a facility from a bouquet (random sample or manual selection). */
export async function BouquetInspectCard({ appId, bouquetId, memberId, staffId, sampled }: { appId: string; bouquetId: string; memberId: string; staffId: string; sampled: boolean }) {
  if (!/^[0-9a-f-]{36}$/i.test(bouquetId) || !/^[0-9a-f-]{36}$/i.test(memberId)) return null;
  const m = (
    await db.query<{ ref: string; status: string; inspected_at: Date | null; divisional_head_id: string; bstatus: string }>(
      "SELECT b.ref, m.status, m.inspected_at, b.divisional_head_id, b.status AS bstatus FROM bouquet_members m JOIN bouquets b ON b.id = m.bouquet_id WHERE m.id = $1 AND m.bouquet_id = $2 AND m.application_id = $3",
      [memberId, bouquetId, appId],
    )
  ).rows[0];
  if (!m || m.divisional_head_id !== staffId) return null;
  return (
    <div className="card" style={{ borderColor: "var(--accent)" }}>
      <p className="eyebrow">{sampled ? "Random sample" : "Bouquet inspection"}</p>
      <h2 style={{ marginBottom: 4 }}>From bouquet {m.ref}</h2>
      <p className="small">Review the facility details, financing calculations, documents, credit assessment and previous approvals in the tabs, then mark it inspected.</p>
      {m.inspected_at && <p className="small muted">Inspected {formatLagos(m.inspected_at)}.</p>}
      {m.bstatus === "OPEN" && (m.status === "INCLUDED" || m.status === "EXCLUDED") ? (
        <InspectForm bouquetId={bouquetId} memberId={memberId} inspected={!!m.inspected_at} />
      ) : (
        <Link className="btn btn-ghost" href={`/bouquets/${bouquetId}`}>
          Back to bouquet
        </Link>
      )}
    </div>
  );
}

/** CAD: read-only pre-disbursement checklist, hold / release, and failed or uncertain posting attempts. */
export async function CadPanel({ appId, stage, workflow, staffId }: { appId: string; stage: string; workflow: string; staffId: string }) {
  if (!["DISBURSEMENT_CHECK", "DISBURSEMENT_BOOKING"].includes(stage)) return null;
  if (!(await canUseCad(db, staffId))) return null;
  const items = await preDisbursementChecklist(db, appId);
  const hold = await activeHold(db, appId);
  const list = await attempts(db, appId);
  return (
    <div className="card">
      <p className="eyebrow">CAD</p>
      <h2 style={{ marginBottom: 8 }}>Pre-disbursement checklist</h2>
      <ul className="plain-list small" aria-label="Pre-disbursement checks">
        {items.map((i) => (
          <li key={i.code} className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
            {i.ok ? (
              <CheckCircle2 className="icon" aria-hidden="true" style={{ color: "var(--success)", flexShrink: 0 }} />
            ) : (
              <Circle className="icon" aria-hidden="true" style={{ color: "var(--danger)", flexShrink: 0 }} />
            )}
            <span>
              <strong>{i.label}</strong>
              <span className="sr-only">{i.ok ? " (met)" : " (not met)"}</span>
              <br />
              <span className="muted">{i.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="small muted">ARAF records the posting; it does not move funds. A disbursement is successful only when the core-banking transaction reference is recorded.</p>
      {hold ? (
        <div className="alert alert-warn" role="status">
          <strong>On hold</strong> since {formatLagos(hold.held_at)} by {hold.held_by_name}: {hold.reason}
          <ReleaseForm appId={appId} />
        </div>
      ) : (
        <details>
          <summary className="small">Put on hold</summary>
          <HoldForm appId={appId} />
        </details>
      )}
      {list.length > 0 && (
        <>
          <h3 style={{ marginTop: "var(--space-4)" }}>Posting attempts</h3>
          <ul className="plain-list small">
            {list.map((a) => (
              <li key={a.id}>
                <span className={`badge ${a.outcome === "UNCERTAIN" && !a.resolution ? "badge-red" : a.resolution === "POSTED" ? "badge-green" : "badge-warn"}`}>
                  {a.outcome === "FAILED" ? "Failed" : a.resolution === "POSTED" ? "Verified posted" : a.resolution === "NOT_POSTED" ? "Verified not posted" : "Uncertain: verify"}
                </span>{" "}
                {formatLagos(a.recorded_at)} · {a.recorded_by_name}
                {a.attempted_ref ? ` · ref ${a.attempted_ref}` : ""} · {a.note}
                {a.resolution_note && a.outcome === "UNCERTAIN" && (
                  <div className="muted">
                    Resolved by {a.resolved_by_name}: {a.resolution_note}
                  </div>
                )}
                {a.outcome === "UNCERTAIN" && !a.resolution && <ResolveAttemptForm attemptId={a.id} />}
              </li>
            ))}
          </ul>
        </>
      )}
      {stage === "DISBURSEMENT_BOOKING" && workflow !== "RETAIL" && (
        <details>
          <summary className="small">Record a failed or uncertain posting</summary>
          <AttemptForm appId={appId} />
        </details>
      )}
    </div>
  );
}
