import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { NAIRA, formatKobo } from "@/server/money";
import { calculatePricing, dsrExplanation, pricingSettingsAt, updatePricingSettings, type PricingSettings } from "@/server/domain/pricing";
import { parseCalculatorForm, recordAssessment, approvedAssessment } from "@/server/domain/assessment";
import { generateOffer } from "@/server/domain/offer";
import { createDraft, performTaskAction, saveDraft, submitApplication } from "@/server/domain/workflow";
import { uploadDocument } from "@/server/domain/documents";
import { updateSecondSignatory } from "@/server/domain/signatory";
import { listDocuments, readDocumentForActor } from "@/server/domain/documents";
import JSZip from "jszip";
import { ACCEPTANCE_INPUTS, act, appRow, approveFirstReview, createSubmittedCase, ctxFor, driveToOffer, makePdf, openTaskOf, preparePack, recordAcceptanceAssessment, prepareFirstReview } from "@/server/demo/scenario";
import { audits, key, outbox, resetDb } from "./helpers";

const S: PricingSettings = { id: "s1", version: 2, maxTenorMonths: 6, shortRateE4: 100_000, longRateE4: 150_000, thresholdE4: 100_000, longBandFromMonths: 4, effectiveFrom: new Date("2020-01-01") };
const base = { annualTurnoverKobo: 120_000_000_000, principalKobo: 1_000_000_000, tenorMonths: 3, existingObligationsKobo: 0 };

beforeEach(async () => {
  await resetDb();
});

