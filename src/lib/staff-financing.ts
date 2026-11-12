/**
 * Staff Personal Financing: calculation and status vocabulary shared by the browser (live calculator,
 * labels) and the server. The server always recalculates and is the only source of stored figures.
 *
 * Calculation (as specified by the product owner):
 *   gross     = amount requested
 *   deduction = gross × deduction rate (2% in settings v1), rounded half-up to the kobo
 *   net       = gross − deduction
 * Integer kobo arithmetic with BigInt; no floating point is involved.
 */

export interface StaffFinancingFigures {
  grossKobo: number;
  deductionRateBps: number;
  deductionKobo: number;
  netKobo: number;
}

export function computeStaffFinancing(grossKobo: number, deductionRateBps: number): StaffFinancingFigures {
  if (!Number.isSafeInteger(grossKobo) || grossKobo <= 0) throw new Error("Gross amount must be a positive whole number of kobo");
  if (!Number.isInteger(deductionRateBps) || deductionRateBps < 0 || deductionRateBps > 10000) throw new Error("Invalid deduction rate");
  const g = BigInt(grossKobo);
  const deduction = (g * BigInt(deductionRateBps) * 2n + 10000n) / 20000n; // round half-up
  return { grossKobo, deductionRateBps, deductionKobo: Number(deduction), netKobo: Number(g - deduction) };
}

