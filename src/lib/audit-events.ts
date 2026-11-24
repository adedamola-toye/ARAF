/**
 * Readable audit history: turns raw audit event codes into plain-English descriptions an officer can follow
 * without reading technical logs. Shared by the request timeline, the system audit page and CSV exports.
 */

export type AuditCategory = "Application" | "Documents" | "Assessment" | "Decision" | "Assignment" | "Bouquet" | "Offer" | "Disbursement" | "Repayment" | "Records" | "Configuration" | "Access" | "Other";

export const AUDIT_CATEGORIES: AuditCategory[] = ["Application", "Documents", "Assessment", "Decision", "Assignment", "Bouquet", "Offer", "Disbursement", "Repayment", "Records", "Configuration", "Access", "Other"];

const LABELS: Record<string, [string, AuditCategory]> = {
  DRAFT_CREATED: ["Application started", "Application"],
  DRAFT_SAVED: ["Draft saved", "Application"],
  DRAFT_DELETED: ["Draft deleted", "Application"],
  DRAFT_EXPIRED: ["Draft expired", "Application"],
  REQUEST_SUBMITTED: ["Application submitted", "Application"],
  REQUEST_RESUBMITTED: ["Application resubmitted after correction", "Application"],
  REQUEST_WITHDRAWN: ["Application withdrawn", "Application"],
  STAGE_CHANGED: ["Moved to the next stage", "Application"],
  ROUTE_RECALCULATED: ["Credit route recalculated", "Application"],
  DUPLICATE_CUSTOMER_WARNING: ["Possible duplicate customer flagged", "Application"],
  CASE_VIEW: ["Request opened", "Access"],
  SENSITIVE_REVEAL: ["Identifiers revealed", "Access"],
  DOCUMENT_UPLOADED: ["Document uploaded", "Documents"],
  DOCUMENT_SCAN_CLEAN: ["Document passed the security scan", "Documents"],
  DOCUMENT_REJECTED_BY_SCAN: ["Document rejected by the security scan", "Documents"],
  DOCUMENT_SCAN_FAILED: ["Document scan could not run", "Documents"],
  DOCUMENT_REMOVED: ["Document removed", "Documents"],
  DOCUMENT_VIEW: ["Document viewed", "Access"],
  DOCUMENT_DOWNLOAD: ["Document downloaded", "Access"],
  DOCUMENT_UPLOAD_DENIED: ["Document upload refused", "Documents"],
  DOCUMENT_SIGNED_ON_DEVICE: ["Document signed on a device", "Documents"],
  CLOSING_DOCUMENT_GENERATED: ["Closing document generated", "Documents"],
  ASSESSMENT_RECORDED: ["Credit assessment recorded", "Assessment"],
  PRELIMINARY_ASSESSMENT_RECORDED: ["Preliminary assessment recorded", "Assessment"],
  FINAL_ASSESSMENT_RECORDED: ["Final credit assessment recorded", "Assessment"],
  CREDIT_PROPOSAL_SAVED: ["Credit proposal saved", "Assessment"],
  CREDIT_CHECK_COMPLETED: ["Credit bureau check completed", "Assessment"],
  CREDIT_CHECK_UNAVAILABLE: ["Credit bureau unavailable: not assessed", "Assessment"],
  CREDIT_CHECK_FAILED: ["Credit bureau check failed", "Assessment"],
  CREDIT_EXCEPTION_RAISED: ["Credit score exception raised", "Assessment"],
  CREDIT_EXCEPTION_ACKNOWLEDGED: ["Credit score exception acknowledged", "Assessment"],
  DSR_EXCEPTION_APPROVED: ["DSR exception approved with evidence", "Assessment"],
  APPROVAL_VERIFIED: ["Verification checklist confirmed", "Decision"],
  APPROVALS_INVALIDATED: ["Earlier approvals invalidated by a material change", "Decision"],
  TASK_APPROVE: ["Approved", "Decision"],
  TASK_PROCEED: ["Approved (proceed)", "Decision"],
  TASK_ENDORSE: ["Endorsed", "Decision"],
  TASK_RECOMMEND: ["Recommended", "Decision"],
  TASK_REJECT: ["Declined", "Decision"],
  TASK_RETURN: ["Returned for correction", "Decision"],
  TASK_REQUEST_INITIATOR: ["Returned to the initiator", "Decision"],
  TASK_SEND_FOR_CORRECTION: ["Sent for correction", "Decision"],
  TASK_RESUBMIT: ["Resubmitted", "Decision"],
  TASK_ASSIGNED: ["Assigned", "Assignment"],
  TASK_REASSIGNED: ["Reassigned", "Assignment"],
  TASK_UNASSIGNED: ["Unassigned", "Assignment"],
  TASK_UNASSIGNED_NO_ELIGIBLE_STAFF: ["No eligible officer: waiting for assignment", "Assignment"],
  ASSIGNED_RM_SET: ["Relationship Manager assigned", "Assignment"],
  SLA_REMINDER_SENT: ["Service-level reminder sent", "Assignment"],
  SLA_ESCALATED: ["Escalated for exceeding the service level", "Assignment"],
  BOUQUET_CREATED: ["Facility bouquet created", "Bouquet"],
  BOUQUET_MEMBER_ADDED: ["Added to a facility bouquet", "Bouquet"],
  BOUQUET_MEMBER_LEFT: ["Left the facility bouquet", "Bouquet"],
  BOUQUET_MEMBER_REFRESHED: ["Bouquet entry refreshed after a change", "Bouquet"],
  BOUQUET_SAMPLED: ["Selected by random sample", "Bouquet"],
  BOUQUET_MEMBER_INSPECTED: ["Inspected by the Divisional Head", "Bouquet"],
  BOUQUET_MEMBER_EXCLUDED: ["Excluded from the bouquet", "Bouquet"],
  BOUQUET_MEMBER_RESTORED: ["Restored to the bouquet", "Bouquet"],
  BOUQUET_CONCURRED: ["Bouquet concurrence recorded", "Bouquet"],
  OFFER_GENERATED: ["Offer letter generated", "Offer"],
  OFFER_ISSUED: ["Offer letter issued", "Offer"],
  OFFER_EXPIRED: ["Offer expired", "Offer"],
  SIGNED_OFFER_RECEIVED: ["Signed offer received", "Offer"],
  TASK_SUBMIT_PACK: ["Offer pack submitted", "Offer"],
  TASK_FORWARD: ["Pack forwarded", "Offer"],
  TASK_OKAY: ["Pre-disbursement checks confirmed", "Disbursement"],
  TASK_DISBURSED: ["Disbursement recorded", "Disbursement"],
  DISBURSEMENT_RECORDED: ["Disbursement recorded with transaction reference", "Disbursement"],
  DISBURSEMENT_HELD: ["Disbursement put on hold", "Disbursement"],
  DISBURSEMENT_HOLD_RELEASED: ["Disbursement hold released", "Disbursement"],
  DISBURSEMENT_ATTEMPT_FAILED: ["Payment posting failed", "Disbursement"],
  DISBURSEMENT_ATTEMPT_UNCERTAIN: ["Payment outcome uncertain", "Disbursement"],
  DISBURSEMENT_ATTEMPT_RESOLVED: ["Uncertain payment verified", "Disbursement"],
  FACILITY_BOOKED: ["Facility booked", "Disbursement"],
  PAYMENT_INITIATED: ["Payment initiated", "Disbursement"],
  PAYMENT_CONFIRMED: ["Payment confirmed", "Disbursement"],
  PAYMENT_RECONCILED: ["Payment reconciled", "Disbursement"],
  TASK_COMPLETE_PROCESS: ["Process completed", "Records"],
  TASK_CONFIRM_VENDOR_PAYMENT: ["Vendor payment confirmed", "Disbursement"],
  REPAYMENT_RECORDED: ["Repayment recorded", "Repayment"],
  REPAYMENT_REVERSED: ["Repayment reversed", "Repayment"],
  STATEMENT_ANALYSIS_INITIATED: ["Automatic Statement Analysis started", "Assessment"],
  STATEMENT_ANALYSIS_COMPLETED: ["Statement analysis completed", "Assessment"],
  STATEMENT_ANALYSIS_PARTIALLY_COMPLETED: ["Statement analysis partly completed", "Assessment"],
  STATEMENT_ANALYSIS_REQUIRES_VERIFICATION: ["Statement analysis needs verification", "Assessment"],
  STATEMENT_ANALYSIS_FAILED: ["Statement analysis failed", "Assessment"],
  STATEMENT_ANALYSIS_RETRIED: ["Statement analysis retried", "Assessment"],
  PERICULUM_WEBHOOK_SIGNATURE_MISMATCH: ["Periculum notification with an invalid signature", "Access"],
  STAFF_ADVANCE_REPAYMENT_RECORDED: ["Salary advance repayment recorded", "Repayment"],
  REPAYMENT_PROMPTS_ACTIVATED: ["Repayment reminders activated", "Repayment"],
  FULLY_REPAID: ["Fully repaid", "Repayment"],
  CLOSURE_PACK_QUEUED: ["Closure pack queued for Legal and Shariah", "Records"],
  FACILITY_ARCHIVE_CREATED: ["Facility archive created", "Records"],
  SENT_TO_LEGAL_SHARIAH: ["Sent to Legal and Shariah for review", "Records"],
  INVOICE_CONFIRMATION_DISPATCHED: ["Invoice sent for confirmation", "Assessment"],
  INVOICE_CONFIRMATION_COMPLETED: ["Invoice confirmed with the issuer", "Assessment"],
  INVOICE_CONFIRMATION_RETURNED: ["Invoice confirmation returned", "Assessment"],
  VF_BUSINESS_PHOTO_UPLOADED: ["Business photograph uploaded", "Documents"],
  VF_BUSINESS_PHOTO_SKIPPED: ["Business photograph skipped with reason", "Documents"],
  FEATURE_SWITCH_CHANGED: ["Feature switch changed", "Configuration"],
  BOUQUET_SETTINGS_CHANGED: ["Bouquet settings changed", "Configuration"],
  PRODUCT_RULES_PUBLISHED: ["Product rules published", "Configuration"],
  PRICING_SETTINGS_CHANGED: ["Pricing settings changed", "Configuration"],
  STAFF_FIN_SETTINGS_CHANGED: ["Salary advance settings changed", "Configuration"],
  APPROVAL_WORKFLOW_PUBLISHED: ["Approval workflow published", "Configuration"],
  ROLE_GRANTED: ["Role granted", "Access"],
  ROLE_REVOKED: ["Role revoked", "Access"],
  STAFF_UPDATED: ["Staff profile updated", "Access"],
  LOGIN: ["Signed in", "Access"],
  WORKSPACE_SWITCH: ["Switched workspace", "Access"],
};

