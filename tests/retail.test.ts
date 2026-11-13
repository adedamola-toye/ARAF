import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb, key } from "./helpers";
import { ctxFor, makePdf, openTaskOf, act } from "@/server/demo/scenario";
import { passRetailCreditChecks,
  applyConfig,
  syntheticConfig,
  createRetailCase,
  driveBusinessReview,
  driveCredit,
  approveRetailTemplates,
  driveToBooking,
  payAndReconcile,
  completeAll,
  staffId,
  JPEG,
  vendorAccount,
} from "@/server/demo/retail-scenario";
import { configGaps, INITIAL_PRODUCT_CONFIGS, proposeProductConfig, decideProductConfig, effectiveConfig, gapsBlocking, productConfigSchema } from "@/server/domain/products";
import { computeAffordability, rulesSnapshot } from "@/server/domain/affordability";
import { createRetailDraft, saveRetailDraft, retailReadiness, requestException, decideException, withdrawApplication } from "@/server/domain/retail";
import { submitApplication, performTaskAction } from "@/server/domain/workflow";
import { uploadDocument } from "@/server/domain/documents";
import { caseAccess } from "@/server/domain/access";
import { recordPaymentEvent, recordRepayment, closeFacility, facilityPosition, recordServicingAction } from "@/server/domain/retail-ops";
import { walletDay, walletMonth } from "@/server/domain/wallet";
import { verifyVendorAccount, proposeBeneficiary } from "@/server/domain/vendors";
import { bvnError, phoneError } from "@/server/domain/retail-data";
import { createSubmittedCase, driveToOffer, driveToClosed } from "@/server/demo/scenario";
import { grantRole } from "@/server/domain/admin";
import { lagosDate } from "@/server/time";

const N = (n: number) => n * 100;

beforeEach(async () => {
  await resetDb();
});

async function stages(id: string) {
  return (await db.query("SELECT t.stage, s.email FROM tasks t LEFT JOIN staff s ON s.id = t.assignee_id WHERE application_id = $1 ORDER BY seq", [id])).rows;
}
async function app(id: string) {
  return (await db.query("SELECT * FROM applications WHERE id = $1", [id])).rows[0];
}
const vf = () => applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING"));
const vfCase = (o: Partial<Parameters<typeof createRetailCase>[0]> = {}) =>
  createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(10_000_000), tenorMonths: 12, incomeBasisKobo: N(10_000_000), proposedMonthlyKobo: N(1_000_000), ...o });

// ------------------------------------------------------------------ configuration

describe("product configuration", () => {
  it("initial rules carry only supplied parameters; gaps are explicit and nothing is inherited between products", () => {
    for (const c of Object.values(INITIAL_PRODUCT_CONFIGS)) expect(productConfigSchema.safeParse(c).success).toBe(true);
    const vfR = INITIAL_PRODUCT_CONFIGS.VENDOR_FINANCING.profiles.BUSINESS_OWNER!;
    expect(vfR.maxAmountKobo).toBe(N(50_000_000));
    expect(vfR.maxTenorMonths).toBe(12);
    expect(vfR.dsr.maxPercent).toBe("30");
    expect(vfR.structures[0].ratePercent).toBe("23");
    expect(vfR.structures[0].rateConvention).toBeNull();
    expect(vfR.eligibleApplicantTypes).toEqual(["ENTERPRISE", "LIMITED"]);
    expect(INITIAL_PRODUCT_CONFIGS.VENDOR_FINANCING.profiles.SALARY_EARNER).toBeUndefined();
    // consent form replaced by the formal request letter
    expect(vfR.documents.map((d) => d.code)).toContain("CUSTOMER_REQUEST_LETTER");
    expect(vfR.documents.map((d) => d.code)).not.toContain("CONSENT_FORM");
    const power = INITIAL_PRODUCT_CONFIGS.ALT_POWER.profiles.BUSINESS_OWNER!;
    expect(power.dsr.maxPercent).toBeNull();
    expect(power.maxAmountKobo).toBeNull();
    expect(power.maxTenorMonths).toBeNull();
    expect(power.structures).toEqual([]);
    expect(INITIAL_PRODUCT_CONFIGS.ALT_POWER.profiles.SALARY_EARNER!.dsr.maxPercent).toBe("33");
    const gaps = configGaps(INITIAL_PRODUCT_CONFIGS.ALT_POWER, { profile: "BUSINESS_OWNER" });
    const sub = gapsBlocking(gaps, "SUBMISSION").map((g) => g.key);
    expect(sub).toEqual(expect.arrayContaining(["profiles.BUSINESS_OWNER.maxAmountKobo", "profiles.BUSINESS_OWNER.maxTenorMonths", "profiles.BUSINESS_OWNER.dsr.maxPercent", "profiles.BUSINESS_OWNER.statementMonths", "profiles.BUSINESS_OWNER.structures"]));
    const vfGaps = configGaps(INITIAL_PRODUCT_CONFIGS.VENDOR_FINANCING, { profile: "BUSINESS_OWNER" });
    expect(gapsBlocking(vfGaps, "FINAL_ASSESSMENT").map((g) => g.key)).toContain("profiles.BUSINESS_OWNER.structures.STANDARD.rateConvention");
    expect(gapsBlocking(vfGaps, "AFS_EXCEPTION").map((g) => g.key)).toContain("profiles.BUSINESS_OWNER.afs.exceptionApproverRole");
  });

  it("changes need a second approver, take effect from the effective date and existing applications keep their version", async () => {
    await vf();
    const id = await vfCase();
    const pinned = (await app(id)).product_config_id;
    const sa = await ctxFor("superadmin@altbank.ng");
    const cfg = syntheticConfig("VENDOR_FINANCING", (c) => (c.profiles.BUSINESS_OWNER!.dsr.maxPercent = "25"));
    const { id: proposal } = await proposeProductConfig(sa, { productCode: "VENDOR_FINANCING", config: cfg, effectiveFrom: new Date(Date.now() - 1000), reason: "Tighter DSR" });
    await expect(decideProductConfig(sa, { configId: proposal, approve: true, note: "self" })).rejects.toThrow(/approver/);
    await grantRole(await ctxFor("paul.toje@altbank.ng"), { staffId: await staffId("superadmin@altbank.ng"), role: "PRODUCT_CONFIG_APPROVER" }).catch(() => undefined);
    await expect(decideProductConfig(await ctxFor("superadmin@altbank.ng"), { configId: proposal, approve: true, note: "self" })).rejects.toThrow(/proposed/);
    await expect(decideProductConfig(await ctxFor("rm.bola@altbank.ng"), { configId: proposal, approve: true, note: "x" })).rejects.toThrow(/approver/);
    await decideProductConfig(await ctxFor("config.approver@altbank.ng"), { configId: proposal, approve: true, note: "ok" });
    const now = await effectiveConfig(db, "VENDOR_FINANCING", new Date());
    expect(now!.id).toBe(proposal);
    expect((await app(id)).product_config_id).toBe(pinned);
    const audit = (await db.query("SELECT action FROM audit_events WHERE action LIKE 'PRODUCT_CONFIG_%' ORDER BY id")).rows.map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(["PRODUCT_CONFIG_PROPOSED", "PRODUCT_CONFIG_APPROVED"]));
  });

  it("missing Alt Power configuration visibly blocks submission (no inherited parameters)", async () => {
    const ctx = await ctxFor("rm.bola@altbank.ng");
    const { id } = await createRetailDraft(ctx, { initiatorRole: "RM", productCode: "ALT_POWER", profile: "BUSINESS_OWNER", applicantType: "ENTERPRISE" });
    const r = await retailReadiness(db, id, new Date());
    expect(r.ready).toBe(false);
    const text = r.blockers.join(" ");
    expect(text).toMatch(/maximum financing amount/);
    expect(text).toMatch(/maximum DSR/);
    expect(text).toMatch(/financing structure/);
    await expect(submitApplication(ctx, id, key())).rejects.toThrow(/not ready/);
    // Alt Power salary earners: DSR 33% supplied, but denominator/statement period/structure still required
    const { id: s } = await createRetailDraft(ctx, { initiatorRole: "RM", productCode: "ALT_POWER", profile: "SALARY_EARNER", applicantType: "INDIVIDUAL" });
    const r2 = await retailReadiness(db, s, new Date());
    expect(r2.blockers.join(" ")).toMatch(/denominator/);
    expect(r2.rules!.dsr.maxPercent).toBe("33");
  });
});

