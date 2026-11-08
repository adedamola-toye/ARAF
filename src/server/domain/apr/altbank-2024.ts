import type { AprCalculator, CalculatorResult } from "./types";
import { divRoundHalfUp, parsePercentE4 } from "../../money";
import { invalid } from "../../errors";

/**
 * "altbank-apr-2024@1.0" - implementation of the bank's workbook
 * "APR Model - ALTBANK v.1 2024" (sheets: Data, Amortization Schedule, APR Output).
 *
 * Workbook rules reproduced here:
 *   N (total payments)   = tenor / months-per-payment   (Bullet: 1)
 *   n (payments a year)  = 12 / months-per-payment      (Bullet: 12 / tenor)
 *   FIXED mark-up        = (rate / n) × L every period            -> total = rate × L × tenor / 12
 *   FIXED instalment     = L × (1 + rate × tenor / 12) / N
 *   Other ("REDUCING")   = PMT(rate / n, N, -L); mark-up = (rate / n) × opening balance
 *   Takaful              = takaful% × L      Stamp duty = stamp% × L
 *   c (cost of facility) = total mark-up + Takaful + stamp duty
 *   APR                  = 2nc / L(N + 1)    (APR Output!E11, non-overdraft)
 *
 * Notes on the workbook (v.1 2024):
 *   - "Total Mark-up" sums schedule rows 12–71 only, i.e. at most 60 payments. WakeelBoost tenors
 *     are capped at 60 months, so this never truncates here; longer tenors are refused.
 *   - The Administrative Fee input (Data!D13) is not used in any workbook formula; it is recorded
 *     but, like the workbook, excluded from the cost of facility.
 *   - OVERDRAFT is not a WakeelBoost facility type and is refused.
 *   - The workbook has no DSR. DSR here is (existing monthly obligations + monthly-equivalent
 *     instalment) / average monthly inflow. This definition needs bank confirmation, so the
 *     calculator stays productionValidated=false until the bank confirms it.
 */

const FREQUENCIES: Record<string, number | "BULLET"> = {
  Monthly: 1,
  "Bi-monthly": 2,
  Quarterly: 3,
  Termly: 4,
  "Bi-annually": 6,
  Annually: 12,
  Bullet: "BULLET",
};

function pct4(e4: bigint): string {
  const neg = e4 < 0n;
  const a = neg ? -e4 : e4;
  const s = a.toString().padStart(5, "0");
  return `${neg ? "-" : ""}${s.slice(0, -4)}.${s.slice(-4)}`;
}

