/**
 * Approval verification checklists (shared by the browser dialog and the server check).
 *
 * Shown before every positive approval-related decision (certify, recommend, endorse, concur, approve).
 * Never for Return or Reject, which keep their own reason requirement. The server requires the exact
 * checklist id, version and every item; a ticked box is an acknowledgement, not proof of review, so all
 * existing document, segregation-of-duty and credit-policy checks still apply.
 *
 * Bump `version` whenever an item's wording changes; recorded acknowledgements keep the text that was shown.
 */

export interface ChecklistItem {
  code: string;
  text: string;
}
export interface Checklist {
  id: string;
  version: number;
  title: string;
  items: ChecklistItem[];
}

export const VERIFICATION_MESSAGE = "Please confirm that you have carefully reviewed the application, supporting documents and relevant assessment. Your decision will be recorded against your profile.";

const c = (id: string, version: number, title: string, items: [string, string][]): Checklist => ({ id, version, title, items: items.map(([code, text]) => ({ code, text })) });

export const CHECKLISTS = {
  TL_CERTIFICATION: c("TL_CERTIFICATION", 1, "Team Lead certification", [
    ["CUSTOMER_REVIEWED", "Customer and application details have been reviewed."],
    ["CREDIT_EVIDENCE", "Credit-check results and supporting evidence have been examined."],
    ["AFFORDABILITY_VERIFIED", "Turnover and affordability calculations have been verified."],
    ["TERMS_REVIEWED", "Financing amount, tenor and applicable pricing have been reviewed."],
    ["EXCEPTIONS_DOCUMENTED", "Material exceptions have been identified and documented."],
  ]),
  CX_REVIEW: c("CX_REVIEW", 1, "CX credit review", [
    ["CUSTOMER_CONSISTENT", "Customer information has been checked for consistency."],
    ["DOCUMENTS_REVIEWED", "Required supporting documents have been reviewed."],
    ["OPERATIONAL_VERIFIED", "Applicable operational requirements have been verified."],
    ["PRIOR_OBSERVATIONS", "Previous reviewer observations have been considered."],
    ["EXCEPTIONS_DOCUMENTED", "Outstanding exceptions have been documented."],
  ]),
  CONCURRENCE: c("CONCURRENCE", 1, "Concurrence (second credit review)", [
    ["ORIGINATOR_ANALYSIS", "The originating officer's (RM's) analysis has been reviewed."],
    ["CERTIFICATION_REVIEWED", "The Team Lead certification or business endorsement has been reviewed."],
    ["FIRST_REVIEW_CONSIDERED", "The first credit review (CX) observations have been considered."],
    ["RISK_ASSESSED", "Affordability, repayment capacity and material risks have been assessed."],
    ["WITHIN_AUTHORITY", "The proposed decision is within my delegated authority."],
  ]),
  DH_FINAL: c("DH_FINAL", 1, "Divisional Head final approval", [
    ["COMPLETE_REVIEWED", "The complete application and recommendation have been reviewed."],
    ["PRIOR_APPROVALS_PRESENT", "Required preceding approvals and concurrence are present."],
    ["FINANCIALS_CONSIDERED", "Financial assessment and supporting evidence have been considered."],
    ["RISKS_REVIEWED", "Material risks, conditions and exceptions have been reviewed."],
    ["AUTHORITY_COMPLIANT", "The proposed decision complies with applicable approval authority."],
  ]),
  UNIT_HEAD: c("UNIT_HEAD", 1, "Unit Head approval", [
    ["APPLICATION_REVIEWED", "The application and the preceding recommendations have been reviewed."],
    ["CREDIT_FINDINGS", "The credit review findings and the financing assessment have been considered."],
    ["RISKS_REVIEWED", "Material risks, conditions and exceptions have been reviewed."],
    ["TERMS_WITHIN_POLICY", "The financing amount, tenor and pricing are within the approved product policy."],
    ["WITHIN_AUTHORITY", "The proposed decision is within my delegated authority."],
  ]),
  CREDIT_APPRAISAL: c("CREDIT_APPRAISAL", 1, "First credit review", [
    ["BUREAU_EXAMINED", "Credit reports and credit-check results have been examined."],
    ["ASSESSMENT_VERIFIED", "The affordability (APR / DSR) assessment for the current version has been verified."],
    ["DOCUMENTS_REVIEWED", "Required supporting documents have been reviewed."],
    ["EXCEPTIONS_DOCUMENTED", "Exceptions have been identified and documented."],
  ]),
  BUSINESS_ENDORSEMENT: c("BUSINESS_ENDORSEMENT", 1, "Business endorsement", [
    ["CUSTOMER_REVIEWED", "Customer and business details have been reviewed."],
    ["DOCUMENTS_REVIEWED", "The supporting documents have been reviewed."],
    ["AMOUNT_REASONABLE", "The requested amount is reasonable for the business."],
    ["EXCEPTIONS_NOTED", "Any exceptions have been noted."],
  ]),
  OSS_REVIEW: c("OSS_REVIEW", 1, "Outlet Service Supervisor review", [
    ["COMPLETE", "The request is complete and the customer details have been checked."],
    ["OUTLET_CONFIRMED", "The originating outlet and state details are correct."],
    ["DOCUMENTS_REVIEWED", "The customer documents and evidence have been reviewed."],
    ["EXCEPTIONS_NOTED", "Any exceptions have been noted."],
  ]),
  HRS_REVIEW: c("HRS_REVIEW", 1, "Head of Retail Sales review", [
    ["PRIOR_REVIEWED", "The preceding recommendations have been reviewed."],
    ["PRODUCT_COMPLIANT", "The request complies with the product rules."],
    ["VIABLE", "The commercial viability and proposed terms have been considered."],
    ["EXCEPTIONS_NOTED", "Material exceptions have been identified."],
  ]),
  HOU_APPROVAL: c("HOU_APPROVAL", 1, "Head of Unit business approval", [
    ["PRIOR_REVIEWED", "The preceding recommendations have been reviewed."],
    ["TERMS_REVIEWED", "The proposed terms and business case have been considered."],
    ["EXCEPTIONS_REVIEWED", "Material exceptions have been reviewed."],
    ["WITHIN_AUTHORITY", "This business approval is within my authority (it is not a credit approval)."],
  ]),
  ALT_BPM: c("ALT_BPM", 1, "BPM review (Altphones)", [
    ["CUSTOMER_REVIEWED", "The customer details and Seed Score result have been reviewed."],
    ["PAYMENT_MANDATES", "The down payment and both debit mandates are confirmed."],
    ["LOCATION_DEVICE", "The selling location and the reserved phone are correct."],
  ]),
  ALT_PM: c("ALT_PM", 1, "Product Manager review (Altphones)", [
    ["PRIOR_REVIEWED", "The application and any BPM review have been checked."],
    ["TERMS_PER_POLICY", "The price, down payment, tenor and repayments follow the approved Altphones settings."],
    ["PAYMENT_MANDATES", "The down payment and both debit mandates are confirmed."],
  ]),
  ALT_UH: c("ALT_UH", 1, "Unit Head approval (Altphones)", [
    ["PRIOR_APPROVALS", "The required preceding reviews are present."],
    ["APPLICATION_REVIEWED", "The application, credit result and terms have been reviewed."],
    ["WITHIN_AUTHORITY", "The decision is within my approval authority."],
  ]),
  STAFF_UH: c("STAFF_UH", 1, "Unit Head approval (staff financing)", [
    ["REQUEST_REVIEWED", "The request and the Product Manager's review have been checked."],
    ["AFFORDABILITY", "The deduction and the staff member's net pay have been considered."],
    ["WITHIN_AUTHORITY", "The decision is within my approval authority."],
  ]),
  STAFF_DH: c("STAFF_DH", 1, "Divisional Head approval (staff financing)", [
    ["COMPLETE_REVIEWED", "The complete request and the preceding approvals have been reviewed."],
    ["AFFORDABILITY", "The deduction and the staff member's net pay have been considered."],
    ["AUTHORITY_COMPLIANT", "The decision complies with applicable approval authority."],
  ]),
} as const satisfies Record<string, Checklist>;

