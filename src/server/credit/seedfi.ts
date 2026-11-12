/**
 * Shared SeedFi credit check (Seed Score) for every route: Altphones (Delight Officer / Smile Associate),
 * the Relationship Manager retail route and Staff Request. The bands are the Seed Score bands in the current
 * Altphones settings (set by a Super Admin): Pass, Fair (both continue) or Fail (the request stops).
 */
import type { Db } from "../db";
import type { Ctx } from "../context";
import { hmac } from "../crypto";
import { lagosDate } from "../time";
import { gate } from "../errors";
import { isBvn, mapScore, normalisePhone, type ScoreOutcome } from "@/lib/altphones";
import { creditBureau, IntegrationUnavailable } from "../altphones/integrations";
import { currentSettings } from "../altphones/core";

/** A Seed Score is valid for 30 days (SeedFi documentation, section 3.2). */
export const SCORE_VALID_DAYS = 30;

export interface PersonInput {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  phone: string;
  consent: boolean;
}

export function validatePerson(p: PersonInput, today: string, bvnRaw?: string) {
  const e: Record<string, string> = {};
  const bvn = (bvnRaw ?? "").replace(/\s/g, "");
  if (bvnRaw !== undefined && !isBvn(bvn)) e.bvn = "The BVN must be exactly 11 digits.";
  const clean = (s: string) => (s ?? "").trim().replace(/\s+/g, " ");
  const first = clean(p.firstName);
  const last = clean(p.lastName);
  if (first.length < 2 || first.length > 60) e.firstName = "Enter the first name as on the BVN.";
  if (last.length < 2 || last.length > 60) e.lastName = "Enter the last name as on the BVN.";
  const dob = (p.dateOfBirth ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(new Date(`${dob}T00:00:00Z`).getTime()) || dob >= today || dob < "1900-01-01") e.dateOfBirth = "Enter the date of birth.";
  const gender = (p.gender ?? "").toLowerCase();
  if (gender !== "male" && gender !== "female") e.gender = "Choose the gender on the BVN record.";
  const phone = normalisePhone(p.phone ?? "");
  if (!phone) e.phone = "Enter a Nigerian mobile number, e.g. 0803 123 4567.";
  if (!p.consent) e.consent = "The customer's consent is required.";
  return { errors: e, bvn, first, last, dob, gender: gender as "male" | "female", phone: phone! };
}

export const seedfiCustomerId = (bvn: string) => `altphones-${hmac(`bvn:${bvn}`).slice(0, 32)}`;
export const bvnHash = (bvn: string) => hmac(`bvn:${bvn}`);

export interface SeedfiOutcome {
  status: "COMPLETED" | "UNAVAILABLE";
  outcome: ScoreOutcome | null;
  score: number | null;
  overallScore: number | null;
  hasHistory: boolean | null;
  bands: Record<string, unknown> | null;
  details: Record<string, unknown>;
  error: string | null;
  customerId: string;
}

/** The current Seed Score bands; refuses when they are not configured. */
export async function scoreBands(q: Db) {
  const s = await currentSettings(q);
  if (s.score_pass_min === null || s.score_fair_min === null) throw gate("Seed Score bands are not configured. A Super Admin must record them in Altphones settings → Credit policy and routing.");
  return { passMin: Number(s.score_pass_min), fairMin: Number(s.score_fair_min), settingsVersion: s.version };
}

/** Call SeedFi (outside any transaction). Never reports a pass it did not receive. */
export async function callSeedfi(q: Db, p: { bvn: string; first: string; last: string; dob: string; gender: "male" | "female"; phone: string; tenureMonths?: number | null }): Promise<SeedfiOutcome> {
  const bands = await scoreBands(q);
  const customerId = seedfiCustomerId(p.bvn);
  const bureau = creditBureau();
  const base = { customerId, bands: null, details: {}, outcome: null, score: null, overallScore: null, hasHistory: null };
  if (!bureau) return { ...base, status: "UNAVAILABLE", error: "SeedFi is not configured. The credit check cannot be run until the integration is set up." };
  try {
    const r = await bureau.assess({ customerId, firstName: p.first, lastName: p.last, bvn: p.bvn, dateOfBirth: p.dob, phone: p.phone, gender: p.gender, loanDurationMonths: p.tenureMonths ?? null });
    const outcome = mapScore(r.score, bands.passMin, bands.fairMin)!;
    return {
      customerId,
      status: "COMPLETED",
      outcome,
      score: r.score,
      overallScore: r.overallScore,
      hasHistory: r.hasCreditHistory,
      bands: { ...bands, scoreUsed: "reviewed_seedfi_score" },
      details: { components: r.components, validUntil: r.validUntil, isDummyData: r.isDummyData },
      error: null,
    };
  } catch (e) {
    if (!(e instanceof IntegrationUnavailable)) console.error("[credit] SeedFi failure", e);
    return { ...base, status: "UNAVAILABLE", error: e instanceof IntegrationUnavailable ? e.message : "The SeedFi request failed." };
  }
}

export function todayIn(ctx: Ctx) {
  return lagosDate(ctx.now);
}

export interface CreditCheckRow {
  id: string;
  person_key: string;
  person_label: string;
  bvn_hash: string;
  bvn_last4: string;
  first_name: string;
  last_name: string;
  status: "COMPLETED" | "UNAVAILABLE";
  score: string | null;
  overall_score: string | null;
  has_history: boolean | null;
  outcome: ScoreOutcome | null;
  details: { validUntil?: string | null; isDummyData?: boolean };
  error: string | null;
  created_at: Date;
  requested_by_name?: string | null;
}

/** The latest check per person; `current` is true for a completed Pass/Fair within the validity period for the given BVN. */
export function isCurrentPass(c: CreditCheckRow | undefined, bvnHashNow: string | null, now: Date) {
  if (!c || c.status !== "COMPLETED" || !bvnHashNow || c.bvn_hash !== bvnHashNow) return false;
  if (c.outcome !== "PASS" && c.outcome !== "FAIR") return false;
  return now.getTime() - new Date(c.created_at).getTime() <= SCORE_VALID_DAYS * 86400_000;
}
