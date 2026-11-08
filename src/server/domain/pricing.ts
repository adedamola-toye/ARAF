/**
 * WakeelBoost DSR and facility pricing (flat markup by tenor band).
 *
 * Rules (bank instruction, clarified):
 *   Pricing band          1–3 months: short rate (seeded 10%) · 4 months up to the configured maximum (≤ 6): long rate (seeded 15%).
 *                         Only the period matters; the amount never changes the band. The boundary is stored per settings version.
 *   Principal             ≤ ₦50,000,000 (single obligation limit)
 *   Repayment             monthly, or weekly when needed (4 weekly instalments per month: instalment = total ÷ (4 × tenor));
 *                         DSR always uses the monthly equivalent = total ÷ tenor
 *   Markup                = principal × flat rate (applied once for the whole tenor; the amount does not change the band)
 *   Total repayment       = principal + markup
 *   Monthly repayment     = total repayment ÷ tenor (monthly equivalent)
 *   Facility DSR          = monthly repayment ÷ monthly turnover
 *   Total DSR             = (monthly repayment + existing monthly obligations) ÷ monthly turnover   ← drives the result
 *   Threshold             = 10%; result WITHIN_THRESHOLD when Total DSR ≤ 10% (compared exactly, unrounded)
 *   Excess (if exceeded)  = monthly repayment + obligations − 10% × monthly turnover
 *   Indicative max principal = (10% × monthly turnover − obligations) × tenor ÷ (1 + rate), rounded DOWN to the kobo
 *   Monthly turnover      = annual turnover ÷ 12, unless an authorised reviewer enters a verified monthly figure (with reason)
 *
 * Everything is computed with exact rational arithmetic on integer kobo (BigInt). Money is rounded
 * half-up to the kobo only for display/storage; ratios are rounded half-up to 2 dp for display (4 dp stored).
 */
import type { Db } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { DomainError, forbidden, invalid } from "../errors";
import { formatKobo, parsePercentE4 } from "../money";
import { holdsRole } from "./access";

export const ABSOLUTE_MAX_TENOR = 6;
/** Single obligation limit: ₦50,000,000. */
export const SINGLE_OBLIGATION_LIMIT_KOBO = 5_000_000_000;
export const WEEKS_PER_MONTH = 4;
export type RepaymentFrequency = "MONTHLY" | "WEEKLY";

export interface PricingSettings {
  id: string;
  version: number;
  maxTenorMonths: number;
  shortRateE4: number; // percent × 10^4
  longRateE4: number;
  thresholdE4: number;
  /** First tenor (months) of the long band; tenors below it use the short rate. */
  longBandFromMonths: number;
  effectiveFrom: Date;
}

export interface PricingInput {
  annualTurnoverKobo: number;
  verifiedMonthlyTurnoverKobo?: number | null; // override
  overrideReason?: string | null;
  principalKobo: number;
  tenorMonths: number;
  existingObligationsKobo: number;
  repaymentFrequency?: RepaymentFrequency;
}

export interface PricingResult {
  turnover: {
    annualTurnoverKobo: number;
    derivedMonthlyTurnoverKobo: number; // annual ÷ 12, rounded half-up
    derivedMonthlyTurnoverExact: string; // naira, 6 dp
    verifiedMonthlyTurnoverKobo: number | null;
    basis: "ANNUAL_DIV_12" | "VERIFIED_MONTHLY";
    overrideReason: string | null;
    monthlyTurnoverUsedKobo: number;
  };
  facility: {
    principalKobo: number;
    tenorMonths: number;
    band: "SHORT" | "LONG";
    bandLabel: string;
    flatMarkupRatePercent: string; // e.g. "15"
    markupKobo: number;
    totalRepaymentKobo: number;
    monthlyRepaymentKobo: number; // monthly equivalent when weekly
    monthlyRepaymentExact: string;
    repaymentFrequency: RepaymentFrequency;
    numberOfInstalments: number;
    instalmentKobo: number; // the actual periodic instalment (weekly or monthly)
    instalmentExact: string;
  };
  capacity: {
    existingObligationsKobo: number;
    obligationsConfirmedNone: boolean;
    facilityDsrPercent: string; // 2 dp
    facilityDsrPercent4: string; // 4 dp
    totalDsrPercent: string; // 2 dp
    totalDsrPercent4: string; // 4 dp
    thresholdPercent: string;
    thresholdAmountKobo: number;
    result: "WITHIN_THRESHOLD" | "EXCEEDS_THRESHOLD";
    excessKobo: number;
    maxAffordablePrincipalKobo: number; // affordability only
    maxPrincipalWithinLimitKobo: number; // also capped by the ₦50m single obligation limit (applied separately)
  };
  settings: { id: string; version: number; maxTenorMonths: number; shortRatePercent: string; longRatePercent: string; thresholdPercent: string; longBandFromMonths: number; shortBandLabel: string; longBandLabel: string; effectiveFrom: string };
}