describe("acceptance case (bank instruction)", () => {
  it("₦50m over 6 months on a verified ₦77.5m monthly turnover: 12.37%, exceeds by ₦1,833,333.33", async () => {
    const r = calculatePricing(
      { annualTurnoverKobo: 93_023_800_000, verifiedMonthlyTurnoverKobo: 7_750_000_000, overrideReason: "Verified monthly figure", principalKobo: 5_000_000_000, tenorMonths: 6, existingObligationsKobo: 0 },
      S,
    );
    expect(formatKobo(r.turnover.derivedMonthlyTurnoverKobo)).toBe("₦77,519,833.33");
    expect(r.turnover.basis).toBe("VERIFIED_MONTHLY");
    expect(formatKobo(r.turnover.monthlyTurnoverUsedKobo)).toBe("₦77,500,000.00");
    expect(r.facility.flatMarkupRatePercent).toBe("15");
    expect(formatKobo(r.facility.markupKobo)).toBe("₦7,500,000.00");
    expect(formatKobo(r.facility.totalRepaymentKobo)).toBe("₦57,500,000.00");
    expect(formatKobo(r.facility.monthlyRepaymentKobo)).toBe("₦9,583,333.33");
    expect(r.capacity.facilityDsrPercent).toBe("12.37");
    expect(r.capacity.totalDsrPercent).toBe("12.37"); // obligations zero → equal
    expect(r.capacity.result).toBe("EXCEEDS_THRESHOLD");
    expect(formatKobo(r.capacity.thresholdAmountKobo)).toBe("₦7,750,000.00");
    expect(formatKobo(r.capacity.excessKobo)).toBe("₦1,833,333.33");
    expect(formatKobo(r.capacity.maxAffordablePrincipalKobo)).toBe("₦40,434,782.60"); // rounded down
    expect(dsrExplanation(r.capacity)).toBe(
      "The proposed monthly repayment represents 12.37% of the turnover used for this assessment, exceeding the Bank’s 10% obligation threshold by ₦1,833,333.33 per month.",
    );
  });

  it("is stored against the request version with settings, result, reviewer and both turnover figures audited; flagged in the review email", async () => {
    const id = await createSubmittedCase({ initiator: "RM", type: "ENTERPRISE", amountKobo: NAIRA(50_000_000) });
    await act(id, "ENDORSE");
    await recordAcceptanceAssessment(id);
    const a = (await db.query("SELECT * FROM credit_assessments WHERE application_id = $1", [id])).rows[0];
    const app = await appRow(id);
    expect(a.version_id).toBe(app.current_version_id);
    expect(a.threshold_result).toBe("EXCEEDS_THRESHOLD");
    expect(a.dsr_percent).toBe("12.3656");
    expect(a.pricing_settings_id).toBe(a.outputs.pricing.settings.id);
    expect(a.outputs.pricing.settings).toMatchObject({ version: 2, shortRatePercent: "10", longRatePercent: "15", maxTenorMonths: 6, longBandFromMonths: 4, shortBandLabel: "1–3 months", longBandLabel: "4–6 months" });
    expect(a.assessor_id).toBe((await openTaskOf(id)).assignee_id);
    const ev = (await audits("ASSESSMENT_RECORDED")).at(-1);
    expect(ev.details).toMatchObject({ annualTurnoverKobo: 93_023_800_000, derivedMonthlyTurnover: "77519833.333333", verifiedMonthlyTurnoverKobo: 7_750_000_000, turnoverBasis: "VERIFIED_MONTHLY", thresholdResult: "EXCEEDS_THRESHOLD" });
    expect(ev.details.overrideReason).toMatch(/77,500,000/);
    // Above the threshold, approval needs a justification backed by evidence (e.g. a second statement).
    const t = await openTaskOf(id);
    const ctx = await ctxFor(t.email!);
    await expect(act(id, "APPROVE", { invoiceLogged: true, invoiceDialogConfirmed: true })).rejects.toThrow(/exceeds the 10% turnover threshold/);
    await expect(act(id, "APPROVE", { invoiceLogged: true, invoiceDialogConfirmed: true, dsrExceptionJustification: "Second statement shows additional inflows" })).rejects.toThrow(/DSR exception evidence/);
    await uploadDocument(ctx, { applicationId: id, category: "DSR_EXCEPTION_EVIDENCE", filename: "second-statement.pdf", data: makePdf("Second bank statement") });
    await act(id, "APPROVE", { invoiceLogged: true, invoiceDialogConfirmed: true, dsrExceptionJustification: "Second statement (Zenith) shows N95m average monthly inflows; repayment covered" });
    const dec = (await db.query("SELECT reason FROM decisions WHERE application_id = $1 AND stage = 'FIRST_CREDIT_REVIEW'", [id])).rows[0];
    expect(dec.reason).toMatch(/^DSR exception: Second statement/);
    expect((await audits("DSR_EXCEPTION_APPROVED")).length).toBe(1);
    const mail = (await outbox("ASSIGNMENT")).filter((m) => m.application_id === id).at(-1);
    expect(mail.body_text).toContain("DSR exception approved at first credit review: Second statement (Zenith)");
    expect(mail.body_text).toContain("Assessed monthly turnover: ₦77,500,000.00 (verified monthly figure)");
    expect(mail.body_text).toContain("Proposed monthly repayment: ₦9,583,333.33 (flat markup 15% over 6 months)");
    expect(mail.body_text).toContain("DSR: 12.37% against the 10% threshold - EXCEEDS THRESHOLD by ₦1,833,333.33 per month (flagged for review)");
  });
});

