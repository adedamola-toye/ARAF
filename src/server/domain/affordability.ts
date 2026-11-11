/**
 * Reusable, versioned affordability and pricing assessment for retail products.
 *
 * - Driven by product configuration, customer profile and financing structure (rules snapshot stored with
 *   every assessment).
 * - DSR = (existing monthly obligations + proposed monthly obligation) ÷ approved monthly denominator.
 *   Numerator and denominator are always monthly.
 * - DSR and the principal-to-turnover cap are separate rules.
 * - Arithmetic is exact (BigInt rationals over integer kobo). Policy thresholds are applied to the
 *   unrounded values; rounding happens only for display and for the contractual instalment schedule.
 * - No rate convention is assumed: final calculation is BLOCKED until the structure's convention is configured.
 */
import type { Obligation } from "./retail-data";
import {
  DSR_DENOMINATOR_LABELS,
  INSURANCE_LABELS,
  RATE_CONVENTION_LABELS,
  STRUCTURE_LABELS,
  type DsrDenominator,
  type InsuranceBearer,
  type ProfileRules,
  type RateConvention,
  type StructureCode,
} from "./products";
import { formatKobo, parsePercentE4 } from "../money";
import { addDaysToDateString } from "../time";

export const ENGINE_VERSION = "retail-affordability@1";

type Rat = { n: bigint; d: bigint };
const rat = (n: bigint | number, d: bigint | number = 1n): Rat => ({ n: BigInt(n), d: BigInt(d) });
const add = (a: Rat, b: Rat): Rat => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const mul = (a: Rat, b: Rat): Rat => ({ n: a.n * b.n, d: a.d * b.d });
const div = (a: Rat, b: Rat): Rat => ({ n: a.n * b.d, d: a.d * b.n });
/** a ≤ b, exactly. Denominators are positive. */
const lte = (a: Rat, b: Rat) => a.n * b.d <= b.n * a.d;
function roundHalfUp(r: Rat): bigint {
  return (2n * r.n + r.d) / (2n * r.d);
}
/** Format a rational percentage with 4 decimals (half-up), for display only. */
function pct4(r: Rat): string {
  const scaled = roundHalfUp(mul(r, rat(10_000n)));
  const s = scaled.toString().padStart(5, "0");
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
}
const koboStr = (r: Rat) => formatKobo(roundHalfUp(r));

export interface AssessmentRules {
  configId: string;
  configVersion: number;
  productCode: string;
  profile: string;
  structure: StructureCode | null;
  dsrMaxPercent: string | null;
  denominator: DsrDenominator | null;
  dsrExceptionAllowed: boolean;
  dsrExceptionApproverRole: string | null;
  principalTurnoverCap: { applies: boolean; maxPercent: string | null };
  maxAmountKobo: number | null;
  maxTenorMonths: number | null;
  eligibleApplicantTypes: string[];
  ratePercent: string | null;
  rateConvention: RateConvention | null;
  insuranceBearer: InsuranceBearer | null;
  equityContribution: { applies: boolean | null; minPercent: string | null };
}

export function rulesSnapshot(p: { configId: string; configVersion: number; productCode: string; profile: string; structure: string | null; rules: ProfileRules }): AssessmentRules {
  const s = p.rules.structures.find((x) => x.code === p.structure) ?? null;
  return {
    configId: p.configId,
    configVersion: p.configVersion,
    productCode: p.productCode,
    profile: p.profile,
    structure: (s?.code ?? null) as StructureCode | null,
    dsrMaxPercent: p.rules.dsr.maxPercent,
    denominator: p.rules.dsr.denominator,
    dsrExceptionAllowed: p.rules.dsr.exceptionAllowed,
    dsrExceptionApproverRole: p.rules.dsr.exceptionApproverRole,
    principalTurnoverCap: p.rules.principalTurnoverCap,
    maxAmountKobo: p.rules.maxAmountKobo,
    maxTenorMonths: p.rules.maxTenorMonths,
    eligibleApplicantTypes: p.rules.eligibleApplicantTypes,
    ratePercent: s?.ratePercent ?? null,
    rateConvention: s?.rateConvention ?? null,
    insuranceBearer: s?.insuranceBearer ?? null,
    equityContribution: p.rules.equityContribution,
  };
}

