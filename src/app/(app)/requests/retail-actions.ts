"use server";
import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { toActionError, type ActionState } from "../../_lib/action";
import { createRetailDraft, saveRetailDraft, saveProposal, requestException, decideException, recordFinalAssessment, withdrawApplication, setSuspension, type ProposalContent } from "@/server/domain/retail";
import { submitApplication, performTaskAction } from "@/server/domain/workflow";
import { proposeBeneficiary } from "@/server/domain/vendors";
import { recordPaymentEvent, recordFulfilmentTask, recordRepayment, recordServicingAction, closeFacility, decideRestructure } from "@/server/domain/retail-ops";
import { reviewDocument } from "@/server/domain/documents";
import { runRetailCreditCheck } from "@/server/domain/retail-credit";
import { invalid } from "@/server/errors";
import { parseNairaToKobo } from "@/server/money";
import type { ApplicantType } from "@/server/domain/application-data";
import type { FulfilmentKind } from "@/server/domain/products";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const kobo = (v: string | null | undefined, field: string, fields: Record<string, string>, label: string) => {
  if (v === null || v === undefined || v === "") return null;
  const k = parseNairaToKobo(v);
  if (k === null) fields[field] = `${label}: enter a naira amount with at most 2 decimal places.`;
  return k;
};

export async function createRetailDraftAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  let id: string;
  try {
    id = (
      await createRetailDraft(ctx, {
        initiatorRole: str(fd, "initiatorRole"),
        productCode: str(fd, "productCode"),
        profile: str(fd, "profile"),
        structure: str(fd, "structure") || null,
        applicantType: str(fd, "applicantType") as ApplicantType,
      })
    ).id;
  } catch (e) {
    return toActionError(e);
  }
  redirect(`/requests/${id}/edit`);
}

interface RetailPayload {
  data: Record<string, unknown>;
  money: Record<string, string>;
  obligations: { lender: string; facilityType: string; monthly: string; outstanding: string }[];
  salaryHistory: { month: string; amount: string }[];
  directors: { id?: string | null; fullName: string; bvn: string }[];
  bvn: string;
  tin: string;
  structure: string;
  tenor: string;
  yearsInOperation: string;
  expectedLockVersion: number | null;
}

function parseRetailPayload(raw: string) {
  const p = JSON.parse(raw) as RetailPayload;
  const fields: Record<string, string> = {};
  const m = (k: string, label: string) => kobo(p.money[k], k, fields, label);
  const money = {
    requestedAmountKobo: m("requestedAmountKobo", "Requested amount"),
    assetCostKobo: m("assetCostKobo", "Asset cost"),
    equityContributionKobo: m("equityContributionKobo", "Equity contribution"),
    incomeBasisKobo: m("incomeBasisKobo", "Income basis"),
    proposedMonthlyObligationKobo: m("proposedMonthlyObligationKobo", "Proposed monthly repayment"),
    statedMonthlySalaryKobo: m("statedMonthlySalaryKobo", "Monthly salary"),
    statedMonthlyTurnoverKobo: m("statedMonthlyTurnoverKobo", "Monthly turnover"),
    turnoverForCapKobo: m("turnoverForCapKobo", "Turnover for cap"),
  };
  const existingObligations = p.obligations
    .filter((o) => o.lender || o.monthly)
    .map((o, i) => ({
      lender: o.lender.trim(),
      facilityType: o.facilityType.trim(),
      monthlyRepaymentKobo: kobo(o.monthly, `obligations.${i}.monthly`, fields, `Obligation ${i + 1} monthly repayment`) ?? 0,
      outstandingKobo: kobo(o.outstanding, `obligations.${i}.outstanding`, fields, `Obligation ${i + 1} outstanding balance`),
    }));
  existingObligations.forEach((o, i) => {
    if (!o.lender) fields[`obligations.${i}.lender`] = `Obligation ${i + 1}: enter the lender.`;
  });
  const salaryHistory = p.salaryHistory
    .filter((s) => s.month || s.amount)
    .map((s, i) => {
      if (!/^\d{4}-\d{2}$/.test(s.month)) fields[`salaryHistory.${i}.month`] = `Salary month ${i + 1}: choose the month.`;
      return { month: s.month, amountKobo: kobo(s.amount, `salaryHistory.${i}.amount`, fields, `Salary month ${i + 1}`) ?? 0 };
    });
  if (Object.keys(fields).length) throw invalid("Some fields are not valid.", fields);
  const tenor = p.tenor ? Number.parseInt(p.tenor, 10) : null;
  const years = p.yearsInOperation ? Number.parseInt(p.yearsInOperation, 10) : null;
  return {
    data: { ...p.data, ...money, existingObligations, salaryHistory, tenorMonths: Number.isFinite(tenor) ? tenor : null, yearsInOperation: Number.isFinite(years) ? years : null },
    structure: p.structure || null,
    bvn: p.bvn || null,
    tin: p.tin || null,
    directors: p.directors,
    expectedLockVersion: p.expectedLockVersion,
  };
}

