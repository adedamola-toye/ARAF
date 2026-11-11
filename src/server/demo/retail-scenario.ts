/**
 * Synthetic retail journeys (tests and `npm run demo:retail`). Uses the real domain functions only.
 * The configuration applied by `configureForTesting` is SYNTHETIC: it fills parameters the bank has not
 * supplied so the full lifecycle can be exercised. It must never be used as real policy.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { ctxFor, makePdf, openTaskOf, act } from "./scenario";
import { uploadDocument } from "../domain/documents";
import { proposeProductConfig, decideProductConfig, effectiveConfig, INITIAL_PRODUCT_CONFIGS, type ProductConfig } from "../domain/products";
import { createRetailDraft, saveRetailDraft, saveProposal, recordFinalAssessment, PROPOSAL_FIELDS, type ProposalContent } from "../domain/retail";
import { submitApplication, performTaskAction } from "../domain/workflow";
import { generateOffer } from "../domain/offer";
import { recordPaymentEvent, recordFulfilmentTask } from "../domain/retail-ops";
import { addDaysToDateString, lagosDate } from "../time";
import type { ApplicantType } from "../domain/application-data";
import type { RetailData } from "../domain/retail-data";

export const JPEG = (seed: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`synthetic-photo-${seed}-${randomUUID()}`)]);

export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

/** Propose (Super Admin) and approve (configuration approver) a configuration version, effective now. */
export async function applyConfig(productCode: string, config: ProductConfig, reason = "SYNTHETIC TEST CONFIGURATION", now = new Date()) {
  const sa = await ctxFor("superadmin@altbank.ng", now);
  const { id } = await proposeProductConfig(sa, { productCode, config, effectiveFrom: new Date(now.getTime() - 60_000), reason });
  await decideProductConfig(await ctxFor("config.approver@altbank.ng", now), { configId: id, approve: true, note: "Approved for synthetic testing" });
  return id;
}

/** Synthetic values for every parameter the bank has not supplied (tests / demo only). */
export function syntheticConfig(productCode: string, tweak?: (c: ProductConfig) => void): ProductConfig {
  const c = clone(INITIAL_PRODUCT_CONFIGS[productCode]);
  for (const [profile, r] of Object.entries(c.profiles)) {
    if (!r) continue;
    r.maxAmountKobo ??= 3_000_000_000;
    r.maxTenorMonths ??= 48;
    r.dsr.maxPercent ??= "33";
    r.dsr.denominator ??= profile === "SALARY_EARNER" ? "VERIFIED_MONTHLY_NET_SALARY" : "AVERAGE_MONTHLY_BUSINESS_TURNOVER";
    r.statementMonths ??= 6;
    if (profile === "SALARY_EARNER") r.payslipMonths ??= 3;
    if (r.equityContribution.applies === null) r.equityContribution = { applies: false, minPercent: null };
    if (r.assetEligibility.required && !r.assetEligibility.criteria) r.assetEligibility.criteria = "SYNTHETIC: asset as described on the invoice";
    r.visitRequired ??= true;
    if (r.afs) r.afs.exceptionApproverRole ??= "HEAD_OF_RETAIL_SALES";
    if (!r.structures.length) r.structures = [{ code: "STANDARD", ratePercent: "20", rateConvention: "FLAT_PER_ANNUM", insuranceBearer: "NOT_APPLICABLE", contractSequence: [] }];
    for (const s of r.structures) {
      s.rateConvention ??= "FLAT_PER_ANNUM";
      s.insuranceBearer ??= "NOT_APPLICABLE";
      s.contractSequence ??= s.code === "MURABAHA" ? ["Bank purchases the asset from the vendor", "Bank sells the asset to the customer"] : [];
    }
  }
  c.servicing.restructureApproverRole ??= "HEAD_OF_RETAIL_SALES";
  tweak?.(c);
  return c;
}

export const INITIATORS = { RM: "rm.bola@altbank.ng", DO: "do.ife@altbank.ng" } as const;

export interface RetailCaseOpts {
  channel: "RM" | "DO";
  product: string;
  profile: "SALARY_EARNER" | "BUSINESS_OWNER";
  structure?: string | null;
  type?: ApplicantType;
  amountKobo: number;
  tenorMonths?: number;
  incomeBasisKobo?: number;
  obligations?: { lender: string; monthlyRepaymentKobo: number }[];
  proposedMonthlyKobo?: number | null;
  skipDocs?: string[];
  photos?: "FULL" | "THREE" | "NO_RM" | "RM_BY_DO";
  withAfs?: boolean;
  outlet?: string;
  assignedRm?: string;
  data?: Partial<RetailData>;
  now?: Date;
  submit?: boolean;
}