// ------------------------------------------------------------------ routing

describe("business review routing", () => {
  it("Relationship Manager route: Team Lead → Head of Retail Sales → Head of Unit → credit", async () => {
    await vf();
    const id = await vfCase();
    await driveBusinessReview(id);
    const s = await stages(id);
    expect(s.map((x) => x.stage)).toEqual(["TEAM_LEAD_REVIEW", "HRS_REVIEW", "HEAD_OF_UNIT_APPROVAL", "FIRST_CREDIT_REVIEW"]);
    expect(s.slice(0, 3).map((x) => x.email)).toEqual(["tl.lagos@altbank.ng", "hrs@altbank.ng", "hou@altbank.ng"]);
    const kinds = (await db.query("SELECT stage, decision_kind FROM decisions WHERE application_id = $1 ORDER BY seq", [id])).rows;
    expect(kinds.every((k) => k.decision_kind === "BUSINESS_REVIEW")).toBe(true);
    expect((await app(id)).route).toBe(2);
  });

  it("Delight Officer route adds the Outlet Service Supervisor before both shared reviews", async () => {
    await vf();
    const id = await vfCase({ channel: "DO" });
    await driveBusinessReview(id);
    const s = await stages(id);
    expect(s.map((x) => x.stage)).toEqual(["OSS_REVIEW", "TEAM_LEAD_REVIEW", "HRS_REVIEW", "HEAD_OF_UNIT_APPROVAL", "FIRST_CREDIT_REVIEW"]);
    expect(s[0].email).toBe("oss.yaba@altbank.ng");
    expect(s[1].email).toBe("tl.lagos@altbank.ng");
    const a = await app(id);
    expect(a.location_snapshot.outletName).toBe("Yaba Altbox");
    expect(a.assigned_rm_id).toBe(await staffId("rm.bola@altbank.ng"));
  });

  it("an outlet with no supervisor goes to the visible assignment exception queue", async () => {
    await vf();
    const id = await vfCase({ channel: "DO", outlet: "Wuse Altshop", submit: false });
    const r = await retailReadiness(db, id, new Date());
    expect(r.blockers.join(" ")).toMatch(/No Outlet Service Supervisor/);
    await db.query("UPDATE locations SET oss_staff_id = $1 WHERE name = 'Wuse Altshop'", [await staffId("oss.yaba@altbank.ng")]);
    await db.query("UPDATE role_assignments SET active = false WHERE role = 'OUTLET_SERVICE_SUPERVISOR'");
    await passRetailCreditChecks(await ctxFor("do.ife@altbank.ng"), id);
    await submitApplication(await ctxFor("do.ife@altbank.ng"), id, key());
    const t = await openTaskOf(id);
    expect(t.stage).toBe("OSS_REVIEW");
    expect(t.assignee_id).toBeNull();
  });

  it("Head of Unit is configurable: NOT_REQUIRED goes straight to credit; a person holding both HRS and HoU is never used twice", async () => {
    await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING", (c) => (c.businessReview.headOfUnitStage = "NOT_REQUIRED")));
    const id = await vfCase();
    await driveBusinessReview(id);
    expect((await stages(id)).map((x) => x.stage)).toEqual(["TEAM_LEAD_REVIEW", "HRS_REVIEW", "FIRST_CREDIT_REVIEW"]);

    await vf();
    const hrs = await staffId("hrs@altbank.ng");
    await db.query("INSERT INTO role_assignments (staff_id, role) VALUES ($1, 'HEAD_OF_UNIT')", [hrs]);
    await db.query("UPDATE role_assignments SET active = false WHERE role = 'HEAD_OF_UNIT' AND staff_id <> $1", [hrs]);
    const id2 = await vfCase();
    await act(id2, "RECOMMEND", { reason: "Team Lead recommends this request.", visitComments: "Visited the business and confirmed operations.", rmPhotoConfirmed: true });
    await act(id2, "ENDORSE", { reason: "Head of Retail Sales endorses this request." });
    const t = await openTaskOf(id2);
    expect(t.stage).toBe("HEAD_OF_UNIT_APPROVAL");
    expect(t.assignee_id).toBeNull();
  });

  it("business review comments, visit comments and RM photograph confirmation are enforced", async () => {
    await vf();
    const id = await vfCase();
    await expect(act(id, "RECOMMEND", { reason: "ok" })).rejects.toThrow(/comments/i);
    await expect(act(id, "RECOMMEND", { reason: "Recommend for approval.", rmPhotoConfirmed: true })).rejects.toThrow(/visit comments/i);
    await expect(act(id, "RECOMMEND", { reason: "Recommend for approval.", visitComments: "Visited and verified the premises." })).rejects.toThrow(/Relationship Manager with the business/);
    await act(id, "RECOMMEND", { reason: "Recommend for approval.", visitComments: "Visited and verified the premises.", rmPhotoConfirmed: true });
    const att = (await db.query("SELECT attestation FROM tasks WHERE application_id = $1 AND stage = 'TEAM_LEAD_REVIEW'", [id])).rows[0].attestation;
    expect(att.rmPhotoConfirmed.method).toBe("REVIEWER_VISUAL_CONFIRMATION");
    expect(att.visitComments).toMatch(/Visited/);
  });

  it("returns record the reason, responsible recipient and originating stage", async () => {
    await vf();
    const id = await vfCase();
    await act(id, "RETURN", { reason: "Bank statement page missing" });
    const c = (await db.query("SELECT * FROM corrections WHERE application_id = $1", [id])).rows[0];
    expect(c.from_stage).toBe("TEAM_LEAD_REVIEW");
    expect(c.recipient_id).toBe(await staffId("rm.bola@altbank.ng"));
    expect(c.reason).toBe("Bank statement page missing");
    await act(id, "RESUBMIT");
    expect((await openTaskOf(id)).stage).toBe("TEAM_LEAD_REVIEW");
  });
});