/** 200 → "2%", 250 → "2.5%". */
export function bpsLabel(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}%`;
}

/** ₦1,234,567.89 with commas and two decimals, from integer kobo. */
export function formatNairaKobo(kobo: number | string | bigint | null | undefined): string {
  if (kobo === null || kobo === undefined || kobo === "") return "—";
  const k = BigInt(kobo);
  const neg = k < 0n;
  const abs = neg ? -k : k;
  const grouped = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}₦${grouped}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export const STAFF_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_PM_REVIEW",
  "RETURNED_FOR_CORRECTION",
  "UNDER_UNIT_HEAD_REVIEW",
  "UNDER_DIVISIONAL_HEAD_REVIEW",
  "APPROVED",
  "AWAITING_SIGNED_OFFER",
  "OFFER_EXPIRED",
  "ASSIGNED_FOR_DISBURSEMENT",
  "DISBURSEMENT_IN_PROGRESS",
  "COMPLETED",
  "DECLINED",
] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

export const STAFF_STATUS_LABELS: Record<StaffStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  UNDER_PM_REVIEW: "Under Product Manager review",
  RETURNED_FOR_CORRECTION: "Returned for correction",
  UNDER_UNIT_HEAD_REVIEW: "Under Unit Head review",
  UNDER_DIVISIONAL_HEAD_REVIEW: "Under Divisional Head review",
  APPROVED: "Approved",
  AWAITING_SIGNED_OFFER: "Offer letter issued · awaiting signed offer",
  OFFER_EXPIRED: "Expired — offer not accepted",
  ASSIGNED_FOR_DISBURSEMENT: "Assigned for disbursement",
  DISBURSEMENT_IN_PROGRESS: "Disbursement in progress",
  COMPLETED: "Completed",
  DECLINED: "Declined",
};

/** Queue that owns the next action at each status (for tracking screens). */
export const STAFF_STATUS_QUEUE: Record<StaffStatus, string> = {
  DRAFT: "You (applicant)",
  SUBMITTED: "Product Manager queue",
  UNDER_PM_REVIEW: "Product Manager",
  RETURNED_FOR_CORRECTION: "You (applicant)",
  UNDER_UNIT_HEAD_REVIEW: "Unit Head",
  UNDER_DIVISIONAL_HEAD_REVIEW: "Divisional Head queue",
  APPROVED: "Offer letter preparation",
  AWAITING_SIGNED_OFFER: "You (applicant)",
  OFFER_EXPIRED: "None (closed)",
  ASSIGNED_FOR_DISBURSEMENT: "Disbursement Officer",
  DISBURSEMENT_IN_PROGRESS: "Disbursement Officer",
  COMPLETED: "None (completed)",
  DECLINED: "None (closed)",
};

export const STAFF_NEXT_ACTION: Record<StaffStatus, string> = {
  DRAFT: "Complete the form, acknowledge the deduction and submit.",
  SUBMITTED: "A Product Manager will pick up the request for review.",
  UNDER_PM_REVIEW: "Product Manager is verifying your account, salary history and repayment capacity.",
  RETURNED_FOR_CORRECTION: "Correct the request as explained and resubmit.",
  UNDER_UNIT_HEAD_REVIEW: "Unit Head decision.",
  UNDER_DIVISIONAL_HEAD_REVIEW: "Divisional Head final approval.",
  APPROVED: "The offer letter is being prepared.",
  AWAITING_SIGNED_OFFER: "Download the offer letter, sign it and upload the signed copy before the deadline.",
  OFFER_EXPIRED: "No further action. The offer was not accepted in time.",
  ASSIGNED_FOR_DISBURSEMENT: "Disbursement Officer is reviewing the documentation.",
  DISBURSEMENT_IN_PROGRESS: "Disbursement Officer is processing the payment.",
  COMPLETED: "No action. The facility has been disbursed.",
  DECLINED: "No further action.",
};

export type StaffStatusTone = "badge-blue" | "badge-green" | "badge-red" | "badge-warn" | "badge-yellow" | "";
export const STAFF_STATUS_TONE: Record<StaffStatus, StaffStatusTone> = {
  DRAFT: "",
  SUBMITTED: "badge-blue",
  UNDER_PM_REVIEW: "badge-blue",
  RETURNED_FOR_CORRECTION: "badge-warn",
  UNDER_UNIT_HEAD_REVIEW: "badge-blue",
  UNDER_DIVISIONAL_HEAD_REVIEW: "badge-blue",
  APPROVED: "badge-green",
  AWAITING_SIGNED_OFFER: "badge-warn",
  OFFER_EXPIRED: "badge-red",
  ASSIGNED_FOR_DISBURSEMENT: "badge-blue",
  DISBURSEMENT_IN_PROGRESS: "badge-blue",
  COMPLETED: "badge-green",
  DECLINED: "badge-red",
};

export const DOCUMENTATION_STATUS_LABELS: Record<string, string> = {
  NOT_STARTED: "Not started",
  PREPARING_ARCHIVE: "Preparing documentation archive",
  AWAITING_SHAREPOINT: "Archive created · awaiting SharePoint storage",
  SENT_TO_LEGAL_SHARIAH: "Sent to Legal and Shariah for Review",
  RECEIVED_BY_LEGAL_SHARIAH: "Received by Legal and Shariah",
  REVIEW_COMPLETED: "Legal and Shariah review completed",
};

export const STAFF_DOC_CATEGORIES = {
  PAYSLIP: "Payslip",
  ACCOUNT_STATEMENT: "Salary account statement",
  STAFF_ID_CARD: "Staff ID card",
  OTHER_SUPPORTING: "Other supporting document",
  GENERATED_OFFER: "Offer letter (generated)",
  SIGNED_OFFER: "Signed offer letter",
  DISBURSEMENT_EVIDENCE: "Disbursement evidence",
} as const;
export type StaffDocCategory = keyof typeof STAFF_DOC_CATEGORIES;
export const APPLICANT_SUPPORTING_CATEGORIES: StaffDocCategory[] = ["PAYSLIP", "ACCOUNT_STATEMENT", "STAFF_ID_CARD", "OTHER_SUPPORTING"];

/** Hours a staff member has to return the signed offer letter (specified: 24 hours from issue). */
export const OFFER_ACCEPTANCE_HOURS = 24;
/** A reminder is sent once when this many hours or fewer remain before the offer deadline. */
export const OFFER_REMINDER_HOURS = 4;
