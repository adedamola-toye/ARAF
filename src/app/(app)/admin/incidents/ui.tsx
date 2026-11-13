import { INCIDENT_MESSAGES } from "@/lib/incident-messages";
import type { IncidentStatus } from "@/lib/incident-messages";

export const STATUS_LABEL: Record<IncidentStatus, string> = { DETECTED: "Detected", INVESTIGATING: "Investigating", RESOLVED: "Resolved", CLOSED: "Closed" };
const STATUS_BADGE: Record<IncidentStatus, string> = { DETECTED: "badge-yellow", INVESTIGATING: "badge-blue", RESOLVED: "badge-green", CLOSED: "badge-dark" };
const SEV_BADGE: Record<string, string> = { LOW: "badge-dark", MEDIUM: "badge-yellow", HIGH: "badge-warn", CRITICAL: "badge-red" };

export const StatusBadge = ({ s }: { s: IncidentStatus }) => <span className={`badge ${STATUS_BADGE[s]}`}>{STATUS_LABEL[s]}</span>;
export const SeverityBadge = ({ s }: { s: string }) => <span className={`badge ${SEV_BADGE[s] ?? "badge-dark"}`}>{s.charAt(0) + s.slice(1).toLowerCase()}</span>;

/** Allocation across the five messages: counts with proportional bars. */
export function Distribution({ counts, compact = false }: { counts: number[]; compact?: boolean }) {
  const max = Math.max(1, ...counts);
  return (
    <ul className={`inc-dist ${compact ? "is-compact" : ""}`} aria-label="Message allocation">
      {INCIDENT_MESSAGES.map((m, i) => (
        <li key={m.no}>
          <span className="inc-dist-k">
            {compact ? `M${m.no}` : `Message 0${m.no} — ${m.name}`}
          </span>
          <span className="inc-dist-bar" aria-hidden="true">
            <span style={{ width: `${(counts[i] / max) * 100}%` }} />
          </span>
          <span className="inc-dist-v">{counts[i].toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}
