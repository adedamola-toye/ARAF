import type { AprCalculator, CalculatorResult } from "./types";
import { calculatePricing, dsrExplanation, ABSOLUTE_MAX_TENOR } from "../pricing";
import { DomainError, invalid } from "../../errors";
import { parsePercentE4 } from "../../money";

/**
 * "wakeelboost-pricing@2026.1": WakeelBoost DSR and facility pricing calculator.
 *  - Flat markup by tenor band and DSR / repayment capacity per the bank's WakeelBoost rules
 *    (src/server/domain/pricing.ts), using the pricing settings in force (snapshotted in the output).
 *  - APR disclosure kept as a separate figure, using the bank APR workbook formula
 *    APR = 2nc / L(N+1) with monthly payments (n = 12, N = tenor) and c = markup + Takaful + stamp duty.
 */
export const wakeelboostPricingCalculator: AprCalculator = {
  id: "wakeelboost-pricing",
  version: "2026.1",
  label: "WakeelBoost DSR and facility pricing (flat markup by tenor) with APR disclosure",
  productionValidated: true,
  usesPricingSettings: true,
  fields: [
    { key: "annualTurnoverKobo", label: "Verified annual business turnover (12-month statement review)", kind: "money" },
    { key: "verifiedMonthlyTurnoverKobo", label: "Verified monthly turnover (optional; replaces annual ÷ 12)", kind: "money", optional: true },
    { key: "monthlyTurnoverOverrideReason", label: "Reason for using the verified monthly figure", kind: "text", optional: true },
    { key: "principalKobo", label: "Requested facility principal", kind: "money", defaultFrom: "requestedAmount" },
    { key: "tenorMonths", label: "Facility tenor (months)", kind: "integer", defaultFrom: "tenorMonths" },
    { key: "existingObligationsKobo", label: "Verified existing monthly repayment obligations (enter 0 if none)", kind: "money" },
    { key: "facilityType", label: "Facility type (APR disclosure)", kind: "select", defaultValue: "MURABAHA", options: [{ value: "MURABAHA", label: "Murabaha" }, { value: "IJARAH", label: "Ijarah" }] },
    { key: "takafulPercent", label: "Takaful contribution % (APR disclosure)", kind: "percent", defaultValue: "0" },
    { key: "stampDutyPercent", label: "Stamp duty % (APR disclosure)", kind: "percent", defaultValue: "0.125" },
  ],
  calculate(inputs, context): CalculatorResult {
    if (!context?.pricing) throw new DomainError("CONFIG", "Pricing settings are required for the WakeelBoost calculator.");
    const num = (k: string) => (inputs[k] === undefined || inputs[k] === "" ? NaN : Number(inputs[k]));
    const override = inputs.verifiedMonthlyTurnoverKobo !== undefined && inputs.verifiedMonthlyTurnoverKobo !== "" && inputs.verifiedMonthlyTurnoverKobo !== null;
    const tenor = num("tenorMonths");
    if (tenor > ABSOLUTE_MAX_TENOR) throw invalid("Check the assessment inputs.", { tenorMonths: `WakeelBoost tenor cannot exceed ${ABSOLUTE_MAX_TENOR} months.` });
    const r = calculatePricing(
      {
        annualTurnoverKobo: num("annualTurnoverKobo"),
        verifiedMonthlyTurnoverKobo: override ? num("verifiedMonthlyTurnoverKobo") : null,
        overrideReason: override ? String(inputs.monthlyTurnoverOverrideReason ?? "") : null,
        principalKobo: num("principalKobo"),
        tenorMonths: tenor,
        existingObligationsKobo: num("existingObligationsKobo"),
      },
      context.pricing,
    );
    const ft = String(inputs.facilityType ?? "MURABAHA");
    if (ft !== "MURABAHA" && ft !== "IJARAH") throw invalid("Facility type must be Murabaha or Ijarah.");
    const tak = parsePercentE4(String(inputs.takafulPercent ?? "0"));
    const stamp = parsePercentE4(String(inputs.stampDutyPercent ?? "0"));
    if (tak === null || stamp === null) throw invalid("Enter Takaful and stamp duty as percentages.");
    // APR (workbook formula, monthly): c/L = flat markup + takaful% + stamp%  →  APR = 24 (c/L) / (T + 1)
    const rateE4 = BigInt(Math.round(Number(r.facility.flatMarkupRatePercent) * 10_000));
    const sum = rateE4 + BigInt(tak) + BigInt(stamp);
    const aprE4 = (2n * 24n * sum + BigInt(tenor + 1)) / (2n * BigInt(tenor + 1));
    const pct4 = (v: bigint) => `${v / 10000n}.${(v % 10000n).toString().padStart(4, "0")}`;
    const P = BigInt(r.facility.principalKobo);
    const takafulKobo = Number((2n * P * BigInt(tak) + 1_000_000n) / 2_000_000n);
    const stampKobo = Number((2n * P * BigInt(stamp) + 1_000_000n) / 2_000_000n);
    return {
      aprPercent: pct4(aprE4),
      dsrPercent: r.capacity.totalDsrPercent4,
      markupKobo: r.facility.markupKobo,
      costPlusMarkupKobo: r.facility.totalRepaymentKobo,
      thresholdResult: r.capacity.result,
      pricingSettingsId: r.settings.id,
      outputs: {
        pricing: r,
        explanation: dsrExplanation({ ...r.capacity }),
        apr: { aprPercent: pct4(aprE4), formula: "APR = 2nc / L(N+1), monthly payments", facilityType: ft, takafulKobo, stampDutyKobo: stampKobo, costOfFacilityKobo: r.facility.markupKobo + takafulKobo + stampKobo },
        // Normalised fields used by offer letters and notifications
        amountApprovedKobo: r.facility.principalKobo,
        flatMarkupRatePercent: r.facility.flatMarkupRatePercent,
        periodicInstalmentKobo: r.facility.monthlyRepaymentKobo,
        frequency: "Monthly",
      },
    };
  },
};