export interface AffordabilityInput {
  kind: "PRELIMINARY" | "FINAL";
  applicantType: string;
  incomeBasisKobo: number | null;
  incomeBasisNote: string;
  statementFrom: string | null;
  statementTo: string | null;
  evidenceDocumentIds: string[];
  existingObligations: Obligation[];
  principalKobo: number | null;
  tenorMonths: number | null;
  /** Initiator's estimate of the proposed monthly obligation (used only when the rate convention is not configured). */
  proposedMonthlyObligationKobo: number | null;
  turnoverForCapKobo: number | null;
  assetCostKobo: number | null;
  equityContributionKobo: number | null;
  charges: { label: string; amountKobo: number }[];
  firstDueDate: string | null;
}

export interface RuleCheck {
  rule: string;
  pass: boolean;
  detail: string;
}

export interface AffordabilityOutput {
  engineVersion: string;
  result: "PASS" | "FAIL" | "BLOCKED";
  blockedReasons: string[];
  checks: RuleCheck[];
  existingMonthlyKobo: number;
  obligationSource: "CALCULATED_FROM_TERMS" | "INITIATOR_ESTIMATE" | null;
  proposedMonthlyExact: { n: string; d: string } | null;
  proposedMonthlyDisplay: string | null;
  profitDisplay: string | null;
  totalPayableKobo: number | null;
  schedule: { seq: number; dueDate: string | null; amountKobo: number }[];
  dsr: { percent: string; maxPercent: string | null; pass: boolean; denominatorLabel: string; denominatorKobo: number } | null;
  cap: { applies: boolean; percent: string | null; maxPercent: string | null; pass: boolean } | null;
  insurance: string | null;
  structureLabel: string | null;
  rateLabel: string | null;
  formula: string[];
  chargesKobo: number;
}

function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

