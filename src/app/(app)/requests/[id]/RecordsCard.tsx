import { Archive } from "lucide-react";
import { db } from "@/server/db";
import { handovers, latestArchive, RECORDS_LABELS } from "@/server/domain/facility-archive";
import { formatLagos } from "@/server/time";
import { HandoverForm } from "./HandoverForm";

/** Facility archive and Legal & Shariah records review (after completion). */
export async function RecordsCard({ appId, recordsStatus, roles }: { appId: string; recordsStatus: string | null; roles: string[] }) {
  if (!recordsStatus) return null;
  const arch = await latestArchive(db, appId);
  const hs = await handovers(db, appId);
  return (
    <section className="card" aria-labelledby="rec-h">
      <p className="eyebrow">Records</p>
      <h2 id="rec-h" style={{ marginBottom: 4 }}>{RECORDS_LABELS[recordsStatus] ?? recordsStatus}</h2>
      {arch && (
        <p className="small">
          <a className="btn btn-sm" href={`/api/archives/${arch.id}`}>
            <Archive className="icon" aria-hidden="true" /> {arch.filename}
          </a>{" "}
          <span className="muted">
            {(Number(arch.size_bytes) / 1048576).toFixed(2)} MB · {formatLagos(arch.created_at)}
          </span>
        </p>
      )}
      <ul className="closing-list">
        {hs.map((h) => (
          <li key={h.group_code} style={{ alignItems: "flex-start" }}>
            <span className="closing-body">
              <strong>{h.group_code === "LEGAL" ? "Legal" : "Shariah Compliance"}</strong>
              <span className="small muted">
                {h.status === "SENT" ? `Sent ${formatLagos(h.sent_at)}` : h.status === "RECEIVED" ? `Received by ${h.received_name}, ${formatLagos(h.received_at)}` : `Reviewed by ${h.reviewed_name}, ${formatLagos(h.reviewed_at)}${h.comments ? ` — “${h.comments}”` : ""}`}
              </span>
              {h.status !== "REVIEWED" && roles.includes(h.group_code === "LEGAL" ? "LEGAL_REVIEWER" : "SHARIAH_REVIEWER") && (
                <div style={{ marginTop: 8 }}>
                  <HandoverForm applicationId={appId} group={h.group_code} status={h.status} />
                </div>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
