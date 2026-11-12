"use server";
import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { toActionError, type ActionState } from "../../_lib/action";
import {
  createStaffDraft,
  saveStaffDraft,
  submitStaffRequest,
  claimPmReview,
  releasePmReview,
  pmDecision,
  unitHeadDecision,
  divisionalHeadDecision,
  amendApproval,
} from "@/server/staff/requests";
import { removeStaffDocument } from "@/server/staff/documents";
import { submitSignedOffer, retryOfferFor, createStaffTemplateVersion } from "@/server/staff/offer";
import { reviewDisbursementDocumentation, returnSignedOffer, startDisbursement, completeDisbursement, reassignDisbursementOfficer } from "@/server/staff/disbursement";
import { confirmHandoverReceipt, completeHandoverReview, retryDocumentationNow } from "@/server/staff/pipeline";
import { proposeStaffSettings } from "@/server/staff/settings";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const lock = (fd: FormData) => (fd.get("lockVersion") ? Number(fd.get("lockVersion")) : null);
const on = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true" || fd.get(k) === "1";
type Ctx = Awaited<ReturnType<typeof requireUser>>["ctx"];

async function run(op: (ctx: Ctx) => Promise<unknown>, ok: string): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = await op(ctx);
    return { ok: true, message: ok, nonce: Date.now(), data: r && typeof r === "object" && "lockVersion" in r ? r : undefined };
  } catch (e) {
    return toActionError(e);
  }
}

export async function startStaffRequestAction(): Promise<void> {
  const { ctx } = await requireUser();
  const { id } = await createStaffDraft(ctx);
  redirect(`/staff-request/${id}?new=1`);
}

const draftInput = (fd: FormData) => ({
  staffNumber: s(fd, "staffNumber"),
  department: s(fd, "department"),
  unit: s(fd, "unit"),
  phone: s(fd, "phone"),
  salaryAccountNumber: s(fd, "salaryAccountNumber"),
  salaryAccountName: s(fd, "salaryAccountName"),
  purpose: s(fd, "purpose"),
  amount: s(fd, "amount"),
  tenorMonths: s(fd, "tenorMonths"),
  acknowledgedNetKobo: on(fd, "acknowledge") ? s(fd, "displayedNetKobo") : null,
  acceptDeclaration: on(fd, "declaration"),
  lockVersion: lock(fd),
});

/** Save, or save and submit in one step (the button pressed decides). */
export async function saveStaffDraftAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = s(fd, "id");
  const submit = s(fd, "intent") === "submit";
  const { ctx } = await requireUser();
  let ref = "";
  try {
    const saved = await saveStaffDraft(ctx, id, draftInput(fd));
    if (!submit) return { ok: true, message: "Draft saved.", nonce: Date.now(), data: saved };
    const r = await submitStaffRequest(ctx, id, { lockVersion: saved.lockVersion, acknowledgedNetKobo: on(fd, "acknowledge") ? s(fd, "displayedNetKobo") : null });
    ref = r.ref;
  } catch (e) {
    return toActionError(e);
  }
  redirect(`/staff-request/${id}?submitted=${encodeURIComponent(ref)}`);
}

export const removeStaffDocumentAction = async (_p: ActionState, fd: FormData) => run((ctx) => removeStaffDocument(ctx, s(fd, "documentId")), "Document removed.");

export const claimPmAction = async (_p: ActionState, fd: FormData) => run((ctx) => claimPmReview(ctx, s(fd, "id")), "Review started. The request is now assigned to you.");
export const releasePmAction = async (_p: ActionState, fd: FormData) => run((ctx) => releasePmReview(ctx, s(fd, "id")), "Review released back to the Product Manager queue.");

export async function pmDecisionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const action = s(fd, "decision") as "FORWARD" | "RETURN" | "DECLINE";
  const msg = { FORWARD: "Forwarded to the Unit Head.", RETURN: "Returned to the applicant for correction.", DECLINE: "Request declined." }[action] ?? "Saved.";
  return run(
    (ctx) =>
      pmDecision(ctx, s(fd, "id"), {
        action,
        checklist: { accountVerified: on(fd, "accountVerified"), salaryHistoryReviewed: on(fd, "salaryHistoryReviewed"), repaymentWithinLimit: on(fd, "repaymentWithinLimit") },
        verifiedTakeHome: s(fd, "verifiedTakeHome"),
        monthlyRepayment: s(fd, "monthlyRepayment"),
        recommendation: s(fd, "recommendation"),
        comments: s(fd, "comments"),
        confirmed: on(fd, "confirmed"),
        lockVersion: lock(fd),
      }),
    msg,
  );
}