describe("pricing bands and tenor", () => {
  it.each([
    [1, "10"],
    [2, "10"],
    [3, "10"], // exactly 3 months is in the lower band (bank clarification)
    [4, "15"],
    [5, "15"],
    [6, "15"],
  ])("%i month(s) → %s%% flat, regardless of amount", (tenor, rate) => {
    for (const principalKobo of [100, NAIRA(9_999_999), NAIRA(10_000_000), NAIRA(50_000_000)]) {
      expect(calculatePricing({ ...base, principalKobo, tenorMonths: tenor }, S).facility.flatMarkupRatePercent).toBe(rate);
    }
  });
  it("markup is applied once for the whole tenor", () => {
    const r = calculatePricing({ ...base, tenorMonths: 6 }, S);
    expect(r.facility.markupKobo).toBe(150_000_000); // 15% of ₦10m, not 15% × 6
  });
  it("enforces the six-month ceiling and rejects invalid inputs", () => {
    expect(() => calculatePricing({ ...base, tenorMonths: 7 }, S)).toThrow(/Check the assessment inputs/);
    expect(() => calculatePricing({ ...base, tenorMonths: 0 }, S)).toThrow();
    expect(() => calculatePricing({ ...base, tenorMonths: 2.5 }, S)).toThrow();
    expect(() => calculatePricing({ ...base, tenorMonths: 7 }, { ...S, maxTenorMonths: 9 })).toThrow(); // absolute ceiling even if settings were wrong
    expect(() => calculatePricing({ ...base, tenorMonths: 5 }, { ...S, maxTenorMonths: 4 })).toThrow(expect.objectContaining({ fields: expect.objectContaining({ tenorMonths: expect.stringMatching(/from 1 to 4/) }) }));
    expect(() => calculatePricing({ ...base, annualTurnoverKobo: 0 }, S)).toThrow();
    expect(() => calculatePricing({ ...base, annualTurnoverKobo: -1 }, S)).toThrow();
    expect(() => calculatePricing({ ...base, principalKobo: 0 }, S)).toThrow();
    expect(() => calculatePricing({ ...base, existingObligationsKobo: -1 }, S)).toThrow();
    expect(() => calculatePricing({ ...base, verifiedMonthlyTurnoverKobo: 0, overrideReason: "verified figure" }, S)).toThrow();
    expect(() => calculatePricing({ ...base, verifiedMonthlyTurnoverKobo: 1_000, overrideReason: "" }, S)).toThrow();
  });
  it("the assessment form requires an explicit obligations figure (0 when none)", () => {
    expect(() => parseCalculatorForm({ annualTurnoverKobo: "1,200,000", principalKobo: "100,000", tenorMonths: "3", existingObligationsKobo: "", repaymentFrequency: "MONTHLY", facilityType: "MURABAHA", takafulPercent: "0", stampDutyPercent: "0.125" })).toThrow(
      /Check the assessment inputs/,
    );
    const ok = parseCalculatorForm({ annualTurnoverKobo: "1,200,000", principalKobo: "100,000", tenorMonths: "3", existingObligationsKobo: "0", repaymentFrequency: "MONTHLY", facilityType: "MURABAHA", takafulPercent: "0", stampDutyPercent: "0.125" });
    expect(ok.existingObligationsKobo).toBe(0);
    expect(ok.verifiedMonthlyTurnoverKobo).toBeUndefined();
  });
});

describe("threshold comparison", () => {
  // ₦60,000 over 6 months at 15%: monthly repayment exactly ₦11,500.00
  const p = { annualTurnoverKobo: 1, principalKobo: 6_000_000, tenorMonths: 6, existingObligationsKobo: 0, overrideReason: "verified monthly figure" };
  it("a DSR of exactly 10% is within the threshold", () => {
    const r = calculatePricing({ ...p, verifiedMonthlyTurnoverKobo: 11_500_000 }, S);
    expect(r.capacity.totalDsrPercent).toBe("10.00");
    expect(r.capacity.result).toBe("WITHIN_THRESHOLD");
    expect(r.capacity.excessKobo).toBe(0);
  });
  it("a DSR slightly above 10% that displays as 10.00% still exceeds (unrounded comparison)", () => {
    const r = calculatePricing({ ...p, verifiedMonthlyTurnoverKobo: 11_494_300 }, S);
    expect(r.capacity.totalDsrPercent).toBe("10.00");
    expect(r.capacity.totalDsrPercent4).toBe("10.0050");
    expect(r.capacity.result).toBe("EXCEEDS_THRESHOLD");
    expect(formatKobo(r.capacity.excessKobo)).toBe("₦5.70");
  });
  it("existing obligations drive Total DSR separately from Facility DSR", () => {
    const r = calculatePricing({ ...p, verifiedMonthlyTurnoverKobo: 23_000_000, existingObligationsKobo: 1_500_000 }, S);
    expect(r.capacity.facilityDsrPercent).toBe("5.00");
    expect(r.capacity.totalDsrPercent).toBe("11.52");
    expect(r.capacity.result).toBe("EXCEEDS_THRESHOLD");
    expect(formatKobo(r.capacity.excessKobo)).toBe("₦3,500.00"); // 11,500 + 15,000 − 23,000
    // (10% × 230,000 − 15,000) × 6 / 1.15 = 41,739.13…
    expect(formatKobo(r.capacity.maxAffordablePrincipalKobo)).toBe("₦41,739.13");
    expect(dsrExplanation(r.capacity)).toMatch(/^The proposed monthly repayment plus existing obligations represent 11\.52%/);
  });
  it("no capacity → indicative maximum of zero", () => {
    const r = calculatePricing({ ...p, verifiedMonthlyTurnoverKobo: 1_000_000, existingObligationsKobo: 200_000 }, S);
    expect(r.capacity.maxAffordablePrincipalKobo).toBe(0);
  });
});