// ------------------------------------------------------------------ Vendor Financing rules

describe("Vendor Financing", () => {
  it("registered businesses only, ₦50 million limit and 12-month tenor", async () => {
    await vf();
    const ctx = await ctxFor("rm.bola@altbank.ng");
    await expect(createRetailDraft(ctx, { initiatorRole: "RM", productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", applicantType: "INDIVIDUAL" })).rejects.toThrow(/available only to/);
    await expect(createRetailDraft(ctx, { initiatorRole: "RM", productCode: "VENDOR_FINANCING", profile: "SALARY_EARNER", applicantType: "INDIVIDUAL" })).rejects.toThrow(/not available/);
    const atLimit = await vfCase({ amountKobo: N(50_000_000), withAfs: true, submit: false, incomeBasisKobo: N(50_000_000), proposedMonthlyKobo: N(4_000_000) });
    expect((await retailReadiness(db, atLimit, new Date())).fieldErrors.requestedAmountKobo).toBeUndefined();
    const over = await vfCase({ amountKobo: N(50_000_000) + 1, withAfs: true, submit: false });
    expect((await retailReadiness(db, over, new Date())).fieldErrors.requestedAmountKobo).toMatch(/₦50,000,000.00/);
    const tenor = await vfCase({ tenorMonths: 13, submit: false });
    expect((await retailReadiness(db, tenor, new Date())).fieldErrors.tenorMonths).toMatch(/12 months/);
    const twelve = await vfCase({ tenorMonths: 12, submit: false });
    expect((await retailReadiness(db, twelve, new Date())).fieldErrors.tenorMonths).toBeUndefined();
  });

  it("required documents: CAC, vendor confirmation email, request letter, statements and photographs", async () => {
    await vf();
    const id = await vfCase({ skipDocs: ["CAC_CERTIFICATE", "VENDOR_CONFIRMATION_EMAIL", "CUSTOMER_REQUEST_LETTER"], submit: false });
    const r = await retailReadiness(db, id, new Date());
    expect(Object.keys(r.fieldErrors)).toEqual(expect.arrayContaining(["doc_CAC_CERTIFICATE", "doc_VENDOR_CONFIRMATION_EMAIL", "doc_CUSTOMER_REQUEST_LETTER"]));
    expect(r.matrix.find((m) => m.code === "CUSTOMER_REQUEST_LETTER")!.status).toBe("MISSING");
    expect(r.matrix.some((m) => m.code === "CONSENT_FORM")).toBe(false);
  });

  it("AFS above ₦20 million or an exception approved by the configured authority", async () => {
    // Without configured authority, exceptions are impossible.
    await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING", (c) => (c.profiles.BUSINESS_OWNER!.afs!.exceptionApproverRole = null)));
    const exact = await vfCase({ amountKobo: N(20_000_000), submit: false });
    expect((await retailReadiness(db, exact, new Date())).fieldErrors.doc_AFS).toBeUndefined();
    const id = await vfCase({ amountKobo: N(20_000_000) + 1, submit: false });
    expect((await retailReadiness(db, id, new Date())).fieldErrors.doc_AFS).toMatch(/approved AFS exception/);
    const rm = await ctxFor("rm.bola@altbank.ng");
    const ev = await uploadDocument(rm, { applicationId: id, category: "EXCEPTION_EVIDENCE", filename: "mgmt-accounts.pdf", data: makePdf("management accounts") });
    await expect(requestException(rm, id, { type: "AFS", reason: "Management accounts available; AFS due next month.", evidenceDocumentIds: [ev.id] })).rejects.toThrow(/authority is not configured/);
    // Configure the authority (synthetic: HEAD_OF_RETAIL_SALES)
    await vf();
    const ex = await requestException(rm, id, { type: "AFS", reason: "Management accounts available; AFS due next month.", evidenceDocumentIds: [ev.id] });
    await expect(decideException(rm, ex.id, true, "self approval")).rejects.toThrow();
    await expect(decideException(await ctxFor("tl.lagos@altbank.ng"), ex.id, true, "not my authority")).rejects.toThrow(/configured authority/);
    await decideException(await ctxFor("hrs@altbank.ng"), ex.id, true, "Accepted on management accounts");
    const r = await retailReadiness(db, id, new Date());
    expect(r.matrix.find((m) => m.code === "AFS")!.status).toBe("EXCEPTION_APPROVED");
    expect(r.fieldErrors.doc_AFS).toBeUndefined();
    const row = (await db.query("SELECT * FROM policy_exceptions WHERE id = $1", [ex.id])).rows[0];
    expect(row.reason).toMatch(/Management accounts/);
    expect(row.evidence_document_ids).toEqual([ev.id]);
  });

  it("four distinct photographs plus the RM with the business, uploaded by the responsible RM", async () => {
    await vf();
    const three = await vfCase({ photos: "THREE", submit: false });
    expect((await retailReadiness(db, three, new Date())).fieldErrors.photos).toBeUndefined(); // FRONT,SIGNAGE,INTERIOR + RM = 4 distinct
    const noRm = await vfCase({ photos: "NO_RM", submit: false });
    expect((await retailReadiness(db, noRm, new Date())).fieldErrors.photos).toMatch(/Relationship Manager with the business/);
    const doCase = await vfCase({ channel: "DO", photos: "RM_BY_DO", submit: false });
    expect((await retailReadiness(db, doCase, new Date())).fieldErrors.photos).toMatch(/uploaded by that RM/);
    // the same file twice does not count as two angles
    const dupe = await vfCase({ photos: "NO_RM", submit: false });
    const rm = await ctxFor("rm.bola@altbank.ng");
    const same = JPEG("same");
    await uploadDocument(rm, { applicationId: dupe, category: "BUSINESS_PHOTO", filename: "a.jpg", data: same, meta: { photoCategory: "SURROUNDINGS" } });
    const photoDocs = (await db.query("SELECT meta FROM documents WHERE application_id = $1 AND category = 'BUSINESS_PHOTO'", [dupe])).rows;
    expect(photoDocs.every((d) => !!d.meta.photoCategory)).toBe(true);
    await expect(uploadDocument(rm, { applicationId: dupe, category: "BUSINESS_PHOTO", filename: "b.jpg", data: JPEG("x") })).rejects.toThrow(/photograph category/);
  });

  it("Delight Officer case needs an explicitly assigned RM who writes the proposal", async () => {
    await vf();
    const id = await vfCase({ channel: "DO", submit: false });
    const doCtx = await ctxFor("do.ife@altbank.ng");
    const { saveProposal } = await import("@/server/domain/retail");
    await expect(saveProposal(doCtx, id, {})).rejects.toThrow(/assigned Relationship Manager/);
    await expect(saveProposal(await ctxFor("rm.ade@altbank.ng"), id, {})).rejects.toThrow();
    const access = await caseAccess(db, await staffId("rm.bola@altbank.ng"), id);
    expect(access.capacities).toContain("ASSIGNED_RM");
    expect((await db.query("SELECT 1 FROM notification_outbox WHERE kind = 'ASSIGNED_RM' AND application_id = $1", [id])).rowCount).toBe(1);
  });

  it("POS deployment is created only after payment is confirmed and reconciled", async () => {
    await vf();
    await approveRetailTemplates();
    const id = await vfCase();
    await driveBusinessReview(id);
    await driveCredit(id);
    await driveToBooking(id);
    expect((await db.query("SELECT 1 FROM fulfilment_tasks WHERE application_id = $1", [id])).rowCount).toBe(0);
    await payAndReconcile(id);
    const ft = (await db.query("SELECT kind, status FROM fulfilment_tasks WHERE application_id = $1", [id])).rows;
    expect(ft).toEqual([{ kind: "POS_DEPLOYMENT", status: "OPEN" }]);
    // POS was never a pre-disbursement requirement
    expect(INITIAL_PRODUCT_CONFIGS.VENDOR_FINANCING.profiles.BUSINESS_OWNER!.documents.some((d) => /POS/.test(d.code))).toBe(false);
  });
});

// ------------------------------------------------------------------ affordability

describe("affordability and pricing", () => {
  const vfRules = () => {
    const c = syntheticConfig("VENDOR_FINANCING");
    return rulesSnapshot({ configId: "x", configVersion: 9, productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", structure: "STANDARD", rules: c.profiles.BUSINESS_OWNER! });
  };
  const base = {
    kind: "PRELIMINARY" as const,
    applicantType: "ENTERPRISE",
    incomeBasisNote: "",
    statementFrom: null,
    statementTo: null,
    evidenceDocumentIds: [],
    proposedMonthlyObligationKobo: null,
    turnoverForCapKobo: null,
    assetCostKobo: null,
    equityContributionKobo: null,
    charges: [],
    firstDueDate: null,
  };

  it("DSR includes existing obligations and applies the 30% boundary exactly on unrounded values", () => {
    const r = vfRules();
    // FLAT_PER_ANNUM 23% on ₦1,200,000 for 12 months: total 1,476,000 → 123,000/month.
    const at = computeAffordability(r, { ...base, incomeBasisKobo: N(500_000), principalKobo: N(1_200_000), tenorMonths: 12, existingObligations: [{ lender: "X", facilityType: "", monthlyRepaymentKobo: N(27_000), outstandingKobo: null }] });
    expect(at.dsr!.percent).toBe("30.0000");
    expect(at.dsr!.pass).toBe(true);
    const over = computeAffordability(r, { ...base, incomeBasisKobo: N(500_000), principalKobo: N(1_200_000), tenorMonths: 12, existingObligations: [{ lender: "X", facilityType: "", monthlyRepaymentKobo: N(27_000) + 1, outstandingKobo: null }] });
    expect(over.dsr!.pass).toBe(false);
    expect(over.result).toBe("FAIL");
    const without = computeAffordability(r, { ...base, incomeBasisKobo: N(500_000), principalKobo: N(1_200_000), tenorMonths: 12, existingObligations: [] });
    expect(without.dsr!.percent).toBe("24.6000");
    // a value that rounds to 30.0000% for display but is above the threshold still fails
    const tiny = computeAffordability(r, { ...base, incomeBasisKobo: N(1_000_000_000), principalKobo: N(1_200_000), tenorMonths: 12, existingObligations: [{ lender: "X", facilityType: "", monthlyRepaymentKobo: N(300_000_000) - N(123_000) + 1, outstandingKobo: null }] });
    expect(tiny.dsr!.percent).toBe("30.0000");
    expect(tiny.dsr!.pass).toBe(false);
  });

  it("an unconfigured rate convention blocks final calculation (no assumption of annual/flat/monthly)", () => {
    const c = INITIAL_PRODUCT_CONFIGS.VENDOR_FINANCING.profiles.BUSINESS_OWNER!;
    const r = rulesSnapshot({ configId: "x", configVersion: 1, productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", structure: "STANDARD", rules: { ...c, dsr: { ...c.dsr, denominator: "AVERAGE_MONTHLY_BUSINESS_TURNOVER" } } });
    const out = computeAffordability(r, { ...base, kind: "FINAL", incomeBasisKobo: N(500_000), principalKobo: N(1_200_000), tenorMonths: 12, existingObligations: [] });
    expect(out.result).toBe("BLOCKED");
    expect(out.blockedReasons.join(" ")).toMatch(/rate convention/);
    // preliminary DSR still works from the initiator's estimate, flagged as such
    const pre = computeAffordability(r, { ...base, incomeBasisKobo: N(500_000), principalKobo: N(1_200_000), tenorMonths: 12, existingObligations: [], proposedMonthlyObligationKobo: N(123_000) });
    expect(pre.obligationSource).toBe("INITIATOR_ESTIMATE");
    expect(pre.dsr!.percent).toBe("24.6000");
  });

  it("Alt Drive structures, rates and insurance responsibility (salary 33%, business 10% DSR — never a turnover cap)", () => {
    const c = syntheticConfig("ALT_DRIVE");
    const sal = c.profiles.SALARY_EARNER!;
    const mur = rulesSnapshot({ configId: "x", configVersion: 1, productCode: "ALT_DRIVE", profile: "SALARY_EARNER", structure: "MURABAHA", rules: sal });
    const ija = rulesSnapshot({ configId: "x", configVersion: 1, productCode: "ALT_DRIVE", profile: "SALARY_EARNER", structure: "IJARAH", rules: sal });
    expect([mur.ratePercent, mur.insuranceBearer]).toEqual(["34", "CUSTOMER"]);
    expect([ija.ratePercent, ija.insuranceBearer]).toEqual(["39.5", "BANK"]);
    const m = computeAffordability(mur, { ...base, applicantType: "INDIVIDUAL", incomeBasisKobo: N(1_000_000), principalKobo: N(6_000_000), tenorMonths: 24, existingObligations: [] });
    // 34% p.a. flat (synthetic convention) for 2 years: profit 4,080,000; total 10,080,000; 420,000/month = 42% DSR → FAIL at 33%
    expect(m.totalPayableKobo).toBe(N(10_080_000));
    expect(m.insurance).toMatch(/Customer bears/);
    expect(m.dsr!.percent).toBe("42.0000");
    expect(m.result).toBe("FAIL");
    const i = computeAffordability(ija, { ...base, applicantType: "INDIVIDUAL", incomeBasisKobo: N(2_000_000), principalKobo: N(6_000_000), tenorMonths: 24, existingObligations: [] });
    expect(i.totalPayableKobo).toBe(N(10_740_000));
    expect(i.insurance).toMatch(/Bank bears/);
    const biz = c.profiles.BUSINESS_OWNER!;
    expect(biz.dsr.maxPercent).toBe("10");
    expect(biz.principalTurnoverCap.applies).toBe(false);
    const br = rulesSnapshot({ configId: "x", configVersion: 1, productCode: "ALT_DRIVE", profile: "BUSINESS_OWNER", structure: "MURABAHA", rules: biz });
    // principal far above 10% of monthly turnover is fine as long as DSR ≤ 10%
    const bo = computeAffordability(br, { ...base, incomeBasisKobo: N(10_000_000), principalKobo: N(2_000_000), tenorMonths: 24, existingObligations: [] });
    expect(bo.cap!.applies).toBe(false);
    expect(bo.dsr!.pass).toBe(true);
    expect(bo.formula.join(" ")).toMatch(/DSR = \(existing monthly obligations/);
  });

  it("DSR failure blocks submission; existing obligations count", async () => {
    await vf();
    // ₦1.2m at 23% flat p.a. (synthetic convention) over 12 months = ₦123,000 a month; plus ₦187,000 existing = 31% of ₦1m.
    const id = await vfCase({ amountKobo: N(1_200_000), incomeBasisKobo: N(1_000_000), obligations: [{ lender: "Other bank", monthlyRepaymentKobo: N(187_000) }], submit: false });
    const r = await retailReadiness(db, id, new Date());
    expect(r.preliminary!.dsr!.percent).toBe("31.0000");
    expect(r.blockers.join(" ")).toMatch(/DSR within 30%/);
    await expect(submitApplication(await ctxFor("rm.bola@altbank.ng"), id, key())).rejects.toThrow(/not ready/);
  });
});

// ------------------------------------------------------------------ validation

describe("form validation", () => {
  it("11-digit phone and BVN on the server; leading zeros preserved; format check is not verification", async () => {
    expect(phoneError("0803123456")).toMatch(/exactly 11 digits/);
    expect(phoneError("080312345678")).toMatch(/exactly 11 digits/);
    expect(phoneError("0803123456a")).toMatch(/digits only/);
    expect(phoneError("08031234567")).toBeNull();
    expect(bvnError("2221234567")).toMatch(/exactly 11/);
    expect(bvnError("01234567890")).toBeNull();
    await vf();
    const ctx = await ctxFor("rm.bola@altbank.ng");
    const { id } = await createRetailDraft(ctx, { initiatorRole: "RM", productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", applicantType: "ENTERPRISE" });
    await expect(saveRetailDraft(ctx, id, { data: { phone: "0803123456" } })).rejects.toThrow(/not valid/);
    await expect(saveRetailDraft(ctx, id, { data: {}, bvn: "123456789012" })).rejects.toThrow(/not valid/);
    await saveRetailDraft(ctx, id, { data: { phone: "08031234567" }, bvn: "00012345678" });
    const v = (await db.query("SELECT data, bvn_last4 FROM application_versions WHERE application_id = $1", [id])).rows[0];
    expect(v.data.phone).toBe("08031234567");
    expect(v.bvn_last4).toBe("5678");
  });

  it("role selection grants nothing: only provisioned roles can initiate", async () => {
    await vf();
    await expect(createRetailDraft(await ctxFor("tl.lagos@altbank.ng"), { initiatorRole: "RM", productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", applicantType: "ENTERPRISE" })).rejects.toThrow(/do not hold/);
    await expect(createRetailDraft(await ctxFor("rm.bola@altbank.ng"), { initiatorRole: "DELIGHT_OFFICER", productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", applicantType: "ENTERPRISE" })).rejects.toThrow(/do not hold/);
  });

  it("bank selection alone never approves a beneficiary; verification is maker-checker", async () => {
    await vf();
    const id = await vfCase({ submit: false });
    const rm = await ctxFor("rm.bola@altbank.ng");
    const inst = (await db.query("SELECT id FROM financial_institutions WHERE code = 'DEMO-001'")).rows[0].id;
    const { vendorId, accountId } = await proposeBeneficiary(rm, id, { name: "New Vendor Ltd", email: "pay@newvendor.example", institutionId: inst, accountNumber: "0987654321", accountName: "NEW VENDOR LTD" });
    await saveRetailDraft(rm, id, { data: { vendorId, vendorAccountId: accountId } });
    let r = await retailReadiness(db, id, new Date());
    expect(r.fieldErrors.vendorAccountId).toMatch(/not verified/);
    await expect(verifyVendorAccount(rm, accountId, { outcome: "VERIFIED", note: "self" })).rejects.toThrow();
    await verifyVendorAccount(await ctxFor("vendor.checker@altbank.ng"), accountId, { outcome: "VERIFIED", note: "Called vendor; bank letter on file ref BL-1" });
    r = await retailReadiness(db, id, new Date());
    expect(r.fieldErrors.vendorAccountId).toBeUndefined();
    expect(r.beneficiary!.institutionName).toMatch(/Synthetic Commercial Bank/);
    expect(r.beneficiary!.accountNumber).toBe("0987654321");
  });
});

// ------------------------------------------------------------------ material change, access, independence

describe("material changes, access and independence", () => {
  it("material change from first credit review: vendor account change restarts business review and invalidates approvals", async () => {
    await vf();
    const id = await vfCase();
    await driveBusinessReview(id);
    await act(id, "RETURN", { reason: "Use the vendor's other verified account" });
    const rm = await ctxFor("rm.bola@altbank.ng");
    const motors = await vendorAccount("Synthetic Motors Ltd");
    await saveRetailDraft(rm, id, { data: { vendorId: motors.vendor_id, vendorAccountId: motors.account_id } });
    const res = await act(id, "RESUBMIT");
    expect(res.message).toMatch(/Material change detected/);
    expect(res.message).toMatch(/beneficiary/);
    expect((await openTaskOf(id)).stage).toBe("TEAM_LEAD_REVIEW");
    const inv = (await db.query("SELECT stage FROM decisions WHERE application_id = $1 AND invalidated_at IS NOT NULL ORDER BY seq", [id])).rows.map((r) => r.stage);
    expect(inv).toEqual(["TEAM_LEAD_REVIEW", "HRS_REVIEW", "HEAD_OF_UNIT_APPROVAL"]);
    // non-material change (customer email) returns to the stage that asked
    await act(id, "RETURN", { reason: "Fix the email address" });
    await saveRetailDraft(rm, id, { data: { email: "amina.b@example.com" } });
    const r2 = await act(id, "RESUBMIT");
    expect(r2.message).toMatch(/Resubmitted to Team Lead/);
  });

  it("access follows scope; administrators alone see nothing; the same person cannot satisfy independent stages", async () => {
    await vf();
    const id = await vfCase();
    expect((await caseAccess(db, await staffId("tl.abuja@altbank.ng"), id)).canView).toBe(false);
    expect((await caseAccess(db, await staffId("tl.lagos@altbank.ng"), id)).canView).toBe(true);
    expect((await caseAccess(db, await staffId("hrs@altbank.ng"), id)).capacities).toContain("RETAIL_LEADERSHIP");
    expect((await caseAccess(db, await staffId("superadmin@altbank.ng"), id)).canView).toBe(false);
    expect((await caseAccess(db, await staffId("rm.ade@altbank.ng"), id)).canView).toBe(false);
    // The Team Lead also holds the only first-credit-review role for route 2: they are excluded there.
    const tl = await staffId("tl.lagos@altbank.ng");
    await db.query("UPDATE role_assignments SET active = false WHERE role = 'CREDIT_OFFICER_2'");
    await db.query("INSERT INTO role_assignments (staff_id, role) VALUES ($1, 'CREDIT_OFFICER_2')", [tl]);
    await driveBusinessReview(id);
    const t = await openTaskOf(id);
    expect(t.stage).toBe("FIRST_CREDIT_REVIEW");
    expect(t.assignee_id).toBeNull();
  });

  it("concurrent decisions are refused with lock_version and idempotency", async () => {
    await vf();
    const id = await vfCase();
    const t = await openTaskOf(id);
    const ctx = await ctxFor(t.email!);
    const k = randomUUID();
    const input = { taskId: t.id, action: "RECOMMEND" as const, reason: "Recommend for approval.", visitComments: "Visited and verified the premises.", rmPhotoConfirmed: true, idempotencyKey: k };
    const a = await performTaskAction(ctx, input);
    const b = await performTaskAction(ctx, input);
    expect(b.replayed).toBe(true);
    expect(a.stage).toBe(b.stage);
    const t2 = await openTaskOf(id);
    await expect(performTaskAction(await ctxFor(t2.email!), { taskId: t2.id, action: "ENDORSE", reason: "Endorsed after review.", idempotencyKey: randomUUID(), expectedLockVersion: 0 })).rejects.toThrow(/changed since/);
  });
});

// ------------------------------------------------------------------ booking, payment, facility

describe("booking, payment reconciliation and facility lifecycle", () => {
  async function toBooking() {
    await vf();
    await approveRetailTemplates();
    const id = await vfCase();
    await driveBusinessReview(id);
    await driveCredit(id);
    return id;
  }

  it("offers come only from approved templates and carry the assessment snapshot", async () => {
    await vf();
    const id = await vfCase();
    await driveBusinessReview(id);
    await driveCredit(id);
    const t = await openTaskOf(id);
    const { generateOffer } = await import("@/server/domain/offer");
    await expect(generateOffer(await ctxFor(t.email!), id)).rejects.toThrow(/not been approved/);
    await approveRetailTemplates();
    await generateOffer(await ctxFor(t.email!), id);
    const ev = (await db.query("SELECT details FROM audit_events WHERE action = 'OFFER_GENERATED' AND application_id = $1", [id])).rows[0].details;
    expect(ev.retailAssessmentId).toBeTruthy();
  });

  it("duplicate booking and payment retries never double count", async () => {
    const id = await toBooking();
    const ref = await driveToBooking(id);
    await expect(driveToBooking(id)).rejects.toThrow();
    expect((await db.query("SELECT count(*)::int AS n FROM facilities WHERE application_id = $1", [id])).rows[0].n).toBe(1);
    expect((await db.query("SELECT booking_ref FROM facilities WHERE application_id = $1", [id])).rows[0].booking_ref).toBe(ref);
    const t = await openTaskOf(id);
    const ctx = await ctxFor(t.email!);
    const fac = (await db.query("SELECT * FROM facilities WHERE application_id = $1", [id])).rows[0];
    expect(fac.payment_status).toBe("NOT_STARTED");
    // Booking alone is not a successful payment; reconciliation is blocked.
    await expect(act(id, "RECONCILE_PAYMENT")).rejects.toThrow(/do not equal/);
    await recordPaymentEvent(ctx, id, { eventType: "INITIATED", amountKobo: Number(fac.principal_kobo), paymentRef: "PAY-0001", valueDate: null, evidenceDocumentIds: [] });
    await expect(recordPaymentEvent(ctx, id, { eventType: "INITIATED", amountKobo: Number(fac.principal_kobo), paymentRef: "PAY-0002", valueDate: null, evidenceDocumentIds: [] })).rejects.toThrow(/uncertain payment/);
    await expect(act(id, "RECONCILE_PAYMENT")).rejects.toThrow(/uncertain outcome/);
    const ev = await uploadDocument(ctx, { applicationId: id, category: "PAYMENT_EVIDENCE", filename: "advice.pdf", data: makePdf("advice") });
    await expect(recordPaymentEvent(ctx, id, { eventType: "CONFIRMED", amountKobo: Number(fac.principal_kobo), paymentRef: "PAY-0001", valueDate: lagosDate(new Date()), evidenceDocumentIds: [] })).rejects.toThrow(/evidence/);
    await recordPaymentEvent(ctx, id, { eventType: "FAILED", amountKobo: Number(fac.principal_kobo), paymentRef: "PAY-0001", valueDate: null, evidenceDocumentIds: [ev.id] });
    const half = Math.floor(Number(fac.principal_kobo) / 2);
    await recordPaymentEvent(ctx, id, { eventType: "CONFIRMED", amountKobo: half, paymentRef: "PAY-0002", valueDate: lagosDate(new Date()), evidenceDocumentIds: [ev.id] });
    const dup = await recordPaymentEvent(ctx, id, { eventType: "CONFIRMED", amountKobo: half, paymentRef: "PAY-0002", valueDate: lagosDate(new Date()), evidenceDocumentIds: [ev.id] });
    expect(dup.duplicate).toBe(true);
    expect(dup.position.status).toBe("PARTIAL");
    await expect(act(id, "RECONCILE_PAYMENT")).rejects.toThrow(/do not equal/);
    await recordPaymentEvent(ctx, id, { eventType: "REVERSED", amountKobo: half, paymentRef: "PAY-0002", valueDate: lagosDate(new Date()), evidenceDocumentIds: [ev.id] });
    await recordPaymentEvent(ctx, id, { eventType: "CONFIRMED", amountKobo: Number(fac.principal_kobo), paymentRef: "PAY-0003", valueDate: lagosDate(new Date()), evidenceDocumentIds: [ev.id] });
    await expect(recordPaymentEvent(ctx, id, { eventType: "CONFIRMED", amountKobo: 1, paymentRef: "PAY-0004", valueDate: lagosDate(new Date()), evidenceDocumentIds: [ev.id] })).rejects.toThrow(/exceed/);
    await act(id, "RECONCILE_PAYMENT");
    const d = (await db.query("SELECT * FROM disbursements WHERE application_id = $1", [id])).rows;
    expect(d).toHaveLength(1);
    expect(Number(d[0].amount_kobo)).toBe(Number(fac.principal_kobo));
    expect((await db.query("SELECT status, payment_status FROM facilities WHERE application_id = $1", [id])).rows[0]).toEqual({ status: "ACTIVE", payment_status: "RECONCILED" });
  });

  it("completing the application keeps the facility open until settled; then it can be closed", async () => {
    const id = await toBooking();
    await driveToBooking(id);
    await payAndReconcile(id);
    await completeAll(id);
    const a = await app(id);
    expect([a.stage, a.status]).toEqual(["COMPLETED", "COMPLETED"]);
    const fac = (await db.query("SELECT * FROM facilities WHERE application_id = $1", [id])).rows[0];
    expect(fac.status).toBe("ACTIVE");
    const col = await ctxFor("collections@altbank.ng");
    await expect(closeFacility(col, fac.id)).rejects.toThrow(/outstanding/);
    await expect(recordServicingAction(col, fac.id, { kind: "RESTRUCTURE_REQUEST", note: "Customer asked for 3 more months" })).resolves.toBeTruthy();
    const ev = await uploadDocument(col, { applicationId: id, category: "REPAYMENT_EVIDENCE", filename: "r.pdf", data: makePdf("repayment") });
    const total = Number(fac.total_payable_kobo);
    await recordRepayment(col, fac.id, { eventType: "RECEIVED", amountKobo: total - 100, valueDate: lagosDate(new Date()), reference: "REP-0001", evidenceDocumentIds: [ev.id] });
    const dup = await recordRepayment(col, fac.id, { eventType: "RECEIVED", amountKobo: total - 100, valueDate: lagosDate(new Date()), reference: "REP-0001", evidenceDocumentIds: [ev.id] });
    expect(dup.duplicate).toBe(true);
    await expect(recordRepayment(col, fac.id, { eventType: "RECEIVED", amountKobo: 101, valueDate: lagosDate(new Date()), reference: "REP-0002", evidenceDocumentIds: [ev.id] })).rejects.toThrow(/exceeds/);
    await recordRepayment(col, fac.id, { eventType: "RECEIVED", amountKobo: 100, valueDate: lagosDate(new Date()), reference: "REP-0002", evidenceDocumentIds: [ev.id] });
    const pos = await facilityPosition(db, fac.id, lagosDate(new Date()));
    expect(pos.outstandingKobo).toBe(0);
    await closeFacility(col, fac.id);
    expect((await db.query("SELECT status FROM facilities WHERE id = $1", [fac.id])).rows[0].status).toBe("CLOSED");
  });
});

// ------------------------------------------------------------------ daily wallet

describe("RM daily request wallet", () => {
  it("counts each submission once on its Lagos date; resubmissions and retries add nothing; months reconcile", async () => {
    await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING"), "SYNTHETIC", new Date("2026-03-01T00:00:00Z"));
    // 23:30 UTC = 00:30 Lagos on the next day.
    const late = new Date("2026-03-31T23:30:00Z");
    const a = await vfCase({ now: late, amountKobo: N(1_000_000), incomeBasisKobo: N(10_000_000), proposedMonthlyKobo: N(100_000) });
    const b = await vfCase({ now: new Date("2026-03-31T22:59:00Z"), amountKobo: N(2_000_000), incomeBasisKobo: N(10_000_000), proposedMonthlyKobo: N(200_000) });
    const rm = await staffId("rm.bola@altbank.ng");
    expect((await walletDay(db, rm, "2026-04-01")).totalKobo).toBe(String(N(1_000_000)));
    expect((await walletDay(db, rm, "2026-03-31")).totalKobo).toBe(String(N(2_000_000)));
    // Return and resubmit with a changed amount: the submitted amount and day are retained.
    await act(a, "RETURN", { reason: "Please increase the amount" });
    await saveRetailDraft(await ctxFor("rm.bola@altbank.ng"), a, { data: { requestedAmountKobo: N(1_500_000), proposedMonthlyObligationKobo: N(150_000) } });
    // The March Seed Score is older than 30 days by now: a fresh check is needed before resubmitting.
    await expect(act(a, "RESUBMIT")).rejects.toThrow(/not ready|SeedFi credit check/);
    await passRetailCreditChecks(await ctxFor("rm.bola@altbank.ng"), a);
    await act(a, "RESUBMIT");
    const day = await walletDay(db, rm, "2026-04-01");
    expect(day.count).toBe(1);
    expect(day.totalKobo).toBe(String(N(1_000_000)));
    expect(Number(day.rows[0].latest_requested_amount_kobo)).toBe(N(1_500_000));
    // Declined requests stay in the total with their status.
    await act(b, "REJECT", { reason: "Declined: the business could not be verified at all" });
    const d2 = await walletDay(db, rm, "2026-03-31");
    expect(d2.totalKobo).toBe(String(N(2_000_000)));
    expect(d2.rows[0].status).toBe("REJECTED");
    const april = await walletMonth(db, rm, "2026-04");
    const march = await walletMonth(db, rm, "2026-03");
    expect(april.totalKobo).toBe(String(N(1_000_000)));
    expect(march.totalKobo).toBe(String(N(2_000_000)));
    expect(march.days).toEqual([{ day: "2026-03-31", totalKobo: String(N(2_000_000)), count: 1 }]);
    // Ledger rows are immutable.
    await expect(db.query("UPDATE request_ledger SET requested_amount_kobo = 1 WHERE application_id = $1", [a])).rejects.toThrow(/immutable/);
    // Withdrawal keeps the requested amount.
    await withdrawApplication(await ctxFor("rm.bola@altbank.ng"), a, "Customer no longer needs it");
    expect((await walletDay(db, rm, "2026-04-01")).rows[0].status).toBe("WITHDRAWN");
    // Other RMs see nothing of this RM's wallet.
    expect((await walletDay(db, await staffId("rm.ade@altbank.ng"), "2026-04-01")).count).toBe(0);
  });
});

// ------------------------------------------------------------------ backward compatibility

describe("backward compatibility", () => {
  it("WakeelBoost cases keep their label, flow and decisions; reports still read them", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) });
    await driveToOffer(id);
    await driveToClosed(id);
    const a = await app(id);
    expect([a.product_code, a.product_label, a.workflow, a.status]).toEqual(["WAKEELBOOST", "WakeelBoost", "WAKEELBOOST", "CLOSED"]);
    expect(a.ref).toMatch(/^WB-/);
    const kinds = (await db.query("SELECT DISTINCT decision_kind FROM decisions WHERE application_id = $1", [id])).rows.map((r) => r.decision_kind).sort();
    expect(kinds).toEqual(["BUSINESS_REVIEW", "CREDIT", "INITIATOR", "OPERATIONAL"]);
    expect((await db.query("SELECT 1 FROM request_ledger WHERE application_id = $1", [id])).rowCount).toBe(1);
  });
});

describe("Alt Drive journey, reviewer document rejection and escalations", () => {
  it("Alt Drive Ijarah: insurance responsibility (bank) flows into the approved snapshot and the offer", async () => {
    await applyConfig("ALT_DRIVE", syntheticConfig("ALT_DRIVE"));
    await approveRetailTemplates();
    const id = await createRetailCase({ channel: "RM", product: "ALT_DRIVE", profile: "SALARY_EARNER", structure: "IJARAH", amountKobo: N(6_000_000), tenorMonths: 36, incomeBasisKobo: N(2_000_000) });
    await driveBusinessReview(id);
    await driveCredit(id);
    const t = await openTaskOf(id);
    const { generateOffer } = await import("@/server/domain/offer");
    const r = await generateOffer(await ctxFor(t.email!), id);
    const doc = (await db.query("SELECT storage_key FROM documents WHERE id = $1", [r.documentId])).rows[0];
    const { objectStore } = await import("@/server/storage");
    const html = (await objectStore().get(doc.storage_key)).toString("utf8");
    expect(html).toMatch(/Bank bears the insurance cost/);
    expect(html).toMatch(/Ijarah/);
    expect(html).toMatch(/39\.5%/);
  });

  it("a reviewer can reject a document, which then no longer satisfies the matrix", async () => {
    await vf();
    const id = await vfCase();
    const letter = (await db.query("SELECT id FROM documents WHERE application_id = $1 AND category = 'CUSTOMER_REQUEST_LETTER'", [id])).rows[0].id;
    const { reviewDocument } = await import("@/server/domain/documents");
    await expect(reviewDocument(await ctxFor("rm.bola@altbank.ng"), letter, "REJECTED", "Unsigned")).rejects.toThrow(/reviewer currently assigned/);
    await reviewDocument(await ctxFor("tl.lagos@altbank.ng"), letter, "REJECTED", "Letter is unsigned");
    const { evaluateMatrix } = await import("@/server/domain/doc-matrix");
    const { listDocuments } = await import("@/server/domain/documents");
    const m = evaluateMatrix({ rules: syntheticConfig("VENDOR_FINANCING").profiles.BUSINESS_OWNER!, structure: "STANDARD", amountKobo: N(10_000_000), documents: await listDocuments(db, id), approvedExceptions: [], asOf: lagosDate(new Date()), stages: ["SUBMISSION"] });
    expect(m.find((x) => x.code === "CUSTOMER_REQUEST_LETTER")!.status).toBe("REJECTED");
  });

  it("service targets escalate overdue tasks once, to configured recipients and the owner", async () => {
    await vf();
    const id = await vfCase();
    const { saveServiceTarget, runSlaEscalations } = await import("@/server/domain/sla");
    await saveServiceTarget(await ctxFor("superadmin@altbank.ng"), { stage: "TEAM_LEAD_REVIEW", targetHours: 24, recipientIds: [await staffId("hrs@altbank.ng")] });
    const later = new Date(Date.now() + 25 * 3600_000);
    expect(await runSlaEscalations(later)).toBe(1);
    expect(await runSlaEscalations(later)).toBe(0);
    const mail = (await db.query("SELECT to_addresses FROM notification_outbox WHERE kind = 'SLA_ESCALATION' AND application_id = $1", [id])).rows;
    expect(mail).toHaveLength(1);
    expect(mail[0].to_addresses).toEqual(expect.arrayContaining(["hrs@altbank.ng", "tl.lagos@altbank.ng"]));
  });
});