export async function staffId(email: string) {
  return (await db.query("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id as string;
}

export async function vendorAccount(vendorName = "Synthetic Distributors Ltd") {
  return (await db.query("SELECT v.id AS vendor_id, va.id AS account_id FROM vendors v JOIN vendor_accounts va ON va.vendor_id = v.id WHERE v.name = $1", [vendorName])).rows[0] as { vendor_id: string; account_id: string };
}

export function fullProposal(): ProposalContent {
  return Object.fromEntries(PROPOSAL_FIELDS.map((f) => [f.key, `Synthetic ${f.label.toLowerCase()} written for testing purposes.`])) as unknown as ProposalContent;
}

/** Create (and by default submit) a retail case with every requirement satisfied unless told otherwise. */
export async function createRetailCase(o: RetailCaseOpts) {
  const now = o.now ?? new Date();
  const initiatorEmail = INITIATORS[o.channel];
  const ctx = await ctxFor(initiatorEmail, now);
  const type: ApplicantType = o.type ?? (o.profile === "SALARY_EARNER" ? "INDIVIDUAL" : "ENTERPRISE");
  const { id } = await createRetailDraft(ctx, { initiatorRole: o.channel === "RM" ? "RM" : "DELIGHT_OFFICER", productCode: o.product, profile: o.profile, structure: o.structure ?? null, applicantType: type });
  const v = await vendorAccount(o.product === "ALT_DRIVE" ? "Synthetic Motors Ltd" : o.product === "ALT_POWER" ? "Synthetic Solar Ltd" : "Synthetic Distributors Ltd");
  const outlet = o.channel === "DO" ? (await db.query("SELECT id FROM locations WHERE name = $1", [o.outlet ?? "Yaba Altbox"])).rows[0].id : null;
  const rmId = o.channel === "DO" ? await staffId(o.assignedRm ?? "rm.bola@altbank.ng") : null;
  const today = lagosDate(now);
  await saveRetailDraft(ctx, id, {
    data: {
      customerName: "Amina Bello",
      businessName: type === "ENTERPRISE" ? "Amina Fabrics" : "",
      companyName: type === "LIMITED" ? "Amina Fabrics Ltd" : "",
      registrationNumber: type === "INDIVIDUAL" ? "" : type === "LIMITED" ? "RC765432" : "BN123456",
      phone: "08031234567",
      email: "amina@example.com",
      businessAddress: "5 Commercial Avenue, Yaba, Lagos",
      deliveryAddress: "5 Commercial Avenue, Yaba, Lagos",
      employerName: o.profile === "SALARY_EARNER" ? "Synthetic Employer Plc" : "",
      statedMonthlySalaryKobo: o.profile === "SALARY_EARNER" ? (o.incomeBasisKobo ?? 100_000_000) : null,
      salaryHistory: o.profile === "SALARY_EARNER" ? [1, 2, 3].map((k) => ({ month: addDaysToDateString(today, -30 * k).slice(0, 7), amountKobo: o.incomeBasisKobo ?? 100_000_000 })) : [],
      businessSector: o.profile === "BUSINESS_OWNER" ? "Textiles" : "",
      statedMonthlyTurnoverKobo: o.profile === "BUSINESS_OWNER" ? (o.incomeBasisKobo ?? 100_000_000) : null,
      requestedAmountKobo: o.amountKobo,
      tenorMonths: o.tenorMonths ?? 12,
      purpose: "Synthetic financing purpose",
      assetDescription: o.product === "VENDOR_FINANCING" ? "" : "Synthetic asset",
      assetCostKobo: o.product === "VENDOR_FINANCING" ? null : o.amountKobo,
      existingObligations: (o.obligations ?? []).map((x) => ({ ...x, facilityType: "Loan", outstandingKobo: null })),
      incomeBasisKobo: o.incomeBasisKobo ?? 100_000_000,
      proposedMonthlyObligationKobo: o.proposedMonthlyKobo === undefined ? Math.ceil(o.amountKobo / (o.tenorMonths ?? 12)) : o.proposedMonthlyKobo,
      vendorId: v.vendor_id,
      vendorAccountId: v.account_id,
      outletLocationId: outlet,
      assignedRmId: rmId,
      ...(o.data ?? {}),
    },
    bvn: type === "LIMITED" ? null : "01234567890",
    directors: type === "LIMITED" ? [{ fullName: "Director One", bvn: "22200000001" }] : undefined,
  });
  // Documents per the matrix
  const cfg = (await effectiveConfig(db, o.product, now))!.config;
  const rules = cfg.profiles[o.profile]!;
  const start = addDaysToDateString(today, -400);
  for (const d of rules.documents) {
    if (d.stage !== "SUBMISSION" || o.skipDocs?.includes(d.code)) continue;
    if (d.code === "BUSINESS_PHOTO") continue;
    if (d.code === "AFS" && !o.withAfs) continue;
    if (d.requirement === "OPTIONAL") continue;
    const count = d.minCount ?? 1;
    for (let i = 0; i < count; i++) {
      const meta = d.code === "BANK_STATEMENT" ? { coverageFrom: start, coverageTo: addDaysToDateString(today, -1) } : d.code === "PAYSLIP" ? { coverageFrom: addDaysToDateString(today, -95 + i * 31), coverageTo: addDaysToDateString(today, -65 + i * 31) } : undefined;
      await uploadDocument(ctx, { applicationId: id, category: d.code, filename: `${d.code.toLowerCase()}-${i}.pdf`, data: makePdf(`${d.code} ${i}`), meta });
    }
  }
  if (rules.documents.some((d) => d.code === "PAYSLIP")) {
    /* coverage of payslips: union of three consecutive periods */
  }
  const photoMode = o.photos ?? "FULL";
  if (rules.businessPhotos.minDistinct > 0 || rules.businessPhotos.rmPhotoRequired) {
    const angles = photoMode === "THREE" ? ["FRONT", "SIGNAGE", "INTERIOR"] : ["FRONT", "SIGNAGE", "INTERIOR", "STOCK"];
    for (const a of angles) await uploadDocument(ctx, { applicationId: id, category: "BUSINESS_PHOTO", filename: `${a}.jpg`, data: JPEG(a), meta: { photoCategory: a } });
    if (photoMode === "FULL" || photoMode === "THREE") {
      const rmCtx = await ctxFor(o.channel === "DO" ? (o.assignedRm ?? "rm.bola@altbank.ng") : initiatorEmail, now);
      await uploadDocument(rmCtx, { applicationId: id, category: "BUSINESS_PHOTO", filename: "rm.jpg", data: JPEG("rm"), meta: { photoCategory: "RM_WITH_BUSINESS" } });
    } else if (photoMode === "RM_BY_DO") {
      await uploadDocument(ctx, { applicationId: id, category: "BUSINESS_PHOTO", filename: "rm.jpg", data: JPEG("rm"), meta: { photoCategory: "RM_WITH_BUSINESS" } });
    }
  }
  if (rules.rmProposalRequired) {
    const rmCtx = await ctxFor(o.channel === "DO" ? (o.assignedRm ?? "rm.bola@altbank.ng") : initiatorEmail, now);
    await saveProposal(rmCtx, id, fullProposal());
  }
  if (o.submit !== false) await submitApplication(ctx, id, randomUUID());
  return id;
}

/** Business review: OSS (if any) → Team Lead → Head of Retail Sales → Head of Unit (if configured). */
export async function driveBusinessReview(id: string, now = new Date()) {
  for (let i = 0; i < 5; i++) {
    const t = await openTaskOf(id);
    if (!t) return;
    if (t.stage === "OSS_REVIEW") await act(id, "RECOMMEND", { reason: "Outlet details and evidence verified." }, now);
    else if (t.stage === "TEAM_LEAD_REVIEW") await act(id, "RECOMMEND", { reason: "Viable proposal; DSR within threshold.", visitComments: "Management visit completed; business operating as described.", rmPhotoConfirmed: true }, now);
    else if (t.stage === "HRS_REVIEW") await act(id, "ENDORSE", { reason: "Terms compliant with product rules; endorsed." }, now);
    else if (t.stage === "HEAD_OF_UNIT_APPROVAL") await act(id, "APPROVE", { reason: "Business approval granted for credit processing." }, now);
    else return;
  }
}

export async function recordFinal(id: string, o: { incomeBasisKobo?: number; principalKobo?: number; tenorMonths?: number; obligations?: { lender: string; monthlyRepaymentKobo: number }[] } = {}, now = new Date()) {
  const t = await openTaskOf(id);
  const ctx = await ctxFor(t.email!, now);
  const app = (await db.query("SELECT * FROM applications WHERE id = $1", [id])).rows[0];
  const v = (await db.query("SELECT data FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0].data;
  return recordFinalAssessment(ctx, id, {
    incomeBasisKobo: o.incomeBasisKobo ?? v.incomeBasisKobo,
    incomeBasisNote: "Verified from statements",
    statementFrom: addDaysToDateString(lagosDate(now), -200),
    statementTo: addDaysToDateString(lagosDate(now), -2),
    principalKobo: o.principalKobo ?? Number(app.requested_amount_kobo),
    tenorMonths: o.tenorMonths ?? v.tenorMonths,
    existingObligations: o.obligations ?? v.existingObligations,
    charges: [],
    turnoverForCapKobo: null,
  });
}

/** Credit appraisal and approvals through to offer preparation. */
export async function driveCredit(id: string, now = new Date()) {
  await recordFinal(id, {}, now);
  await act(id, "APPROVE", {}, now);
  const t = await openTaskOf(id);
  const app = (await db.query("SELECT route FROM applications WHERE id = $1", [id])).rows[0];
  await act(id, app.route === 1 ? "APPROVE" : "PROCEED", {}, now);
  void t;
  await act(id, "APPROVE", {}, now);
  await act(id, "APPROVE", {}, now);
}

export async function approveRetailTemplates() {
  await db.query("UPDATE offer_templates SET production_approved = true, approved_at = now() WHERE product_code IS NOT NULL");
}

/** Offer → pack → CO3 → DO1 → DO2 booking. */
export async function driveToBooking(id: string, now = new Date(), bookingRef = `FAC${Date.now()}${Math.floor(Math.random() * 1e4)}`) {
  const t = await openTaskOf(id);
  const ctx = await ctxFor(t.email!, now);
  await generateOffer(ctx, id);
  for (const c of ["SIGNED_OFFER", "KYC", "PRE_DISBURSEMENT", "GSI_FORM", "INSURANCE_SIGNED", "CONTRACT_EVIDENCE"]) {
    await uploadDocument(ctx, { applicationId: id, category: c, filename: `${c.toLowerCase()}.pdf`, data: makePdf(c) });
  }
  await act(id, "SUBMIT_PACK", { contractStepsConfirmed: true }, now);
  const co3 = await openTaskOf(id);
  await uploadDocument(await ctxFor(co3.email!, now), { applicationId: id, category: "INSURANCE_EVIDENCE", filename: "ins.pdf", data: makePdf("insurance") });
  await act(id, "FORWARD", {}, now);
  const do1 = await openTaskOf(id);
  await uploadDocument(await ctxFor(do1.email!, now), { applicationId: id, category: "CRMS_EVIDENCE", filename: "crms.pdf", data: makePdf("crms") });
  await act(id, "OKAY", { crmsLogged: true }, now);
  const app = (await db.query("SELECT * FROM applications WHERE id = $1", [id])).rows[0];
  const principal = (await db.query("SELECT inputs FROM retail_assessments WHERE application_id = $1 AND kind = 'FINAL' AND superseded_at IS NULL", [id])).rows[0].inputs.principalKobo;
  void app;
  await act(id, "BOOK_FACILITY", { facilityBooking: { bookingRef, principalKobo: Number(principal), firstDueDate: addDaysToDateString(lagosDate(now), 30) } }, now);
  return bookingRef;
}

export async function payAndReconcile(id: string, now = new Date(), ref = `PAY${Date.now()}${Math.floor(Math.random() * 1e4)}`) {
  const t = await openTaskOf(id);
  const ctx = await ctxFor(t.email!, now);
  const ev = await uploadDocument(ctx, { applicationId: id, category: "PAYMENT_EVIDENCE", filename: "payment.pdf", data: makePdf("payment advice") });
  const fac = (await db.query("SELECT principal_kobo FROM facilities WHERE application_id = $1", [id])).rows[0];
  await recordPaymentEvent(ctx, id, { eventType: "INITIATED", amountKobo: Number(fac.principal_kobo), paymentRef: ref, valueDate: null, evidenceDocumentIds: [] });
  await recordPaymentEvent(ctx, id, { eventType: "CONFIRMED", amountKobo: Number(fac.principal_kobo), paymentRef: ref, valueDate: lagosDate(now), evidenceDocumentIds: [ev.id] });
  await act(id, "RECONCILE_PAYMENT", {}, now);
  return ref;
}

export async function completeAll(id: string, now = new Date()) {
  await act(id, "COMPLETE_PROCESS", {}, now);
  const t = await openTaskOf(id);
  const ctx = await ctxFor(t.email!, now);
  const tasks = (await db.query("SELECT kind FROM fulfilment_tasks WHERE application_id = $1 AND status = 'OPEN'", [id])).rows;
  for (const k of tasks) {
    const ev = await uploadDocument(ctx, { applicationId: id, category: "FULFILMENT_EVIDENCE", filename: `${k.kind}.pdf`, data: makePdf(k.kind) });
    await recordFulfilmentTask(ctx, id, k.kind, { evidenceDocumentIds: [ev.id], note: `Synthetic ${k.kind} completed` });
  }
  await act(id, "COMPLETE_FULFILMENT", {}, now);
}

export { act, openTaskOf, performTaskAction };