describe("turnover override", () => {
  it("annual ÷ 12 is the default; a verified monthly figure needs a reason and both are retained", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await act(id, "ENDORSE");
    const t = await openTaskOf(id);
    const ctx = await ctxFor(t.email!);
    const inputs = { annualTurnoverKobo: NAIRA(24_000_000), principalKobo: NAIRA(1_000_000), tenorMonths: 6, existingObligationsKobo: 0, facilityType: "MURABAHA", takafulPercent: "0", stampDutyPercent: "0.125" };
    let r = await recordAssessment(ctx, id, inputs);
    expect((r.outputs as { pricing: { turnover: { basis: string; monthlyTurnoverUsedKobo: number } } }).pricing.turnover).toMatchObject({ basis: "ANNUAL_DIV_12", monthlyTurnoverUsedKobo: NAIRA(2_000_000) });
    await expect(recordAssessment(ctx, id, { ...inputs, verifiedMonthlyTurnoverKobo: NAIRA(1_900_000) })).rejects.toMatchObject({ fields: { overrideReason: expect.any(String) } });
    r = await recordAssessment(ctx, id, { ...inputs, verifiedMonthlyTurnoverKobo: NAIRA(1_900_000), monthlyTurnoverOverrideReason: "Seasonal spike excluded from statements" });
    expect((r.outputs as { pricing: { turnover: Record<string, unknown> } }).pricing.turnover).toMatchObject({ basis: "VERIFIED_MONTHLY", derivedMonthlyTurnoverKobo: NAIRA(2_000_000), monthlyTurnoverUsedKobo: NAIRA(1_900_000) });
    const ev = (await audits("ASSESSMENT_RECORDED")).at(-1);
    expect(ev.details).toMatchObject({ annualTurnoverKobo: NAIRA(24_000_000), verifiedMonthlyTurnoverKobo: NAIRA(1_900_000), overrideReason: "Seasonal spike excluded from statements" });
    // Each change creates a new assessment; earlier ones are superseded, not overwritten.
    const rows = (await db.query("SELECT superseded_at FROM credit_assessments WHERE application_id = $1", [id])).rows;
    expect(rows.length).toBe(2);
    expect(rows.filter((x) => x.superseded_at === null).length).toBe(1);
  });
  it("only the assigned first reviewer may assess; principal ≤ ₦50m and within the request's credit route", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await act(id, "ENDORSE");
    await expect(recordAssessment(await ctxFor("co2@altbank.ng"), id, ACCEPTANCE_INPUTS)).rejects.toThrow(/assigned first credit reviewer/);
    const ctx = await ctxFor((await openTaskOf(id)).email!);
    // Above the requested amount is fine within the same route (Route 1 up to ₦5m)
    const ok = await recordAssessment(ctx, id, { ...ACCEPTANCE_INPUTS, principalKobo: NAIRA(5_000_000) });
    expect((ok.outputs as { amountApprovedKobo: number }).amountApprovedKobo).toBe(NAIRA(5_000_000));
    await expect(recordAssessment(ctx, id, { ...ACCEPTANCE_INPUTS, principalKobo: NAIRA(5_000_000) + 1 })).rejects.toMatchObject({ fields: { principalKobo: expect.stringMatching(/Route 2.*Route 1.*amend the amount/) } });
    await expect(recordAssessment(ctx, id, { ...ACCEPTANCE_INPUTS, principalKobo: NAIRA(50_000_000) + 1 })).rejects.toMatchObject({ fields: { principalKobo: expect.stringMatching(/single obligation limit/) } });
  });
});