export async function saveRetailDraftAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const appId = str(fd, "applicationId");
  const intent = str(fd, "intent");
  let savedAt = "";
  try {
    const parsed = parseRetailPayload(str(fd, "payload"));
    const r = await saveRetailDraft(ctx, appId, { data: parsed.data, structure: parsed.structure, bvn: parsed.bvn, tin: parsed.tin, directors: parsed.directors });
    savedAt = r.savedAt;
    if (intent === "submit") {
      const taskId = str(fd, "taskId");
      if (taskId) await performTaskAction(ctx, { taskId, action: "RESUBMIT", idempotencyKey: str(fd, "idempotencyKey") });
      else await submitApplication(ctx, appId, str(fd, "idempotencyKey"));
    }
  } catch (e) {
    return toActionError(e);
  }
  if (intent === "submit") redirect(`/requests/${appId}?submitted=1`);
  return { ok: true, message: "Draft saved.", data: { savedAt }, nonce: Date.now() };
}

export async function saveProposalAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const content: Partial<ProposalContent> = {};
    for (const [k, v] of fd.entries()) if (k.startsWith("p_") && typeof v === "string") (content as Record<string, string>)[k.slice(2)] = v;
    const r = await saveProposal(ctx, str(fd, "applicationId"), content);
    return { ok: true, message: `Credit proposal saved (version ${r.versionNo}).`, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function proposeBeneficiaryAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = await proposeBeneficiary(ctx, str(fd, "applicationId"), {
      vendorId: str(fd, "vendorId") || null,
      name: str(fd, "vendorName"),
      email: str(fd, "vendorEmail"),
      phone: str(fd, "vendorPhone"),
      institutionId: str(fd, "institutionId"),
      accountNumber: str(fd, "accountNumber"),
      accountName: str(fd, "accountName"),
    });
    return { ok: true, message: "Vendor account captured. It is pending verification by the vendor register team and cannot be used for payment until verified.", data: r, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function requestExceptionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await requestException(ctx, str(fd, "applicationId"), { type: str(fd, "type") as "AFS" | "DSR", reason: str(fd, "reason"), evidenceDocumentIds: fd.getAll("evidence").map(String) });
    return { ok: true, message: "Exception requested. The configured authority has been notified.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function decideExceptionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const approve = str(fd, "decision") === "APPROVE";
    await decideException(ctx, str(fd, "exceptionId"), approve, str(fd, "note"));
    return { ok: true, message: approve ? "Exception approved." : "Exception declined.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function finalAssessmentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const fields: Record<string, string> = {};
    const lenders = fd.getAll("ob_lender").map(String);
    const monthly = fd.getAll("ob_monthly").map(String);
    const obligations = lenders
      .map((l, i) => ({ lender: l.trim(), monthlyRepaymentKobo: kobo(monthly[i], `ob.${i}`, fields, `Obligation ${i + 1}`) ?? 0 }))
      .filter((o) => o.lender || o.monthlyRepaymentKobo);
    const chargeLabels = fd.getAll("ch_label").map(String);
    const chargeAmounts = fd.getAll("ch_amount").map(String);
    const charges = chargeLabels.map((l, i) => ({ label: l.trim(), amountKobo: kobo(chargeAmounts[i], `ch.${i}`, fields, `Charge ${i + 1}`) ?? 0 })).filter((c) => c.label && c.amountKobo);
    const income = kobo(str(fd, "incomeBasis"), "incomeBasisKobo", fields, "Verified income basis");
    const principal = kobo(str(fd, "principal"), "principalKobo", fields, "Principal");
    const turnover = kobo(str(fd, "turnoverForCap"), "turnoverForCapKobo", fields, "Turnover for cap");
    if (Object.keys(fields).length) throw invalid("Check the assessment inputs.", fields);
    const r = await recordFinalAssessment(ctx, str(fd, "applicationId"), {
      incomeBasisKobo: income,
      incomeBasisNote: str(fd, "incomeBasisNote"),
      statementFrom: str(fd, "statementFrom") || null,
      statementTo: str(fd, "statementTo") || null,
      principalKobo: principal,
      tenorMonths: Number.parseInt(str(fd, "tenor"), 10) || null,
      existingObligations: obligations,
      charges,
      turnoverForCapKobo: turnover,
    });
    return { ok: true, message: r.result === "PASS" ? `Final assessment saved: PASS (DSR ${r.dsr}%).` : r.result === "BLOCKED" ? `Saved, but blocked: ${r.blocked.join(" ")}` : `Final assessment saved: FAIL${r.dsr ? ` (DSR ${r.dsr}%)` : ""}.`, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function withdrawAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await withdrawApplication(ctx, str(fd, "applicationId"), str(fd, "reason"));
    return { ok: true, message: "Request withdrawn.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function suspensionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const suspend = str(fd, "mode") === "suspend";
    await setSuspension(ctx, str(fd, "applicationId"), suspend, str(fd, "reason"));
    return { ok: true, message: suspend ? "Request suspended." : "Request resumed.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function paymentEventAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const fields: Record<string, string> = {};
    const amount = kobo(str(fd, "amount"), "amount", fields, "Amount");
    if (Object.keys(fields).length) throw invalid("Check the payment details.", fields);
    const r = await recordPaymentEvent(ctx, str(fd, "applicationId"), {
      eventType: str(fd, "eventType") as "INITIATED" | "CONFIRMED" | "FAILED" | "REVERSED",
      amountKobo: amount ?? -1,
      paymentRef: str(fd, "paymentRef"),
      valueDate: str(fd, "valueDate") || null,
      evidenceDocumentIds: fd.getAll("evidence").map(String),
      note: str(fd, "note"),
    });
    return { ok: true, message: r.duplicate ? "This payment event was already recorded (no change)." : `Recorded. Payment status: ${r.position.status.toLowerCase()}.`, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function fulfilmentTaskAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = await recordFulfilmentTask(ctx, str(fd, "applicationId"), str(fd, "kind") as FulfilmentKind, { evidenceDocumentIds: fd.getAll("evidence").map(String), note: str(fd, "note") });
    return { ok: true, message: r.duplicate ? "Already completed." : "Fulfilment task completed.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function repaymentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const fields: Record<string, string> = {};
    const amount = kobo(str(fd, "amount"), "amount", fields, "Amount");
    if (Object.keys(fields).length) throw invalid("Check the repayment details.", fields);
    const r = await recordRepayment(ctx, str(fd, "facilityId"), { eventType: str(fd, "eventType") === "REVERSED" ? "REVERSED" : "RECEIVED", amountKobo: amount ?? -1, valueDate: str(fd, "valueDate"), reference: str(fd, "reference"), evidenceDocumentIds: fd.getAll("evidence").map(String) });
    return { ok: true, message: r.duplicate ? "Already recorded (no change)." : "Repayment recorded.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function servicingAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const kind = str(fd, "kind") as "ARREARS_FOLLOW_UP" | "RECOVERY_NOTE" | "RESTRUCTURE_REQUEST";
    await recordServicingAction(ctx, str(fd, "facilityId"), { kind, note: str(fd, "note"), proposal: kind === "RESTRUCTURE_REQUEST" ? { proposedTerms: str(fd, "proposedTerms") } : null });
    return { ok: true, message: kind === "RESTRUCTURE_REQUEST" ? "Restructure requested from the configured authority." : "Recorded.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function restructureDecisionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await decideRestructure(ctx, str(fd, "actionId"), str(fd, "decision") === "APPROVE", str(fd, "note"));
    return { ok: true, message: "Decision recorded.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function closeFacilityAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await closeFacility(ctx, str(fd, "facilityId"));
    return { ok: true, message: "Facility closed.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function reviewDocumentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const decision = str(fd, "decision") === "REJECTED" ? "REJECTED" : "ACCEPTED";
    await reviewDocument(ctx, str(fd, "documentId"), decision, str(fd, "reason"));
    return { ok: true, message: decision === "REJECTED" ? "Document marked as rejected." : "Document accepted.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function retailCreditAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = await runRetailCreditCheck(ctx, str(fd, "applicationId"), str(fd, "personKey"), {
      firstName: str(fd, "firstName"),
      lastName: str(fd, "lastName"),
      dateOfBirth: str(fd, "dateOfBirth"),
      gender: str(fd, "gender"),
      phone: str(fd, "phone"),
      consent: fd.get("consent") === "on",
    });
    return { ok: r.outcome !== "UNAVAILABLE", error: r.outcome === "UNAVAILABLE" ? r.message : null, message: r.outcome === "UNAVAILABLE" ? null : r.message, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