export const altbankApr2024Calculator: AprCalculator = {
  id: "altbank-apr-2024",
  version: "1.0",
  label: "AltBank APR Model v.1 2024 (workbook implementation)",
  productionValidated: false,
  validationNote: "APR reproduces the bank workbook. DSR is not defined in the workbook: definition awaiting bank confirmation before production use.",
  fields: [
    { key: "facilityType", label: "Facility type", kind: "select", defaultValue: "MURABAHA", options: [{ value: "MURABAHA", label: "Murabaha" }, { value: "IJARAH", label: "Ijarah" }] },
    { key: "amountApprovedKobo", label: "Amount approved", kind: "money", defaultFrom: "requestedAmount" },
    { key: "markupRatePercent", label: "Mark-up / rental rate (% per annum)", kind: "percent" },
    { key: "rateType", label: "Rate type", kind: "select", defaultValue: "FIXED", options: [{ value: "FIXED", label: "Fixed (flat)" }, { value: "REDUCING", label: "Reducing balance" }] },
    { key: "frequency", label: "Instalment frequency", kind: "select", defaultValue: "Monthly", options: Object.keys(FREQUENCIES).map((f) => ({ value: f, label: f })) },
    { key: "tenorMonths", label: "Tenor (months)", kind: "integer", defaultFrom: "tenorMonths" },
    { key: "takafulPercent", label: "Takaful contribution (%)", kind: "percent", defaultValue: "0" },
    { key: "stampDutyPercent", label: "Stamp duty (%)", kind: "percent", defaultValue: "0.125" },
    { key: "adminFeePercent", label: "Administrative fee (%) - recorded, not in workbook cost", kind: "percent", defaultValue: "0" },
    { key: "averageMonthlyInflowKobo", label: "Average monthly inflow (12-month statements)", kind: "money" },
    { key: "existingMonthlyObligationsKobo", label: "Existing monthly obligations", kind: "money", optional: true },
  ],
  calculate(inputs): CalculatorResult {
    const int = (k: string) => {
      const v = Number(inputs[k] ?? 0);
      if (!Number.isSafeInteger(v) || v < 0) throw invalid(`Invalid value for ${k}.`);
      return v;
    };
    const pct = (k: string) => {
      const v = parsePercentE4(String(inputs[k] ?? ""));
      if (v === null) throw invalid(`Invalid percentage for ${k}.`);
      return BigInt(v);
    };
    const facilityType = String(inputs.facilityType ?? "MURABAHA");
    if (facilityType !== "MURABAHA" && facilityType !== "IJARAH") throw invalid("Facility type must be Murabaha or Ijarah.");
    const rateType = String(inputs.rateType ?? "FIXED");
    if (rateType !== "FIXED" && rateType !== "REDUCING") throw invalid("Rate type must be Fixed or Reducing.");
    const freq = FREQUENCIES[String(inputs.frequency ?? "")];
    if (freq === undefined) throw invalid("Choose an instalment frequency.");
    const L = int("amountApprovedKobo");
    const tenor = int("tenorMonths");
    const inflow = int("averageMonthlyInflowKobo");
    const obligations = int("existingMonthlyObligationsKobo");
    const rateE4 = pct("markupRatePercent"); // percent × 10^4  => rate = rateE4 / 10^6
    const takE4 = pct("takafulPercent");
    const stampE4 = pct("stampDutyPercent");
    pct("adminFeePercent");
    if (L <= 0) throw invalid("Amount approved must be greater than zero.");
    if (tenor < 1 || tenor > 60) throw invalid("Tenor must be between 1 and 60 months (the workbook schedule covers at most 60 payments).");
    if (inflow <= 0) throw invalid("Average monthly inflow must be greater than zero.");
    const k = freq === "BULLET" ? tenor : freq; // months per payment
    if (tenor % k !== 0) throw invalid(`A ${tenor}-month tenor cannot be paid ${String(inputs.frequency).toLowerCase()}.`);
    const N = tenor / k;

    const Lb = BigInt(L);
    const M = 1_000_000n; // percent × 10^4 -> fraction
    const takaful = divRoundHalfUp(Lb * takE4, M);
    const stamp = divRoundHalfUp(Lb * stampE4, M);

    let totalMarkup: bigint;
    let instalment: bigint;
    let aprE4: bigint;
    if (rateType === "FIXED") {
      totalMarkup = divRoundHalfUp(Lb * rateE4 * BigInt(tenor), M * 12n);
      instalment = divRoundHalfUp(Lb * (M * 12n + rateE4 * BigInt(tenor)), M * 12n * BigInt(N));
      // Exact, from the unrounded cost (as the workbook does): c/L = (rate×tenor/12 + takaful% + stamp%)
      aprE4 = divRoundHalfUp(2n * (rateE4 * BigInt(tenor) + 12n * (takE4 + stampE4)), BigInt(tenor + k));
    } else {
      // Reducing balance (workbook: PMT and mark-up on opening balance), double precision like Excel.
      const i = (Number(rateE4) / 1e6) * (k / 12);
      const pmt = i === 0 ? L / N : (L * i) / (1 - Math.pow(1 + i, -N));
      let bal = L;
      let sum = 0;
      for (let p = 0; p < N; p++) {
        const m = i * bal;
        sum += m;
        bal -= pmt - m;
      }
      totalMarkup = BigInt(Math.round(sum));
      instalment = BigInt(Math.round(pmt));
      const cUnrounded = sum + (L * (Number(takE4) + Number(stampE4))) / 1e6;
      aprE4 = BigInt(Math.round(((24 * cUnrounded) / (L * (tenor + k))) * 1e6));
    }
    const cost = totalMarkup + takaful + stamp;
    // APR = 2nc / L(N+1) with n = 12/k, N = tenor/k  =>  24c / L(tenor + k)  (computed above)
    const monthlyEquivalent = (instalment + BigInt(k) - 1n) / BigInt(k);
    const dsrE4 = divRoundHalfUp((BigInt(obligations) + monthlyEquivalent) * M, BigInt(inflow));
    return {
      aprPercent: pct4(aprE4),
      dsrPercent: pct4(dsrE4),
      markupKobo: Number(totalMarkup),
      costPlusMarkupKobo: Number(Lb + totalMarkup),
      outputs: {
        facilityType,
        rateType,
        totalNumberOfPayments: N,
        paymentsPerYear: freq === "BULLET" ? `12/${tenor}` : 12 / k,
        periodicInstalmentKobo: Number(instalment),
        monthlyEquivalentInstalmentKobo: Number(monthlyEquivalent),
        totalMarkupKobo: Number(totalMarkup),
        takafulKobo: Number(takaful),
        stampDutyKobo: Number(stamp),
        totalFeesKobo: Number(takaful + stamp),
        costOfFacilityKobo: Number(cost),
        totalPaymentKobo: Number(Lb + totalMarkup),
        aprFormula: "APR = 2nc / L(N+1)",
        dsrFormula: "DSR = (existing monthly obligations + monthly-equivalent instalment) / average monthly inflow",
      },
    };
  },
};