const M6 = 1_000_000n;
const roundHalfUp = (num: bigint, den: bigint) => (num >= 0n ? (2n * num + den) / (2n * den) : -((2n * -num + den) / (2n * den)));
export const e4ToPercent = (e4: number) => {
  const s = String(e4).padStart(5, "0");
  const t = `${s.slice(0, -4)}.${s.slice(-4)}`.replace(/\.?0+$/, "");
  return t === "" ? "0" : t;
};
function fixed(num: bigint, den: bigint, dp: number) {
  const scale = 10n ** BigInt(dp);
  const v = roundHalfUp(num * scale, den);
  const neg = v < 0n;
  const a = (neg ? -v : v).toString().padStart(dp + 1, "0");
  return `${neg ? "-" : ""}${a.slice(0, -dp)}.${a.slice(-dp)}`;
}

export function bandLabels(s: Pick<PricingSettings, "longBandFromMonths" | "maxTenorMonths">) {
  const b = s.longBandFromMonths;
  const short = b - 1 <= 1 ? "1 month" : `1–${b - 1} months`;
  const long = b > s.maxTenorMonths ? `${b}+ months (above the maximum tenor)` : b === s.maxTenorMonths ? `${b} months` : `${b}–${s.maxTenorMonths} months`;
  return { short, long };
}

export function bandFor(tenor: number, s: PricingSettings) {
  const l = bandLabels(s);
  return tenor >= s.longBandFromMonths ? { band: "LONG" as const, rateE4: s.longRateE4, label: l.long } : { band: "SHORT" as const, rateE4: s.shortRateE4, label: l.short };
}

export function validatePricingInput(i: PricingInput, s: PricingSettings): Record<string, string> {
  const e: Record<string, string> = {};
  const int = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
  if (!int(i.annualTurnoverKobo) || i.annualTurnoverKobo <= 0) e.annualTurnoverKobo = "Verified annual turnover must be greater than zero.";
  if (i.verifiedMonthlyTurnoverKobo != null) {
    if (!int(i.verifiedMonthlyTurnoverKobo) || i.verifiedMonthlyTurnoverKobo <= 0) e.verifiedMonthlyTurnoverKobo = "Verified monthly turnover must be greater than zero.";
    if (!i.overrideReason || i.overrideReason.trim().length < 5) e.overrideReason = "Give a reason for using a verified monthly turnover figure.";
  }
  if (!int(i.principalKobo) || i.principalKobo <= 0) e.principalKobo = "Principal must be greater than zero.";
  else if (i.principalKobo > SINGLE_OBLIGATION_LIMIT_KOBO) e.principalKobo = "Principal cannot exceed ₦50,000,000.00, the single obligation limit.";
  if (i.repaymentFrequency !== undefined && i.repaymentFrequency !== "MONTHLY" && i.repaymentFrequency !== "WEEKLY") e.repaymentFrequency = "Repayment is monthly or weekly.";
  if (!int(i.tenorMonths) || i.tenorMonths < 1 || i.tenorMonths > Math.min(ABSOLUTE_MAX_TENOR, s.maxTenorMonths)) {
    e.tenorMonths = `Tenor must be a whole number of months from 1 to ${Math.min(ABSOLUTE_MAX_TENOR, s.maxTenorMonths)}.`;
  }
  if (!int(i.existingObligationsKobo) || i.existingObligationsKobo < 0) e.existingObligationsKobo = "Existing monthly obligations cannot be negative (enter 0 when there are none).";
  return e;
}