describe("Super Admin pricing settings", () => {
  it("only the Super Admin can change settings; ceiling and prospective-only enforced; old/new/reason audited", async () => {
    const now = new Date();
    await expect(updatePricingSettings(await ctxFor("co1@altbank.ng", now), { maxTenorMonths: 6, shortRatePercent: "11", longRatePercent: "16", reason: "Repricing" })).rejects.toThrow(/Only the Super Admin/);
    expect((await audits("PRICING_SETTINGS_CHANGED")).at(-1).outcome).toBe("DENIED");
    const sa = await ctxFor("superadmin@altbank.ng", now);
    await expect(updatePricingSettings(sa, { maxTenorMonths: 7, shortRatePercent: "10", longRatePercent: "15", reason: "Longer tenor" })).rejects.toMatchObject({ fields: { maxTenorMonths: expect.any(String) } });
    await expect(updatePricingSettings(sa, { maxTenorMonths: 6, shortRatePercent: "0", longRatePercent: "15", reason: "Zero rate" })).rejects.toMatchObject({ fields: { shortRatePercent: expect.any(String) } });
    await expect(updatePricingSettings(sa, { maxTenorMonths: 6, shortRatePercent: "10", longRatePercent: "15", reason: "x" })).rejects.toMatchObject({ fields: { reason: expect.any(String) } });
    await expect(updatePricingSettings(sa, { maxTenorMonths: 6, shortRatePercent: "10", longRatePercent: "15", reason: "Backdated", effectiveFrom: new Date(now.getTime() - 86_400_000) })).rejects.toMatchObject({ fields: { effectiveFrom: expect.any(String) } });
    // Direct database writes cannot bypass the ceiling or rewrite history.
    await expect(db.query("INSERT INTO pricing_settings (version, max_tenor_months, short_rate_e4, long_rate_e4, effective_from, reason) VALUES (99, 7, 100000, 150000, now(), 'bypass')")).rejects.toThrow(/check constraint/);
    await expect(db.query("UPDATE pricing_settings SET long_rate_e4 = 1")).rejects.toThrow(/append-only/);
    const v3 = await updatePricingSettings(sa, { maxTenorMonths: 4, shortRatePercent: "12", longRatePercent: "17.5", reason: "Board pricing review Q4" });
    expect(v3.version).toBe(3);
    expect(v3.longBandFromMonths).toBe(4); // band boundary carried forward
    const ev = (await audits("PRICING_SETTINGS_CHANGED")).at(-1);
    expect(ev.outcome).toBe("SUCCESS");
    expect(ev.reason).toBe("Board pricing review Q4");
    expect(ev.details).toMatchObject({ old: { version: 2, maxTenorMonths: 6, shortRate: "10", longRate: "15" }, new: { version: 3, maxTenorMonths: 4, shortRate: "12", longRate: "17.5" } });
    expect(ev.details.effectiveFrom).toBeDefined();
    expect((await pricingSettingsAt(db, new Date(now.getTime() + 1000))).maxTenorMonths).toBe(4);
  });

  it("new settings apply prospectively: approved facilities keep their pricing snapshot; drafts must be recalculated", async () => {
    // Case A approved under v1 (15% for 6 months)
    const a = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await act(a, "ENDORSE");
    await approveFirstReview(a);
    // Case B assessed under v1 but not yet approved
    const b = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(2_000_000) });
    await act(b, "ENDORSE");
    await prepareFirstReview(b);
    const sa = await ctxFor("superadmin@altbank.ng");
    await updatePricingSettings(sa, { maxTenorMonths: 6, shortRatePercent: "10", longRatePercent: "20", reason: "Long band repriced" });
    // A: approved snapshot untouched; the offer later still uses 15%
    await act(a, "APPROVE");
    await act(a, "APPROVE");
    await act(a, "APPROVE");
    const snap = await approvedAssessment(db, a);
    expect(snap!.outputs).toMatchObject({ flatMarkupRatePercent: "15" });
    const r = await generateOffer(await ctxFor("rm.ade@altbank.ng"), a);
    expect(r.format).toBe("DOCX");
    const offerAudit = (await audits("OFFER_GENERATED")).at(-1);
    expect(offerAudit.details.assessmentId).toBe(snap!.id);
    // B: approval blocked until recalculated under v2, which then prices at 20%
    await expect(act(b, "APPROVE", { invoiceLogged: true, invoiceDialogConfirmed: true })).rejects.toThrow(/pricing settings changed since this assessment \(v2 → v3\)/i);
    const ctxB = await ctxFor((await openTaskOf(b)).email!);
    const re = await recordAssessment(ctxB, b, { annualTurnoverKobo: NAIRA(48_000_000), principalKobo: NAIRA(2_000_000), tenorMonths: 6, existingObligationsKobo: 0, facilityType: "MURABAHA", takafulPercent: "0", stampDutyPercent: "0.125" });
    expect((re.outputs as { flatMarkupRatePercent: string }).flatMarkupRatePercent).toBe("20");
    await act(b, "APPROVE", { invoiceLogged: true, invoiceDialogConfirmed: true });
    expect((await openTaskOf(b)).stage).toBe("SECOND_CREDIT_REVIEW");
  });

  it("request submission enforces the configured maximum tenor", async () => {
    const sa = await ctxFor("superadmin@altbank.ng");
    await updatePricingSettings(sa, { maxTenorMonths: 4, shortRatePercent: "10", longRatePercent: "15", reason: "Shorter maximum" });
    const rm = await ctxFor("rm.ade@altbank.ng");
    const { id } = await createDraft(rm, { initiatorRole: "RM", applicantType: "INDIVIDUAL" });
    await saveDraft(rm, id, { data: { tenorMonths: 6 } });
    const err = await submitApplication(rm, id, key()).catch((e) => e);
    expect(err.fields.tenorMonths).toMatch(/from 1 to 4/);
  });
});

