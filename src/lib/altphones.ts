/**
 * Altphones: shared (client-safe) labels, the financing calculator and the repayment-date rules.
 * All money is integer kobo; rates are percent × 10^4 (12.5% = 125000). Every calculation is exact
 * integer arithmetic with half-up rounding, and the last instalment absorbs the rounding difference.
 */

export const ALTPHONES_TENURES = [3, 6, 12] as const;
export type Tenure = (typeof ALTPHONES_TENURES)[number];
export const isTenure = (n: unknown): n is Tenure => (ALTPHONES_TENURES as readonly number[]).includes(Number(n));

export type MarkupBasis = "FLAT_TOTAL" | "FLAT_PER_MONTH";
export const MARKUP_BASIS_LABELS: Record<MarkupBasis, string> = {
  FLAT_TOTAL: "Flat: the rate is the total markup for the tenure",
  FLAT_PER_MONTH: "Flat per month: the rate is charged for each month of the tenure",
};

export type AltStatus =
  | "DRAFT"
  | "AWAITING_PAYMENT"
  | "PAID"
  | "COMPLETED"
  | "CREDIT_DECLINED"
  | "AWAITING_DOWN_PAYMENT"
  | "IN_PREPARATION"
  | "UNDER_BPM_REVIEW"
  | "UNDER_PM_REVIEW"
  | "UNDER_UNIT_HEAD_REVIEW"
  | "RETURNED_FOR_CORRECTION"
  | "APPROVED"
  | "DISBURSED"
  | "REJECTED"
  | "CANCELLED";