export function calculatePricing(i: PricingInput, s: PricingSettings): PricingResult {
  const errors = validatePricingInput(i, s);
  if (Object.keys(errors).length) throw invalid("Check the assessment inputs.", errors);
  const { band, rateE4, label } = bandFor(i.tenorMonths, s);
  const P = BigInt(i.principalKobo);
  const T = BigInt(i.tenorMonths);
  const O = BigInt(i.existingObligationsKobo);
  const r = BigInt(rateE4); // fraction = r / 1e6
  const thr = BigInt(s.thresholdE4);
  const A = BigInt(i.annualTurnoverKobo);
  const override = i.verifiedMonthlyTurnoverKobo != null;
  // Monthly turnover used, as a rational Mnum / Mden (kobo)
  const Mnum = override ? BigInt(i.verifiedMonthlyTurnoverKobo!) : A;
  const Mden = override ? 1n : 12n;

  const markupNum = P * r; // / 1e6
  const totalNum = P * (M6 + r); // / 1e6
  const monthlyNum = totalNum; // / (1e6 × T)
  const obligationsAndRepaymentNum = totalNum + O * M6 * T; // / (1e6 × T)
  // Total DSR = obligationsAndRepaymentNum × Mden / (1e6 × T × Mnum)
  const dsrNum = obligationsAndRepaymentNum * Mden;
  const dsrDen = M6 * T * Mnum;
  const facNum = monthlyNum * Mden;
  const within = dsrNum * M6 <= thr * dsrDen; // exact comparison, unrounded
  const excessNum = obligationsAndRepaymentNum * Mden - thr * T * Mnum; // / (1e6 × T × Mden)
  const maxNum = (thr * Mnum - O * M6 * Mden) * T; // / (Mden × (1e6 + r))
  const maxPrincipal = maxNum > 0n ? maxNum / (Mden * (M6 + r)) : 0n; // floor (affordability only)
  const limit = BigInt(SINGLE_OBLIGATION_LIMIT_KOBO);
  const freq: RepaymentFrequency = i.repaymentFrequency ?? "MONTHLY";
  const perMonth = freq === "WEEKLY" ? BigInt(WEEKS_PER_MONTH) : 1n;
  const instalments = T * perMonth;

  return {
    turnover: {
      annualTurnoverKobo: i.annualTurnoverKobo,
      derivedMonthlyTurnoverKobo: Number(roundHalfUp(A, 12n)),
      derivedMonthlyTurnoverExact: fixed(A, 1200n, 6),
      verifiedMonthlyTurnoverKobo: override ? i.verifiedMonthlyTurnoverKobo! : null,
      basis: override ? "VERIFIED_MONTHLY" : "ANNUAL_DIV_12",
      overrideReason: override ? i.overrideReason!.trim() : null,
      monthlyTurnoverUsedKobo: Number(roundHalfUp(Mnum, Mden)),
    },
    facility: {
      principalKobo: i.principalKobo,
      tenorMonths: i.tenorMonths,
      band,
      bandLabel: label,
      flatMarkupRatePercent: e4ToPercent(rateE4),
      markupKobo: Number(roundHalfUp(markupNum, M6)),
      totalRepaymentKobo: Number(roundHalfUp(totalNum, M6)),
      monthlyRepaymentKobo: Number(roundHalfUp(monthlyNum, M6 * T)),
      monthlyRepaymentExact: fixed(monthlyNum, M6 * T * 100n, 6),
      repaymentFrequency: freq,
      numberOfInstalments: Number(instalments),
      instalmentKobo: Number(roundHalfUp(totalNum, M6 * instalments)),
      instalmentExact: fixed(totalNum, M6 * instalments * 100n, 6),
    },
    capacity: {
      existingObligationsKobo: i.existingObligationsKobo,
      obligationsConfirmedNone: i.existingObligationsKobo === 0,
      facilityDsrPercent: fixed(facNum * 100n, dsrDen, 2),
      facilityDsrPercent4: fixed(facNum * 100n, dsrDen, 4),
      totalDsrPercent: fixed(dsrNum * 100n, dsrDen, 2),
      totalDsrPercent4: fixed(dsrNum * 100n, dsrDen, 4),
      thresholdPercent: e4ToPercent(s.thresholdE4),
      thresholdAmountKobo: Number(roundHalfUp(thr * Mnum, M6 * Mden)),
      result: within ? "WITHIN_THRESHOLD" : "EXCEEDS_THRESHOLD",
      excessKobo: within ? 0 : Number(roundHalfUp(excessNum, M6 * T * Mden)),
      maxAffordablePrincipalKobo: Number(maxPrincipal),
      maxPrincipalWithinLimitKobo: Number(maxPrincipal > limit ? limit : maxPrincipal),
    },
    settings: {
      id: s.id,
      version: s.version,
      maxTenorMonths: s.maxTenorMonths,
      shortRatePercent: e4ToPercent(s.shortRateE4),
      longRatePercent: e4ToPercent(s.longRateE4),
      thresholdPercent: e4ToPercent(s.thresholdE4),
      longBandFromMonths: s.longBandFromMonths,
      shortBandLabel: bandLabels(s).short,
      longBandLabel: bandLabels(s).long,
      effectiveFrom: s.effectiveFrom.toISOString(),
    },
  };
}

/** Plain-language explanation shown on the assessment screen and in notifications. */
export function dsrExplanation(o: { totalDsrPercent: string; thresholdPercent: string; result: string; excessKobo: number; existingObligationsKobo: number }) {
  const subject = o.existingObligationsKobo > 0 ? "The proposed monthly repayment plus existing obligations represent" : "The proposed monthly repayment represents";
  return o.result === "EXCEEDS_THRESHOLD"
    ? `${subject} ${o.totalDsrPercent}% of the turnover used for this assessment, exceeding the Bank’s ${o.thresholdPercent}% obligation threshold by ${formatKobo(o.excessKobo)} per month.`
    : `${subject} ${o.totalDsrPercent}% of the turnover used for this assessment, within the Bank’s ${o.thresholdPercent}% obligation threshold.`;
}