export function computeAffordability(rules: AssessmentRules, i: AffordabilityInput): AffordabilityOutput {
  const blocked: string[] = [];
  const checks: RuleCheck[] = [];
  const formula: string[] = [];
  const existing = i.existingObligations.reduce((s, o) => s + o.monthlyRepaymentKobo, 0);
  const principal = i.principalKobo;
  const tenor = i.tenorMonths;

  // --- eligibility (separate rules)
  checks.push({ rule: "Customer type eligible", pass: rules.eligibleApplicantTypes.includes(i.applicantType), detail: `${i.applicantType} (eligible: ${rules.eligibleApplicantTypes.join(", ")})` });
  if (rules.maxAmountKobo === null) blocked.push("Maximum financing amount is not configured.");
  else if (principal !== null) checks.push({ rule: "Within maximum financing amount", pass: principal <= rules.maxAmountKobo, detail: `${formatKobo(principal)} of maximum ${formatKobo(rules.maxAmountKobo)}` });
  if (principal === null || principal <= 0) checks.push({ rule: "Principal entered", pass: false, detail: "Enter the principal." });
  if (rules.maxTenorMonths === null) blocked.push("Maximum tenor is not configured.");
  else if (tenor !== null) checks.push({ rule: "Within maximum tenor", pass: tenor >= 1 && tenor <= rules.maxTenorMonths, detail: `${tenor} of maximum ${rules.maxTenorMonths} months` });
  if (!tenor || tenor < 1) checks.push({ rule: "Tenor entered", pass: false, detail: "Enter the tenor in months." });
  if (rules.equityContribution.applies === null) blocked.push("Equity contribution rule is not configured.");
  else if (rules.equityContribution.applies) {
    const minE4 = rules.equityContribution.minPercent ? parsePercentE4(rules.equityContribution.minPercent) : null;
    if (minE4 === null) blocked.push("Minimum equity contribution is not configured.");
    else if (i.assetCostKobo && i.equityContributionKobo !== null) {
      const ok = BigInt(i.equityContributionKobo) * 1_000_000n >= BigInt(minE4) * BigInt(i.assetCostKobo);
      checks.push({ rule: "Equity contribution", pass: ok, detail: `${formatKobo(i.equityContributionKobo)} of asset cost ${formatKobo(i.assetCostKobo)} (minimum ${rules.equityContribution.minPercent}%)` });
    } else checks.push({ rule: "Equity contribution", pass: false, detail: "Enter the asset cost and equity contribution." });
  }

  // --- proposed obligation
  let monthly: Rat | null = null;
  let source: AffordabilityOutput["obligationSource"] = null;
  let profit: Rat | null = null;
  let totalPayableKobo: number | null = null;
  const schedule: AffordabilityOutput["schedule"] = [];
  const rateE4 = rules.ratePercent ? parsePercentE4(rules.ratePercent) : null;
  if (!rules.structure) blocked.push("No financing structure is selected or configured.");
  const termsConfigured = rateE4 !== null && rules.rateConvention !== null;
  if (termsConfigured && principal && tenor && tenor > 0) {
    const factor = rules.rateConvention === "FLAT_PER_ANNUM" ? rat(tenor, 12) : rules.rateConvention === "FLAT_PER_MONTH" ? rat(tenor) : rat(1);
    profit = mul(mul(rat(principal), rat(rateE4!, 1_000_000)), factor);
    const total = add(rat(principal), profit);
    monthly = div(total, rat(tenor));
    source = "CALCULATED_FROM_TERMS";
    totalPayableKobo = Number(roundHalfUp(total));
    const base = Math.floor(totalPayableKobo / tenor);
    for (let k = 1; k <= tenor; k++) {
      schedule.push({ seq: k, dueDate: i.firstDueDate ? addMonths(i.firstDueDate, k - 1) : null, amountKobo: k === tenor ? totalPayableKobo - base * (tenor - 1) : base });
    }
    formula.push(
      `Profit = principal ${formatKobo(principal)} × ${rules.ratePercent}% × ${rules.rateConvention === "FLAT_PER_ANNUM" ? `${tenor}/12` : rules.rateConvention === "FLAT_PER_MONTH" ? `${tenor} months` : "1 (whole tenor)"} = ${koboStr(profit)}`,
      `Total payable = principal + profit = ${formatKobo(totalPayableKobo)}`,
      `Proposed monthly obligation = total payable ÷ ${tenor} months = ${koboStr(monthly)} (unrounded value used for DSR)`,
    );
  } else {
    if (i.kind === "FINAL") {
      if (rateE4 === null) blocked.push(`${rules.structure ? STRUCTURE_LABELS[rules.structure] : "Structure"} profit rate is not configured.`);
      if (rules.rateConvention === null) blocked.push(`${rules.structure ? STRUCTURE_LABELS[rules.structure] : "Structure"} rate convention (relationship between rate and tenor) is not configured. Final calculation and offer generation are blocked.`);
    }
    if (i.proposedMonthlyObligationKobo !== null && i.proposedMonthlyObligationKobo > 0) {
      monthly = rat(i.proposedMonthlyObligationKobo);
      source = "INITIATOR_ESTIMATE";
      formula.push(`Proposed monthly obligation = ${formatKobo(i.proposedMonthlyObligationKobo)} (initiator estimate; the rate convention is not configured, so terms cannot be calculated)`);
    } else if (i.kind === "PRELIMINARY") {
      checks.push({ rule: "Proposed monthly obligation entered", pass: false, detail: "Enter the proposed monthly repayment." });
    }
  }

  // --- DSR
  let dsr: AffordabilityOutput["dsr"] = null;
  const maxE4 = rules.dsrMaxPercent ? parsePercentE4(rules.dsrMaxPercent) : null;
  if (rules.denominator === null) blocked.push("The DSR denominator (income or business basis) is not configured.");
  if (maxE4 === null) blocked.push("The maximum DSR is not configured.");
  if (i.incomeBasisKobo === null || i.incomeBasisKobo <= 0) checks.push({ rule: "Income / business basis entered", pass: false, detail: `Enter the ${rules.denominator ? DSR_DENOMINATOR_LABELS[rules.denominator].toLowerCase() : "income basis"}.` });
  if (rules.denominator && maxE4 !== null && monthly && i.incomeBasisKobo && i.incomeBasisKobo > 0) {
    const numerator = add(rat(existing), monthly);
    const ratio = div(numerator, rat(i.incomeBasisKobo));
    const pass = lte(ratio, rat(maxE4, 1_000_000));
    dsr = { percent: pct4(mul(ratio, rat(100))), maxPercent: rules.dsrMaxPercent, pass, denominatorLabel: DSR_DENOMINATOR_LABELS[rules.denominator], denominatorKobo: i.incomeBasisKobo };
    checks.push({ rule: `DSR within ${rules.dsrMaxPercent}%`, pass, detail: `DSR ${dsr.percent}% (exact comparison on unrounded values)` });
    formula.push(
      `DSR = (existing monthly obligations ${formatKobo(existing)} + proposed monthly obligation ${koboStr(monthly)}) ÷ ${DSR_DENOMINATOR_LABELS[rules.denominator].toLowerCase()} ${formatKobo(i.incomeBasisKobo)} × 100 = ${dsr.percent}%`,
      `Threshold: DSR ≤ ${rules.dsrMaxPercent}% → ${pass ? "PASS" : "FAIL"}`,
    );
  }

  // --- principal-to-turnover cap (separate rule; never derived from DSR)
  let cap: AffordabilityOutput["cap"] = null;
  if (rules.principalTurnoverCap.applies) {
    const capE4 = rules.principalTurnoverCap.maxPercent ? parsePercentE4(rules.principalTurnoverCap.maxPercent) : null;
    if (capE4 === null) blocked.push("The principal-to-turnover cap percentage is not configured.");
    else if (principal && i.turnoverForCapKobo && i.turnoverForCapKobo > 0) {
      const r = div(rat(principal), rat(i.turnoverForCapKobo));
      const pass = lte(r, rat(capE4, 1_000_000));
      cap = { applies: true, percent: pct4(mul(r, rat(100))), maxPercent: rules.principalTurnoverCap.maxPercent, pass };
      checks.push({ rule: `Principal within ${rules.principalTurnoverCap.maxPercent}% of turnover`, pass, detail: `${cap.percent}% of ${formatKobo(i.turnoverForCapKobo)}` });
      formula.push(`Principal-to-turnover = ${formatKobo(principal)} ÷ ${formatKobo(i.turnoverForCapKobo)} × 100 = ${cap.percent}% (separate from DSR)`);
    } else checks.push({ rule: "Turnover for principal cap entered", pass: false, detail: "Enter the turnover used for the principal cap." });
  } else cap = { applies: false, percent: null, maxPercent: null, pass: true };

  // --- statement period consistency
  if (i.statementFrom && i.statementTo && i.statementTo < i.statementFrom) checks.push({ rule: "Statement period", pass: false, detail: "Statement end is before start." });
  else if (i.statementFrom && i.statementTo) checks.push({ rule: "Statement period recorded", pass: true, detail: `${i.statementFrom} to ${i.statementTo}` });
  if (i.kind === "FINAL" && (!i.statementFrom || !i.statementTo)) checks.push({ rule: "Statement period recorded", pass: false, detail: "Record the statement period supporting the income basis." });

  const chargesKobo = i.charges.reduce((s, c) => s + c.amountKobo, 0);
  const result: AffordabilityOutput["result"] = blocked.length ? "BLOCKED" : checks.every((c) => c.pass) && monthly ? "PASS" : "FAIL";
  return {
    engineVersion: ENGINE_VERSION,
    result,
    blockedReasons: blocked,
    checks,
    existingMonthlyKobo: existing,
    obligationSource: source,
    proposedMonthlyExact: monthly ? { n: monthly.n.toString(), d: monthly.d.toString() } : null,
    proposedMonthlyDisplay: monthly ? koboStr(monthly) : null,
    profitDisplay: profit ? koboStr(profit) : null,
    totalPayableKobo,
    schedule,
    dsr,
    cap,
    insurance: rules.insuranceBearer ? INSURANCE_LABELS[rules.insuranceBearer] : null,
    structureLabel: rules.structure ? STRUCTURE_LABELS[rules.structure] : null,
    rateLabel: rules.ratePercent ? `${rules.ratePercent}%${rules.rateConvention ? ` · ${RATE_CONVENTION_LABELS[rules.rateConvention]}` : " · convention not configured"}` : null,
    formula,
    chargesKobo,
  };
}

export { addDaysToDateString };