const humanise = (code: string) => {
  const s = code.replace(/^TASK_/, "").toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function auditLabel(action: string): { label: string; category: AuditCategory } {
  const hit = LABELS[action];
  if (hit) return { label: hit[0], category: hit[1] };
  const category: AuditCategory = /BOUQUET/.test(action)
    ? "Bouquet"
    : /DISBURSE|PAYMENT/.test(action)
      ? "Disbursement"
      : /REPAY/.test(action)
        ? "Repayment"
        : /DOCUMENT|PHOTO|ARCHIVE/.test(action)
          ? "Documents"
          : /OFFER|SIGNED/.test(action)
            ? "Offer"
            : /SETTINGS|CONFIG|TEMPLATE|SWITCH|POLICY|WORKFLOW|RULES/.test(action)
              ? "Configuration"
              : /^TASK_/.test(action)
                ? "Decision"
                : /ROLE|LOGIN|ACCESS|OTP|VIEW|REVEAL/.test(action)
                  ? "Access"
                  : "Other";
  return { label: humanise(action), category };
}

export function categoryActions(cat: AuditCategory): string[] {
  return Object.entries(LABELS)
    .filter(([, v]) => v[1] === cat)
    .map(([k]) => k);
}

/** Keys whose values never appear in readable history or exports. */
const SECRET_KEY = /^(sig|nin|bvn|bvn_?hash|otp|otp_?code|code_?hash|salary|salary_?kobo|monthly_?salary(_?kobo)?|account_?number|.*token.*|.*secret.*|.*password.*)$/i;

/** Redact secrets and sensitive identifiers from event details before display or export. */
export function redactDetails(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) out[k] = "[redacted]";
    else if (v && typeof v === "object" && !Array.isArray(v)) out[k] = redactDetails(v);
    else if (typeof v === "string" && /^\d{10,11}$/.test(v)) out[k] = `••••${v.slice(-4)}`;
    else out[k] = v;
  }
  return out;
}

/** Previous and new state, a reference worth showing, and the transaction or bouquet reference where present. */
export function auditContext(details: unknown, stageLabel: (s: string) => string): string[] {
  const d = (details ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  if (typeof d.from === "string" && typeof d.to === "string") out.push(`${stageLabel(d.from)} → ${stageLabel(d.to)}`);
  else if (typeof d.nextStage === "string") out.push(`next: ${stageLabel(d.nextStage)}`);
  const bq = (d.bouquet as { ref?: string } | undefined)?.ref ?? (typeof d.ref === "string" && /^BQ-/.test(d.ref) ? d.ref : null);
  if (bq) out.push(`bouquet ${bq}`);
  for (const k of ["transactionRef", "attemptedRef", "reference"]) if (typeof d[k] === "string") out.push(`ref ${d[k]}`);
  if (typeof d.category === "string") out.push(String(d.category).toLowerCase().replace(/_/g, " "));
  if (typeof d.filename === "string") out.push(String(d.filename));
  if (typeof d.exclusionAction === "string") out.push(d.exclusionAction === "RETURN_FOR_CORRECTION" ? "returned for correction" : "held for individual review");
  return out;
}