// ------------------------------------------------------------------ settings

interface SettingsRow {
  id: string;
  version: number;
  max_tenor_months: number;
  short_rate_e4: number;
  long_rate_e4: number;
  threshold_e4: number;
  long_band_from_months: number;
  effective_from: Date;
}
const toSettings = (r: SettingsRow): PricingSettings => ({
  id: r.id,
  version: r.version,
  maxTenorMonths: r.max_tenor_months,
  shortRateE4: r.short_rate_e4,
  longRateE4: r.long_rate_e4,
  thresholdE4: r.threshold_e4,
  longBandFromMonths: r.long_band_from_months,
  effectiveFrom: new Date(r.effective_from),
});

/** Settings in force at `at` (latest effective_from ≤ at). */
export async function pricingSettingsAt(q: Db, at: Date): Promise<PricingSettings> {
  const r = (await q.query<SettingsRow>("SELECT * FROM pricing_settings WHERE effective_from <= $1 ORDER BY effective_from DESC, version DESC LIMIT 1", [at])).rows[0];
  if (!r) throw new DomainError("CONFIG", "No WakeelBoost pricing settings are in force.");
  return toSettings(r);
}

export async function pricingHistory(q: Db) {
  return (
    await q.query(
      `SELECT p.*, s.full_name AS created_by_name FROM pricing_settings p LEFT JOIN staff s ON s.id = p.created_by ORDER BY p.version DESC`,
    )
  ).rows;
}

/**
 * Super Admin changes the pricing settings. Applies prospectively from `effectiveFrom` (now or later);
 * existing assessments and approved facilities keep their snapshot. The six-month ceiling is enforced
 * here and by a database constraint.
 */
export async function updatePricingSettings(ctx: Ctx, p: { maxTenorMonths: number; shortRatePercent: string; longRatePercent: string; effectiveFrom?: Date | null; reason: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  try {
    return await withTx(async (tx) => {
      if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only the Super Admin can change WakeelBoost pricing settings.");
      const errors: Record<string, string> = {};
      if (!Number.isInteger(p.maxTenorMonths) || p.maxTenorMonths < 1 || p.maxTenorMonths > ABSOLUTE_MAX_TENOR) errors.maxTenorMonths = `Maximum tenor must be a whole number from 1 to ${ABSOLUTE_MAX_TENOR} months.`;
      const s = parsePercentE4(p.shortRatePercent);
      const l = parsePercentE4(p.longRatePercent);
      if (s === null || s <= 0 || s > 1_000_000) errors.shortRatePercent = "Enter the short-band flat rate as a percentage greater than 0.";
      if (l === null || l <= 0 || l > 1_000_000) errors.longRatePercent = "Enter the long-band flat rate as a percentage greater than 0.";
      if (!p.reason || p.reason.trim().length < 5) errors.reason = "Give a reason for the change.";
      const effective = p.effectiveFrom ?? ctx.now;
      if (effective.getTime() < ctx.now.getTime() - 60_000) errors.effectiveFrom = "Changes apply prospectively: the effective time cannot be in the past.";
      if (Object.keys(errors).length) throw invalid("Check the pricing settings.", errors);
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('pricing_settings'))");
      const prev = await pricingSettingsAt(tx, effective);
      const latest = (await tx.query<{ max: number }>("SELECT max(version) AS max FROM pricing_settings")).rows[0].max;
      const r = await tx.query<SettingsRow>(
        `INSERT INTO pricing_settings (version, max_tenor_months, short_rate_e4, long_rate_e4, long_band_from_months, effective_from, reason, created_by, created_at, previous_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [latest + 1, p.maxTenorMonths, s, l, prev.longBandFromMonths, effective, p.reason.trim(), actor.staffId, ctx.now, prev.id],
      );
      await audit(tx, ctx, {
        action: "PRICING_SETTINGS_CHANGED",
        actorRole: "SUPER_ADMIN",
        reason: p.reason.trim(),
        details: {
          effectiveFrom: effective.toISOString(),
          old: { version: prev.version, maxTenorMonths: prev.maxTenorMonths, shortRate: e4ToPercent(prev.shortRateE4), longRate: e4ToPercent(prev.longRateE4) },
          new: { version: latest + 1, maxTenorMonths: p.maxTenorMonths, shortRate: e4ToPercent(s!), longRate: e4ToPercent(l!) },
        },
      });
      return toSettings(r.rows[0]);
    });
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") await auditOutsideTx(ctx, { action: "PRICING_SETTINGS_CHANGED", outcome: "DENIED", reason: e.message });
    throw e;
  }
}
