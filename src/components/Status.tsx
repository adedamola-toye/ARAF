import { AlertTriangle, Ban, CheckCircle2, CircleDot, Clock, FileEdit, Lock, PackageCheck, Wallet, type LucideIcon } from "lucide-react";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";

/**
 * Presentation labels for workflow states. These map existing domain stages to display text
 * (with an icon and a text label, never colour alone). They do not change any state.
 */
export function stagePresentation(stage: Stage, status?: string): { label: string; tone: string; Icon: LucideIcon } {
  switch (stage) {
    case "DRAFT":
      return { label: "Draft", tone: "", Icon: FileEdit };
    case "REJECTED":
      return { label: "Rejected", tone: "badge-red", Icon: Ban };
    case "CLOSED":
      return { label: "Closed", tone: "badge-dark", Icon: Lock };
    case "COMPLETION":
      return { label: "Disbursed", tone: "badge-green", Icon: Wallet };
    case "VENDOR_CONFIRMATION":
      return { label: "Awaiting Vendor Payment Confirmation", tone: "badge-warn", Icon: PackageCheck };
    case "INITIATOR_CORRECTION":
    case "CREDIT_CORRECTION":
    case "DISBURSEMENT_CORRECTION":
      return { label: STAGE_LABELS[stage], tone: "badge-warn", Icon: AlertTriangle };
    default:
      return { label: STAGE_LABELS[stage] ?? stage, tone: status === "BOOKED" ? "badge-green" : "badge-yellow", Icon: CircleDot };
  }
}

export function StageChip({ stage, status }: { stage: Stage; status?: string }) {
  const p = stagePresentation(stage, status);
  return (
    <span className={`badge ${p.tone}`}>
      <p.Icon className="icon" aria-hidden="true" />
      {p.label}
    </span>
  );
}

export function OutcomeChip({ outcome }: { outcome: string }) {
  if (outcome === "SUCCESS")
    return (
      <span className="badge badge-green">
        <CheckCircle2 className="icon" aria-hidden="true" />
        Success
      </span>
    );
  if (outcome === "DENIED")
    return (
      <span className="badge badge-red">
        <Ban className="icon" aria-hidden="true" />
        Denied
      </span>
    );
  return (
    <span className="badge badge-warn">
      <AlertTriangle className="icon" aria-hidden="true" />
      Failed
    </span>
  );
}

export function WaitChip({ ms, label }: { ms: number; label: string }) {
  const late = ms > 6 * 3600_000;
  return (
    <span className={`badge ${late ? "badge-warn" : ""}`}>
      <Clock className="icon" aria-hidden="true" />
      {label}
      {late && <span className="sr-only"> (over six hours)</span>}
    </span>
  );
}
