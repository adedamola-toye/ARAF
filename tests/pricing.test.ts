import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { NAIRA, formatKobo } from "@/server/money";
import { calculatePricing, dsrExplanation, pricingSettingsAt, updatePricingSettings, type PricingSettings } from "@/server/domain/pricing";
import { parseCalculatorForm, recordAssessment, approvedAssessment } from "@/server/domain/assessment";
import { generateOffer } from "@/server/domain/offer";
import { createDraft, saveDraft, submitApplication } from "@/server/domain/workflow";
import { ACCEPTANCE_INPUTS, act, appRow, approveFirstReview, createSubmittedCase, ctxFor, openTaskOf, recordAcceptanceAssessment, prepareFirstReview } from "@/server/demo/scenario";
import { audits, key, outbox, resetDb } from "./helpers";

const S: PricingSettings = { id: "s1", version: 1, maxTenorMonths: 6, shortRateE4: 100_000, longRateE4: 150_000, thresholdE4: 100_000, effectiveFrom: new Date("2020-01-01") };
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
    expect(a.outputs.pricing.settings).toMatchObject({ version: 1, shortRatePercent: "10", longRatePercent: "15", maxTenorMonths: 6 });
    expect(a.assessor_id).toBe((await openTaskOf(id)).assignee_id);
    const ev = (await audits("ASSESSMENT_RECORDED")).at(-1);
    expect(ev.details).toMatchObject({ annualTurnoverKobo: 93_023_800_000, derivedMonthlyTurnover: "77519833.333333", verifiedMonthlyTurnoverKobo: 7_750_000_000, turnoverBasis: "VERIFIED_MONTHLY", thresholdResult: "EXCEEDS_THRESHOLD" });
    expect(ev.details.overrideReason).toMatch(/77,500,000/);
    // Exceeding the threshold does not block approval; it is flagged for review under the existing rules.
    await act(id, "APPROVE", { invoiceLogged: true, invoiceDialogConfirmed: true });
    const mail = (await outbox("ASSIGNMENT")).filter((m) => m.application_id === id).at(-1);
    expect(mail.body_text).toContain("Assessed monthly turnover: ₦77,500,000.00 (verified monthly figure)");
    expect(mail.body_text).toContain("Proposed monthly repayment: ₦9,583,333.33 (flat markup 15% over 6 months)");
    expect(mail.body_text).toContain("DSR: 12.37% against the 10% threshold - EXCEEDS THRESHOLD by ₦1,833,333.33 per month (flagged for review)");
  });
});

describe("pricing bands and tenor", () => {
  it.each([
    [1, "10"],
    [2, "10"],
    [3, "15"],
    [4, "15"],
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
    expect(() => parseCalculatorForm({ annualTurnoverKobo: "1,200,000", principalKobo: "100,000", tenorMonths: "3", existingObligationsKobo: "", facilityType: "MURABAHA", takafulPercent: "0", stampDutyPercent: "0.125" })).toThrow(
      /Check the assessment inputs/,
    );
    const ok = parseCalculatorForm({ annualTurnoverKobo: "1,200,000", principalKobo: "100,000", tenorMonths: "3", existingObligationsKobo: "0", facilityType: "MURABAHA", takafulPercent: "0", stampDutyPercent: "0.125" });
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
  it("only the assigned first reviewer may assess; principal cannot exceed the requested amount", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await act(id, "ENDORSE");
    await expect(recordAssessment(await ctxFor("co2@altbank.ng"), id, ACCEPTANCE_INPUTS)).rejects.toThrow(/assigned first credit reviewer/);
    const ctx = await ctxFor((await openTaskOf(id)).email!);
    await expect(recordAssessment(ctx, id, { ...ACCEPTANCE_INPUTS, principalKobo: NAIRA(1_000_001) })).rejects.toMatchObject({ fields: { principalKobo: expect.stringMatching(/cannot exceed the requested amount/) } });
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
    const v2 = await updatePricingSettings(sa, { maxTenorMonths: 4, shortRatePercent: "12", longRatePercent: "17.5", reason: "Board pricing review Q4" });
    expect(v2.version).toBe(2);
    const ev = (await audits("PRICING_SETTINGS_CHANGED")).at(-1);
    expect(ev.outcome).toBe("SUCCESS");
    expect(ev.reason).toBe("Board pricing review Q4");
    expect(ev.details).toMatchObject({ old: { version: 1, maxTenorMonths: 6, shortRate: "10", longRate: "15" }, new: { version: 2, maxTenorMonths: 4, shortRate: "12", longRate: "17.5" } });
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
    await expect(act(b, "APPROVE", { invoiceLogged: true, invoiceDialogConfirmed: true })).rejects.toThrow(/pricing settings changed since this assessment \(v1 → v2\)/i);
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