export const ALT_STATUS_LABELS: Record<AltStatus, string> = {
  DRAFT: "Draft",
  AWAITING_PAYMENT: "Awaiting payment",
  PAID: "Paid — ready for handover",
  COMPLETED: "Outright Sale Completed",
  CREDIT_DECLINED: "Credit assessment failed",
  AWAITING_DOWN_PAYMENT: "Awaiting down payment",
  IN_PREPARATION: "Down payment received — mandates and contract",
  UNDER_BPM_REVIEW: "With the Business Performance Manager",
  UNDER_PM_REVIEW: "With the Product Manager",
  UNDER_UNIT_HEAD_REVIEW: "With the Unit Head",
  RETURNED_FOR_CORRECTION: "Returned for correction",
  APPROVED: "Approved — Ready for Disbursement",
  DISBURSED: "Disbursed / Completed",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

export type Tone = "green" | "yellow" | "red" | "blue" | "grey";
export function statusTone(s: AltStatus): Tone {
  if (s === "COMPLETED" || s === "DISBURSED") return "green";
  if (s === "APPROVED" || s === "PAID") return "blue";
  if (s === "CREDIT_DECLINED" || s === "REJECTED" || s === "CANCELLED") return "red";
  if (s === "DRAFT") return "grey";
  return "yellow";
}

/** Statuses after which nothing more happens to the application. */
export const CLOSED_STATUSES: readonly AltStatus[] = ["COMPLETED", "DISBURSED", "CREDIT_DECLINED", "REJECTED", "CANCELLED"];
export const REVIEW_STATUSES: readonly AltStatus[] = ["UNDER_BPM_REVIEW", "UNDER_PM_REVIEW", "UNDER_UNIT_HEAD_REVIEW"];

export const SCORE_OUTCOME_LABELS = { PASS: "Pass", FAIR: "Fair", FAIL: "Fail" } as const;
export type ScoreOutcome = keyof typeof SCORE_OUTCOME_LABELS;

/** Map a score into the configured bands. Returns null when the bands are not configured. */
export function mapScore(score: number, passMin: number | null, fairMin: number | null): ScoreOutcome | null {
  if (passMin === null || fairMin === null || !Number.isFinite(score)) return null;
  if (score >= passMin) return "PASS";
  if (score >= fairMin) return "FAIR";
  return "FAIL";
}

// ------------------------------------------------------------------ money

const half = (num: bigint, den: bigint) => (num + den / 2n) / den;

export function formatNaira(kobo: number | string | bigint | null | undefined): string {
  if (kobo === null || kobo === undefined || kobo === "") return "—";
  const k = BigInt(kobo);
  const neg = k < 0n;
  const a = neg ? -k : k;
  const naira = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rem = a % 100n;
  return `${neg ? "-" : ""}₦${naira}${rem ? "." + rem.toString().padStart(2, "0") : ""}`;
}

/** 125000 → "12.5%". */
export function formatRateE4(e4: number | null | undefined): string {
  if (e4 === null || e4 === undefined) return "—";
  const i = Math.trunc(e4 / 10000);
  const f = String(e4 % 10000).padStart(4, "0").replace(/0+$/, "");
  return `${i}${f ? "." + f : ""}%`;
}

/** "12.5" → 125000. Up to 4 decimal places; returns null for anything else. */
export function parseRateE4(input: string | number): number | null {
  const s = String(input).trim().replace(/%$/, "");
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  const v = Number(i) * 10000 + Number(f.padEnd(4, "0"));
  return v <= 1_000_000 ? v : null;
}

export interface Terms {
  priceKobo: number;
  downPaymentKobo: number;
  financedKobo: number;
  tenureMonths: Tenure;
  rateE4: number;
  basis: MarkupBasis;
  /** The rate actually applied to the phone price over the tenure (percent × 10^4). */
  effectiveRateE4: number;
  markupKobo: number;
  totalRepaymentKobo: number;
  instalmentKobo: number;
  finalInstalmentKobo: number;
}

/**
 * Markup is charged on the full phone price; the fixed down payment then comes off the marked-up price:
 *   markup  = price × rate            (FLAT_TOTAL)
 *   markup  = price × rate × months   (FLAT_PER_MONTH)
 *   total   = price + markup − down payment   (the amount paid in instalments)
 *   instalment = total ÷ months, rounded half-up to the kobo; the final instalment = total − instalment × (months − 1)
 */
export function computeTerms(p: { priceKobo: number; downPaymentKobo: number; tenureMonths: number; rateE4: number; basis: MarkupBasis }): Terms {
  if (!isTenure(p.tenureMonths)) throw new Error("Tenure must be 3, 6 or 12 months.");
  if (!Number.isInteger(p.priceKobo) || !Number.isInteger(p.downPaymentKobo) || p.downPaymentKobo <= 0 || p.downPaymentKobo >= p.priceKobo) throw new Error("Invalid price or down payment.");
  if (!Number.isInteger(p.rateE4) || p.rateE4 < 0) throw new Error("Invalid markup rate.");
  const n = BigInt(p.tenureMonths);
  const financed = BigInt(p.priceKobo - p.downPaymentKobo);
  const effective = p.basis === "FLAT_PER_MONTH" ? BigInt(p.rateE4) * n : BigInt(p.rateE4);
  // Markup is charged on the full phone price; the down payment then comes off the marked-up price
  // and the balance is paid in equal monthly instalments.
  const markup = half(BigInt(p.priceKobo) * effective, 1_000_000n); // percent × 10^4 → fraction: ÷ (100 × 10^4)
  const total = financed + markup;
  const instalment = half(total, n);
  const final = total - instalment * (n - 1n);
  return {
    priceKobo: p.priceKobo,
    downPaymentKobo: p.downPaymentKobo,
    financedKobo: Number(financed),
    tenureMonths: p.tenureMonths,
    rateE4: p.rateE4,
    basis: p.basis,
    effectiveRateE4: Number(effective),
    markupKobo: Number(markup),
    totalRepaymentKobo: Number(total),
    instalmentKobo: Number(instalment),
    finalInstalmentKobo: Number(final),
  };
}

// ------------------------------------------------------------------ repayment dates

export type WeekendRule = "NEXT_BUSINESS_DAY" | "PREVIOUS_BUSINESS_DAY" | "NO_ADJUSTMENT";
export type ShortMonthRule = "LAST_DAY_OF_MONTH" | "FIRST_DAY_OF_NEXT_MONTH";
export const WEEKEND_RULE_LABELS: Record<WeekendRule, string> = {
  NEXT_BUSINESS_DAY: "Move to the next business day",
  PREVIOUS_BUSINESS_DAY: "Move to the previous business day",
  NO_ADJUSTMENT: "No adjustment",
};
export const SHORT_MONTH_RULE_LABELS: Record<ShortMonthRule, string> = {
  LAST_DAY_OF_MONTH: "Use the last day of that month",
  FIRST_DAY_OF_NEXT_MONTH: "Use the first day of the next month",
};

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function isBusinessDay(date: string, holidays: ReadonlySet<string>) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.has(date);
}

