import type { Role } from "./roles";

export const STAGES = [
  "DRAFT",
  "BUSINESS_ENDORSEMENT",
  "INITIATOR_CORRECTION",
  "FIRST_CREDIT_REVIEW",
  "CREDIT_CORRECTION",
  "SECOND_CREDIT_REVIEW",
  "UNIT_HEAD_REVIEW",
  "DIVISIONAL_HEAD_REVIEW",
  "OFFER_PREPARATION",
  "CO3_PACK_REVIEW",
  "DISBURSEMENT_CHECK",
  "DISBURSEMENT_CORRECTION",
  "DISBURSEMENT_BOOKING",
  "COMPLETION",
  "VENDOR_CONFIRMATION",
  "CLOSED",
  "REJECTED",
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  DRAFT: "Draft",
  BUSINESS_ENDORSEMENT: "Business endorsement",
  INITIATOR_CORRECTION: "Correction by initiator",
  FIRST_CREDIT_REVIEW: "First credit review",
  CREDIT_CORRECTION: "Credit correction (first reviewer)",
  SECOND_CREDIT_REVIEW: "Second credit review",
  UNIT_HEAD_REVIEW: "Unit Head approval",
  DIVISIONAL_HEAD_REVIEW: "Divisional Head approval",
  OFFER_PREPARATION: "Offer pack preparation",
  CO3_PACK_REVIEW: "Credit Officer 3 pack review",
  DISBURSEMENT_CHECK: "Disbursement check (DO1)",
  DISBURSEMENT_CORRECTION: "Disbursement correction (CO3)",
  DISBURSEMENT_BOOKING: "Disbursement booking (DO2)",
  COMPLETION: "Complete process (CO3)",
  VENDOR_CONFIRMATION: "Vendor payment confirmation",
  CLOSED: "Closed",
  REJECTED: "Rejected",
};

export const REQUIRED_ACTION: Record<Stage, string> = {
  DRAFT: "Complete and submit request",
  BUSINESS_ENDORSEMENT: "Endorse, reject or return the request",
  INITIATOR_CORRECTION: "Correct and resubmit the request",
  FIRST_CREDIT_REVIEW: "Upload 3 credit reports, complete APR/DSR, log invoice and decide",
  CREDIT_CORRECTION: "Resolve the correction or request documents from the initiator",
  SECOND_CREDIT_REVIEW: "Second credit review decision",
  UNIT_HEAD_REVIEW: "Unit Head decision",
  DIVISIONAL_HEAD_REVIEW: "Divisional Head decision",
  OFFER_PREPARATION: "Generate offer and upload signed offer pack",
  CO3_PACK_REVIEW: "Review pack, upload insurance evidence and forward",
  DISBURSEMENT_CHECK: "Check documents, confirm Logged CRMS and select Okay",
  DISBURSEMENT_CORRECTION: "Resolve disbursement correction and resubmit to DO1",
  DISBURSEMENT_BOOKING: "Record disbursement and click Disbursed",
  COMPLETION: "Complete Process",
  VENDOR_CONFIRMATION: "Confirm vendor payment and end of process",
  CLOSED: "—",
  REJECTED: "—",
};

export const TERMINAL_STAGES: readonly Stage[] = ["CLOSED", "REJECTED"];

/** Stages whose approval decisions are credit approvals invalidated by material changes. */
export const CREDIT_APPROVAL_STAGES: readonly Stage[] = [
  "FIRST_CREDIT_REVIEW",
  "SECOND_CREDIT_REVIEW",
  "UNIT_HEAD_REVIEW",
  "DIVISIONAL_HEAD_REVIEW",
];

export type TaskAction =
  | "ENDORSE"
  | "APPROVE"
  | "PROCEED"
  | "REJECT"
  | "RETURN"
  | "RESUBMIT"
  | "REQUEST_INITIATOR"
  | "SUBMIT_PACK"
  | "FORWARD"
  | "OKAY"
  | "SEND_FOR_CORRECTION"
  | "DISBURSED"
  | "COMPLETE_PROCESS"
  | "CONFIRM_VENDOR_PAYMENT";

export const ACTION_LABELS: Record<TaskAction, string> = {
  ENDORSE: "Endorse",
  APPROVE: "Approve",
  PROCEED: "Proceed",
  REJECT: "Reject",
  RETURN: "Return for correction",
  RESUBMIT: "Resubmit",
  REQUEST_INITIATOR: "Request documents from initiator",
  SUBMIT_PACK: "Submit pack to Credit Officer 3",
  FORWARD: "Forward to Disbursement Officer 1",
  OKAY: "Okay",
  SEND_FOR_CORRECTION: "Send for Correction",
  DISBURSED: "Disbursed",
  COMPLETE_PROCESS: "Complete Process",
  CONFIRM_VENDOR_PAYMENT: "Confirm vendor payment and end of process",
};

/** Actions requiring a reason. */
export const REASON_REQUIRED: readonly TaskAction[] = ["REJECT", "RETURN", "REQUEST_INITIATOR", "SEND_FOR_CORRECTION"];

/** Allowed actions per stage. Second review depends on the route (Proceed/Reject for routes 2 and 3). */
export function allowedActions(stage: Stage, route: number | null): TaskAction[] {
  switch (stage) {
    case "BUSINESS_ENDORSEMENT":
      return ["ENDORSE", "REJECT", "RETURN"];
    case "INITIATOR_CORRECTION":
      return ["RESUBMIT"];
    case "FIRST_CREDIT_REVIEW":
      return ["APPROVE", "REJECT", "RETURN"];
    case "CREDIT_CORRECTION":
      return ["RESUBMIT", "REQUEST_INITIATOR"];
    case "SECOND_CREDIT_REVIEW":
      return route === 1 ? ["APPROVE", "REJECT", "RETURN"] : ["PROCEED", "REJECT"];
    case "UNIT_HEAD_REVIEW":
    case "DIVISIONAL_HEAD_REVIEW":
      return ["APPROVE", "REJECT", "RETURN"];
    case "OFFER_PREPARATION":
      return ["SUBMIT_PACK"];
    case "CO3_PACK_REVIEW":
      return ["FORWARD", "RETURN"];
    case "DISBURSEMENT_CHECK":
      return ["OKAY", "SEND_FOR_CORRECTION"];
    case "DISBURSEMENT_CORRECTION":
      return ["RESUBMIT"];
    case "DISBURSEMENT_BOOKING":
      return ["DISBURSED"];
    case "COMPLETION":
      return ["COMPLETE_PROCESS"];
    case "VENDOR_CONFIRMATION":
      return ["CONFIRM_VENDOR_PAYMENT"];
    default:
      return [];
  }
}

export interface StageRoleInfo {
  roles: Role[] | "INITIATOR" | "FIRST_REVIEWER";
}
