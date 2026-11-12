import { CheckCircle2, CircleDot, Clock, FileSignature, Send, XCircle, type LucideIcon } from "lucide-react";
import { DOCUMENTATION_STATUS_LABELS, STAFF_STATUS_LABELS, STAFF_STATUS_TONE, type StaffStatus } from "@/lib/staff-financing";

const ICON: Partial<Record<StaffStatus, LucideIcon>> = {
  COMPLETED: CheckCircle2,
  APPROVED: CheckCircle2,
  DECLINED: XCircle,
  OFFER_EXPIRED: XCircle,
  AWAITING_SIGNED_OFFER: FileSignature,
  RETURNED_FOR_CORRECTION: Clock,
  DRAFT: CircleDot,
};

/** Status chip: text plus icon, never colour alone. */
export function StaffStatusBadge({ status }: { status: string }) {
  const s = status as StaffStatus;
  const Icon = ICON[s] ?? Send;
  return (
    <span className={`badge ${STAFF_STATUS_TONE[s] ?? ""}`}>
      <Icon className="icon" aria-hidden="true" />
      {STAFF_STATUS_LABELS[s] ?? status}
    </span>
  );
}

export function DocumentationBadge({ status }: { status: string }) {
  const tone = status === "REVIEW_COMPLETED" ? "badge-green" : status === "NOT_STARTED" ? "" : status === "AWAITING_SHAREPOINT" || status === "PREPARING_ARCHIVE" ? "badge-warn" : "badge-blue";
  return <span className={`badge ${tone}`}>{DOCUMENTATION_STATUS_LABELS[status] ?? status}</span>;
}

const EVENT_LABEL: Record<string, string> = {
  DRAFT_CREATED: "Draft created",
  SUBMITTED: "Submitted",
  RESUBMITTED: "Resubmitted",
  PM_REVIEW_STARTED: "Product Manager review started",
  PM_FORWARD: "Forwarded to Unit Head",
  PM_RETURN: "Returned by Product Manager",
  PM_DECLINE: "Declined by Product Manager",
  UNIT_HEAD_APPROVE: "Approved by Unit Head",
  UNIT_HEAD_RETURN: "Returned by Unit Head",
  UNIT_HEAD_DECLINE: "Declined by Unit Head",
  DIVISIONAL_HEAD_APPROVE: "Final approval",
  DIVISIONAL_HEAD_RETURN: "Returned by Divisional Head",
  DIVISIONAL_HEAD_DECLINE: "Declined by Divisional Head",
  OFFER_ISSUED: "Offer letter issued",
  OFFER_GENERATION_BLOCKED: "Offer letter being prepared",
  SIGNED_OFFER_RECEIVED: "Signed offer received",
  DISBURSEMENT_OFFICER_ASSIGNED: "Assigned for disbursement",
  DISBURSEMENT_STARTED: "Disbursement in progress",
  DISBURSEMENT_COMPLETED: "Disbursed",
  OFFER_EXPIRED: "Offer expired",
  DOCUMENT_UPLOADED: "Document uploaded",
  APPROVAL_WITHDRAWN_FOR_AMENDMENT: "Returned for amendment",
};
export const eventLabel = (a: string | null) => (a ? (EVENT_LABEL[a] ?? a.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())) : "—");

