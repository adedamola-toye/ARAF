import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { openTaskOf } from "@/server/demo/scenario";
import { applyConfig, createRetailCase, driveBusinessReview, recordFinal, syntheticConfig } from "@/server/demo/retail-scenario";
import { computeAffordability, rulesSnapshot, type AffordabilityInput } from "@/server/domain/affordability";
import { productConfigSchema, type ProfileRules } from "@/server/domain/products";
import { retailReadiness } from "@/server/domain/retail";

const N = (n: number) => n * 100;

/** The business's retail policy: average monthly inflow from annual inflow (100%), DSR ≤ 30%, at least 12 months. */
function retailPolicy(c: ReturnType<typeof syntheticConfig>) {
  for (const r of Object.values(c.profiles)) {
    if (!r) continue;
    r.dsr.maxPercent = "30";
    r.dsr.denominator = "AVERAGE_MONTHLY_INFLOW_FROM_ANNUAL";
    r.dsr.inflowRecognitionPercent = "100";
    r.minTenorMonths = 12;
    r.maxTenorMonths = 36;
  }
}

const rules = (tweak?: (r: ProfileRules) => void) => {
  const c = productConfigSchema.parse(syntheticConfig("VENDOR_FINANCING", retailPolicy));
  const r = c.profiles.BUSINESS_OWNER!;
  tweak?.(r);
  return rulesSnapshot({ configId: "cfg", configVersion: 9, productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", structure: r.structures[0].code, rules: r });
};
const input = (o: Partial<AffordabilityInput> = {}): AffordabilityInput => ({
  kind: "PRELIMINARY",
  applicantType: "ENTERPRISE",
  incomeBasisKobo: null,
  annualInflowKobo: N(12_200_000), // ₦12.2m a year → ₦1,016,666.67 a month
  incomeBasisNote: "",
  statementFrom: null,
  statementTo: null,
  evidenceDocumentIds: [],
  existingObligations: [{ lender: "Other bank", facilityType: "Loan", monthlyRepaymentKobo: N(100_000), outstandingKobo: null }],
  principalKobo: N(2_000_000),
  tenorMonths: 12,
  proposedMonthlyObligationKobo: N(150_000),
  turnoverForCapKobo: null,
  assetCostKobo: null,
  equityContributionKobo: null,
  charges: [],
  firstDueDate: null,
  ...o,
});

describe("DSR from annual inflow (retail policy)", () => {
  it("average monthly inflow = annual ÷ 12; obligations + instalment up to 30% pass, above fail", () => {
    // The synthetic structure has a configured rate, so the instalment is calculated from the terms:
    // ₦2m at 23% flat per annum over 12 months = ₦2.46m ÷ 12 = ₦205,000; with ₦100,000 existing = ₦305,000.
    // ₦305,000 ÷ (₦12.2m ÷ 12) = exactly 30%.
    const out = computeAffordability(rules(), input());
    expect(out.dsr).toMatchObject({ percent: "30.0000", pass: true, denominatorKobo: 101_666_667, annualInflowKobo: N(12_200_000), recognitionPercent: "100", allowedMonthlyKobo: N(305_000) });
    expect(out.result).toBe("PASS");
    expect(out.formula.join("\n")).toMatch(/Average monthly inflow = recognised annual inflow ÷ 12 = ₦1,016,666\.67/);
    expect(out.formula.join("\n")).toMatch(/Allowable monthly obligations = ₦1,016,666\.67 × 30% = ₦305,000\.00/);
    const over = computeAffordability(rules(), input({ annualInflowKobo: N(12_199_988) })); // a touch less inflow: just over 30%
    expect(over.dsr?.pass).toBe(false);
    expect(over.result).toBe("FAIL");
  });

  it("applies the inflow recognition factor when configured (e.g. 75%)", () => {
    const out = computeAffordability(rules((r) => (r.dsr.inflowRecognitionPercent = "75")), input());
    expect(out.dsr).toMatchObject({ denominatorKobo: N(762_500), recognisedAnnualKobo: N(9_150_000), recognitionPercent: "75", percent: "40.0000", pass: false });
  });

  it("enforces the 12-month minimum repayment period and needs the annual inflow", () => {
    const short = computeAffordability(rules(), input({ tenorMonths: 6 }));
    expect(short.checks.find((c) => c.rule === "At least 12 months")).toMatchObject({ pass: false });
    expect(short.result).toBe("FAIL");
    const missing = computeAffordability(rules(), input({ annualInflowKobo: null }));
    expect(missing.checks.find((c) => c.rule === "Verified annual inflow entered")).toMatchObject({ pass: false });
    expect(missing.dsr).toBeNull();
  });

  it("other denominators are unchanged (monthly basis entered directly)", () => {
    const r = rules((x) => (x.dsr.denominator = "AVERAGE_MONTHLY_BUSINESS_TURNOVER"));
    const out = computeAffordability(r, input({ annualInflowKobo: null, incomeBasisKobo: N(1_220_000) }));
    expect(out.dsr).toMatchObject({ percent: "25.0000", pass: true, denominatorKobo: N(1_220_000) });
    expect(out.dsr?.annualInflowKobo).toBeUndefined();
  });
});

describe("origination and credit review", () => {
  beforeEach(async () => {
    await resetDb();
    await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING", retailPolicy));
  });

  it("readiness asks for the annual inflow and the minimum tenor", async () => {
    const id = await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(2_000_000), tenorMonths: 6, data: { annualInflowKobo: null }, submit: false });
    const r = await retailReadiness(db, id, new Date());
    expect(r.fieldErrors.annualInflowKobo).toMatch(/annual inflow/);
    expect(r.fieldErrors.tenorMonths).toMatch(/minimum repayment period .* 12 months/);
  });

  it("the preliminary assessment is stored at submission; credit changes need a reason and are recorded", async () => {
    const c = { id: await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(2_000_000), tenorMonths: 12, data: { annualInflowKobo: N(24_000_000) } }) };
    const pre = (await db.query("SELECT result, outputs FROM retail_assessments WHERE application_id = $1 AND kind = 'PRELIMINARY'", [c.id])).rows[0];
    expect(pre.outputs.dsr).toMatchObject({ denominatorKobo: N(2_000_000), annualInflowKobo: N(24_000_000) });
    expect(pre.outputs.engineVersion).toBe("retail-affordability@2");
    await driveBusinessReview(c.id);
    expect((await openTaskOf(c.id)).stage).toBe("FIRST_CREDIT_REVIEW");
    // The reviewer verifies a lower annual inflow: refused without a reason, recorded with one.
    await expect(recordFinal(c.id, { annualInflowKobo: N(18_000_000), adjustmentNote: "" })).rejects.toMatchObject({ code: "VALIDATION" });
    const r = await recordFinal(c.id, { annualInflowKobo: N(18_000_000), adjustmentNote: "Statements show ₦18m credits over 12 months" });
    expect(r.changes).toEqual([{ field: "annual inflow", previous: N(24_000_000), revised: N(18_000_000) }]);
    const a = (await db.query("SELECT reason, details FROM audit_events WHERE action = 'CREDIT_ASSESSMENT_ADJUSTED' AND application_id = $1", [c.id])).rows[0];
    expect(a.reason).toMatch(/₦18m credits/);
    expect(a.details.changes[0]).toMatchObject({ field: "annual inflow" });
    // Earlier versions are kept (superseded), never deleted.
    expect((await db.query("SELECT count(*)::int AS n FROM retail_assessments WHERE application_id = $1", [c.id])).rows[0].n).toBe(2);
  });
});