/**
 * Due dates: the first instalment falls in the calendar month after `startDate` on `repaymentDay`, then one
 * per month. A month without that day uses the short-month rule; a weekend or public holiday uses the
 * weekend rule.
 */
export function repaymentDates(p: { startDate: string; months: number; repaymentDay: number; shortMonthRule: ShortMonthRule; weekendRule: WeekendRule; holidays?: Iterable<string> }): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.startDate)) throw new Error("Invalid start date.");
  if (!Number.isInteger(p.repaymentDay) || p.repaymentDay < 1 || p.repaymentDay > 31) throw new Error("Repayment day must be between 1 and 31.");
  const hol = new Set(p.holidays ?? []);
  const [y0, m0] = p.startDate.split("-").map(Number);
  const out: string[] = [];
  for (let i = 1; i <= p.months; i++) {
    const idx = m0 - 1 + i;
    const y = y0 + Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    let due: string;
    if (p.repaymentDay <= daysIn(y, m)) due = ymd(y, m, p.repaymentDay);
    else if (p.shortMonthRule === "LAST_DAY_OF_MONTH") due = ymd(y, m, daysIn(y, m));
    else due = m === 12 ? ymd(y + 1, 1, 1) : ymd(y, m + 1, 1);
    if (p.weekendRule !== "NO_ADJUSTMENT") {
      const step = p.weekendRule === "NEXT_BUSINESS_DAY" ? 1 : -1;
      for (let guard = 0; guard < 31 && !isBusinessDay(due, hol); guard++) due = shift(due, step);
    }
    out.push(due);
  }
  return out;
}

export function instalmentAmounts(t: Pick<Terms, "tenureMonths" | "instalmentKobo" | "finalInstalmentKobo">): number[] {
  return Array.from({ length: t.tenureMonths }, (_, i) => (i === t.tenureMonths - 1 ? t.finalInstalmentKobo : t.instalmentKobo));
}

// ------------------------------------------------------------------ validation helpers

export const isBvn = (s: string) => /^\d{11}$/.test(s);
export const isNuban = (s: string) => /^\d{10}$/.test(s);
export const isImei = (s: string) => /^\d{15}$/.test(s);
/** Luhn check used by IMEIs (the 15th digit is a check digit). */
export function imeiChecksumOk(imei: string): boolean {
  if (!isImei(imei)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(imei[14 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
/**
 * What is wrong with an IMEI, in words staff can act on, or null when it is a well-formed IMEI
 * (15 digits, not a placeholder, and the 15th digit is the correct check digit).
 */
export function imeiProblem(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return "No IMEI entered.";
  const compact = s.replace(/[\s-]/g, "");
  if (/[^0-9]/.test(compact)) return "The IMEI must contain digits only.";
  if (compact.length === 14) return "The IMEI has 14 digits: the last (check) digit is missing. Dial *#06# on the phone or read the box label.";
  if (compact.length < 15) return `The IMEI has ${compact.length} digits; it must have 15.`;
  if (compact.length === 16 || compact.length === 17) return `The IMEI has ${compact.length} digits: this looks like an IMEI with extra digits (or the software version). It must have 15.`;
  if (compact.length > 15) return `The IMEI has ${compact.length} digits; it must have 15.`;
  if (/^(\d)\1{14}$/.test(compact) || compact === "123456789012345" || /^0{8}/.test(compact)) return "This is not a real IMEI (it looks like a placeholder).";
  if (!imeiChecksumOk(compact)) return "The IMEI's check digit does not match: one digit is probably mistyped. Check it against *#06# or the box label.";
  return null;
}
export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
/** Nigerian mobile numbers: 0XXXXXXXXXX or +234XXXXXXXXXX. Returns the canonical +234 form or null. */
export function normalisePhone(raw: string): string | null {
  const s = raw.replace(/[\s()-]/g, "");
  if (/^0[789]\d{9}$/.test(s)) return `+234${s.slice(1)}`;
  if (/^\+?234[789]\d{9}$/.test(s)) return `+${s.replace(/^\+/, "")}`;
  return null;
}