export type ChecklistId = keyof typeof CHECKLISTS;

/** Positive decisions that need verification, per workflow. Return / Reject / Decline never do. */
const POSITIVE_TASK_ACTIONS = ["APPROVE", "ENDORSE", "RECOMMEND", "PROCEED"];

/** The checklist for a decision, or null when none applies. */
export function checklistFor(p: { kind: "APPLICATION" | "ALTPHONES" | "STAFF_REQUEST"; stage: string; action: string; policy?: string | null; workflow?: string | null }): Checklist | null {
  if (p.kind === "APPLICATION") {
    if (!POSITIVE_TASK_ACTIONS.includes(p.action)) return null;
    switch (p.stage) {
      case "TEAM_LEAD_REVIEW":
        return CHECKLISTS.TL_CERTIFICATION;
      case "FIRST_CREDIT_REVIEW":
        return p.policy === "RETAIL_CX_V1" ? CHECKLISTS.CX_REVIEW : CHECKLISTS.CREDIT_APPRAISAL;
      case "SECOND_CREDIT_REVIEW":
        return CHECKLISTS.CONCURRENCE;
      case "UNIT_HEAD_REVIEW":
        return CHECKLISTS.UNIT_HEAD;
      case "DIVISIONAL_HEAD_REVIEW":
        return CHECKLISTS.DH_FINAL;
      case "BUSINESS_ENDORSEMENT":
        return CHECKLISTS.BUSINESS_ENDORSEMENT;
      case "OSS_REVIEW":
        return CHECKLISTS.OSS_REVIEW;
      case "HRS_REVIEW":
        return CHECKLISTS.HRS_REVIEW;
      case "HEAD_OF_UNIT_APPROVAL":
        return CHECKLISTS.HOU_APPROVAL;
      default:
        return null;
    }
  }
  if (p.kind === "ALTPHONES") {
    if (p.action !== "APPROVE") return null;
    return p.stage === "BPM" ? CHECKLISTS.ALT_BPM : p.stage === "PM" ? CHECKLISTS.ALT_PM : p.stage === "UNIT_HEAD" ? CHECKLISTS.ALT_UH : null;
  }
  if (p.action !== "APPROVE") return null;
  return p.stage === "UNIT_HEAD" ? CHECKLISTS.STAFF_UH : p.stage === "DIVISIONAL_HEAD" ? CHECKLISTS.STAFF_DH : null;
}

/** What the browser sends with a verified decision. */
export interface VerificationInput {
  checklistId: string;
  version: number;
  items: string[];
  /** The lock version of the application the reviewer had open. */
  viewedVersion: number;
}

export function parseVerification(raw: unknown): VerificationInput | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v?.checklistId !== "string" || !Number.isInteger(v?.version) || !Array.isArray(v?.items) || !Number.isInteger(v?.viewedVersion)) return null;
    return { checklistId: v.checklistId, version: v.version, items: v.items.filter((x: unknown) => typeof x === "string").slice(0, 30), viewedVersion: v.viewedVersion };
  } catch {
    return null;
  }
}