export async function headDecisionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const action = s(fd, "decision") as "APPROVE" | "RETURN" | "DECLINE";
  const level = s(fd, "level");
  const input = { action, comments: s(fd, "comments"), confirmed: on(fd, "confirmed"), lockVersion: lock(fd) };
  const msg =
    action === "APPROVE" ? (level === "DH" ? "Final approval recorded. The offer letter step has started." : "Approved and forwarded to the Divisional Head.") : action === "RETURN" ? "Returned to the applicant for clarification." : "Request declined.";
  return run((ctx) => (level === "DH" ? divisionalHeadDecision(ctx, s(fd, "id"), input) : unitHeadDecision(ctx, s(fd, "id"), input)), msg);
}

export const amendAction = async (_p: ActionState, fd: FormData) => run((ctx) => amendApproval(ctx, s(fd, "id"), { reason: s(fd, "reason"), lockVersion: lock(fd) }), "Approval withdrawn for amendment. The request is back with the applicant.");

export const submitSignedOfferAction = async (_p: ActionState, fd: FormData) =>
  run((ctx) => submitSignedOffer(ctx, s(fd, "id"), { documentId: s(fd, "documentId"), confirmed: on(fd, "confirmed"), lockVersion: lock(fd) }), "Signed offer submitted. It now goes to a Disbursement Officer.");

export const reviewDocsAction = async (_p: ActionState, fd: FormData) => run((ctx) => reviewDisbursementDocumentation(ctx, s(fd, "id"), { lockVersion: lock(fd) }), "Documentation review recorded.");
export const returnSignedOfferAction = async (_p: ActionState, fd: FormData) => run((ctx) => returnSignedOffer(ctx, s(fd, "id"), { reason: s(fd, "reason"), lockVersion: lock(fd) }), "Returned to the applicant for correction.");
export const startDisbursementAction = async (_p: ActionState, fd: FormData) =>
  run((ctx) => startDisbursement(ctx, s(fd, "id"), { instructionRef: s(fd, "instructionRef"), lockVersion: lock(fd) }), "Disbursement marked as in progress.");
export const completeDisbursementAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) =>
      completeDisbursement(ctx, s(fd, "id"), {
        transactionRef: s(fd, "transactionRef"),
        valueDate: s(fd, "valueDate"),
        amount: s(fd, "amount"),
        evidenceDocumentId: s(fd, "evidenceDocumentId"),
        confirmed: on(fd, "confirmed"),
        lockVersion: lock(fd),
      }),
    "Disbursement completed. Documentation packaging has started.",
  );
export const reassignAction = async (_p: ActionState, fd: FormData) => run((ctx) => reassignDisbursementOfficer(ctx, s(fd, "id"), { officerId: s(fd, "officerId"), reason: s(fd, "reason") }), "Disbursement Officer assigned.");

export const confirmReceiptAction = async (_p: ActionState, fd: FormData) => run((ctx) => confirmHandoverReceipt(ctx, s(fd, "id"), s(fd, "group")), "Receipt confirmed.");
export const completeReviewAction = async (_p: ActionState, fd: FormData) => run((ctx) => completeHandoverReview(ctx, s(fd, "id"), s(fd, "group"), s(fd, "comments")), "Review recorded.");

export const retryOfferAction = async (_p: ActionState, fd: FormData) => run((ctx) => retryOfferFor(ctx, s(fd, "id")), "Offer letter generated and issued.");
export const retryDocumentationAction = async (_p: ActionState, fd: FormData) => run((ctx) => retryDocumentationNow(ctx, s(fd, "id")), "Documentation step run. See the status below.");

export const staffTemplateAction = async (_p: ActionState, fd: FormData) =>
  run((ctx) => createStaffTemplateVersion(ctx, { bodyHtml: String(fd.get("bodyHtml") ?? ""), notes: s(fd, "notes") }), "Template version saved as a draft. Activate it and record the bank's approval on Offer templates.");
export const staffSettingsAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) =>
      proposeStaffSettings(ctx, {
        deductionPercent: s(fd, "deductionPercent"),
        minAmount: s(fd, "minAmount"),
        maxAmount: s(fd, "maxAmount"),
        tenorOptions: s(fd, "tenorOptions"),
        requiredDocuments: fd.getAll("requiredDocuments").map(String),
        unitHeadId: s(fd, "unitHeadId") || null,
        reason: s(fd, "reason"),
      }),
    "New settings version saved. It applies to drafts and resubmissions from now on.",
  );
