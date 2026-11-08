import type { AprCalculator, CalculatorResult } from "./types";
import { applyBasisPoints, parsePercentToBp } from "../../money";
import { invalid } from "../../errors";

/**
 * DEVELOPMENT ADAPTER - "dev-illustrative@0.1"
 *
 * A placeholder calculator so the end-to-end workflow can be exercised before the bank's APR
 * workbook is supplied. It is NOT the bank's methodology and is flagged productionValidated=false,
 * so production credit approval is blocked while it is configured.
 *
 *   financed           = assetCost - equityContribution
 *   markup             = financed × markupRate (flat, for the whole tenor)
 *   costPlusMarkup     = financed + markup
 *   monthlyInstalment  = ceil(costPlusMarkup / tenorMonths)
 *   DSR %              = (existingMonthlyObligations + monthlyInstalment) / averageMonthlyInflow × 100
 *   APR %              = 12 × r × 100 where r is the monthly rate equating the instalment stream to `financed`
 *
 * It deliberately does not use the 15% illustrative portfolio return as an APR or DSR formula.
 */
export const devIllustrativeCalculator: AprCalculator = {
  id: "dev-illustrative",
  version: "0.1",
  label: "Development illustrative calculator (NOT bank validated)",
  productionValidated: false,
  fields: [
    { key: "assetCostKobo", label: "Asset cost", kind: "money", defaultFrom: "assetCost" },
    { key: "equityContributionKobo", label: "Customer equity contribution", kind: "money" },
    { key: "markupRatePercent", label: "Markup rate for tenor (%)", kind: "percent" },
    { key: "tenorMonths", label: "Tenor (months)", kind: "integer", defaultFrom: "tenorMonths" },
    { key: "averageMonthlyInflowKobo", label: "Average monthly inflow (12-month statements)", kind: "money" },
    { key: "existingMonthlyObligationsKobo", label: "Existing monthly obligations", kind: "money" },
  ],
  calculate(inputs): CalculatorResult {
    const num = (k: string) => {
      const v = Number(inputs[k] ?? 0);
      if (!Number.isSafeInteger(v) || v < 0) throw invalid(`Invalid value for ${k}.`);
      return v;
    };
    const assetCost = num("assetCostKobo");
    const equity = num("equityContributionKobo");
    const tenor = num("tenorMonths");
    const inflow = num("averageMonthlyInflowKobo");
    const obligations = num("existingMonthlyObligationsKobo");
    const bp = parsePercentToBp(String(inputs.markupRatePercent ?? ""));
    if (bp === null) throw invalid("Markup rate must be a percentage with up to 4 decimal places.");
    if (tenor < 1 || tenor > 60) throw invalid("Tenor must be between 1 and 60 months.");
    if (inflow <= 0) throw invalid("Average monthly inflow must be greater than zero.");
    if (equity >= assetCost) throw invalid("Equity contribution must be less than the asset cost.");

    const financed = assetCost - equity;
    const markup = applyBasisPoints(financed, bp);
    const costPlusMarkup = financed + markup;
    const instalment = Math.ceil(costPlusMarkup / tenor);
    // DSR in basis points with exact integer math, then formatted to 4dp percent.
    const dsrE4 = (BigInt(obligations + instalment) * 1_000_000n) / BigInt(inflow); // percent × 10^4
    const dsrPercent = formatE4(dsrE4);

    const monthly = solveMonthlyRate(financed, instalment, tenor);
    const aprPercent = (monthly * 12 * 100).toFixed(4);
    return {
      aprPercent,
      dsrPercent,
      markupKobo: markup,
      costPlusMarkupKobo: costPlusMarkup,
      outputs: {
        financedKobo: financed,
        monthlyInstalmentKobo: instalment,
        markupRateBp: bp,
      },
    };
  },
};

function formatE4(v: bigint): string {
  const s = v.toString().padStart(5, "0");
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
}

/** Bisection for r in PV(r) = principal, PV = instalment × (1 - (1+r)^-n) / r. */
export function solveMonthlyRate(principal: number, instalment: number, n: number): number {
  if (instalment * n <= principal) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const pv = (instalment * (1 - Math.pow(1 + mid, -n))) / mid;
    if (pv > principal) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