describe("weekly repayment", () => {
  it("4 weekly instalments a month; DSR uses the monthly equivalent; APR on a weekly basis", () => {
    const m = calculatePricing({ ...base, tenorMonths: 3 }, S);
    const w = calculatePricing({ ...base, tenorMonths: 3, repaymentFrequency: "WEEKLY" }, S);
    expect(w.facility.numberOfInstalments).toBe(12);
    expect(formatKobo(w.facility.instalmentKobo)).toBe("₦916,666.67"); // ₦11m ÷ 12
    expect(w.facility.monthlyRepaymentKobo).toBe(m.facility.monthlyRepaymentKobo);
    expect(w.capacity.totalDsrPercent4).toBe(m.capacity.totalDsrPercent4);
  });
  it("weekly instalments flow to the offer letter", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(400_000) });
    await act(id, "ENDORSE");
    const ctx = await ctxFor((await openTaskOf(id)).email!);
    for (let i = 1; i <= 3; i++) await uploadDocument(ctx, { applicationId: id, category: "CREDIT_REPORT", filename: `r${i}.pdf`, data: makePdf("r") });
    const r = await recordAssessment(ctx, id, { annualTurnoverKobo: NAIRA(24_000_000), principalKobo: NAIRA(400_000), tenorMonths: 3, existingObligationsKobo: 0, repaymentFrequency: "WEEKLY", facilityType: "MURABAHA", takafulPercent: "0.75", stampDutyPercent: "0.125" });
    expect(r.aprPercent).toBe("80.3077"); // 96 × (10% + 0.75% + 0.125%) ÷ 13
    await act(id, "APPROVE", { invoiceLogged: true, invoiceDialogConfirmed: true });
    await act(id, "APPROVE");
    await act(id, "APPROVE");
    await act(id, "APPROVE");
    await preparePack(id);
    const offer = (await listDocuments(db, id)).find((d) => d.category === "GENERATED_OFFER")!;
    const { data } = await readDocumentForActor(await ctxFor("rm.ade@altbank.ng"), offer.id, "download");
    const xml = await (await JSZip.loadAsync(data)).file("word/document.xml")!.async("string");
    const text = xml.replace(/<[^>]+>/g, "");
    expect(text).toContain("Equal weekly payment of N36,666.67"); // ₦440,000 ÷ 12, as in the bank's sample letter
    expect(text).toContain("N440,000.00 (Four Hundred and Forty Thousand Naira Only)");
    expect(text).toMatch(/\(10%\)/);
  });
});

describe("approved principal and booking", () => {
  it("disbursement is checked against the approved principal from the assessment", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await act(id, "ENDORSE");
    const ctx = await ctxFor((await openTaskOf(id)).email!);
    for (let i = 1; i <= 3; i++) await uploadDocument(ctx, { applicationId: id, category: "CREDIT_REPORT", filename: `r${i}.pdf`, data: makePdf("r") });
    await recordAssessment(ctx, id, { annualTurnoverKobo: NAIRA(24_000_000), principalKobo: NAIRA(800_000), tenorMonths: 6, existingObligationsKobo: 0, repaymentFrequency: "MONTHLY", facilityType: "MURABAHA", takafulPercent: "0", stampDutyPercent: "0.125" });
    await act(id, "APPROVE", { invoiceLogged: true, invoiceDialogConfirmed: true });
    await act(id, "APPROVE");
    await act(id, "APPROVE");
    await act(id, "APPROVE");
    await preparePack(id);
    await act(id, "SUBMIT_PACK");
    await uploadDocument(await ctxFor("co3@altbank.ng"), { applicationId: id, category: "INSURANCE_EVIDENCE", filename: "i.pdf", data: makePdf("i") });
    await act(id, "FORWARD");
    await act(id, "OKAY", { crmsLogged: true });
    const t = await openTaskOf(id);
    const book = (amount: number) =>
      performTaskAction(ctxFor_(t.email!), { taskId: t.id, action: "DISBURSED", idempotencyKey: key(), booking: { amountKobo: amount, disbursedOn: "2026-11-01", transactionRef: `TX${amount}`, schedule: [{ dueDate: "2026-12-01", amountKobo: 100 }] } });
    const ctxFor_ = (e: string) => ({ ...ctx, actor: { ...ctx.actor!, staffId: t.assignee_id!, email: e } });
    await expect(book(NAIRA(800_000) + 1)).rejects.toMatchObject({ fields: { amount: expect.stringMatching(/₦800,000\.00/) } });
    await book(NAIRA(800_000));
    expect((await db.query("SELECT approved_amount_kobo FROM disbursements WHERE application_id = $1", [id])).rows[0].approved_amount_kobo).toBe(String(NAIRA(800_000)));
  });
});

describe("second signatory", () => {
  it("is configurable by the Super Admin only, audited, and printed on Individual/Enterprise letters", async () => {
    await expect(updateSecondSignatory(await ctxFor("co1@altbank.ng"), { name: "X Y", title: "Head", reason: "change" })).rejects.toThrow(/Only the Super Admin/);
    await updateSecondSignatory(await ctxFor("superadmin@altbank.ng"), { name: "Ada Signatory", title: "Head, Payment & Collection", reason: "Signatory confirmed by Operations" });
    const ev = (await audits("OFFER_SIGNATORY_CHANGED")).filter((e) => e.outcome === "SUCCESS").at(-1);
    expect(ev.details).toMatchObject({ old: { version: 1, name: "" }, new: { version: 2, name: "Ada Signatory" } });
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await driveToOffer(id);
    await preparePack(id);
    const offer = (await listDocuments(db, id)).find((d) => d.category === "GENERATED_OFFER")!;
    const { data } = await readDocumentForActor(await ctxFor("rm.ade@altbank.ng"), offer.id, "download");
    const text = (await (await JSZip.loadAsync(data)).file("word/document.xml")!.async("string")).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
    expect(text).toContain("Ada Signatory");
    expect(text).toContain("Head, Payment & Collection");
  });
});
