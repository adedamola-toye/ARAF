/**
 * Staff Salary Advance settings: versioned and append-only. A new version applies to drafts and
 * resubmissions from the moment it is saved; submitted requests keep the version they were priced on.
 */
import { withTx } from "../db";
import { requireStaffFinancing } from "./permission";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { forbidden, invalid } from "../errors";
import { parseNairaToKobo, parsePercentToBp } from "../money";
import { holdsRole } from "../domain/access";
import { APPLICANT_SUPPORTING_CATEGORIES } from "@/lib/staff-financing";

export interface SettingsInput {
  deductionPercent: string;
  minAmount?: string;
  maxAmount?: string;
  tenorOptions?: string;
  requiredDocuments?: string[];
  /** The one Unit Head for the staff route (must be active and hold the Unit Head role). */
  unitHeadId?: string | null;
  /** MANUAL (applicant-entered details, Product Manager verifies salary) or SALARY_REGISTER (automatic eligibility). */
  eligibilityMode?: "MANUAL" | "SALARY_REGISTER";
  eligibilityPercent?: string;
  salaryRecordMaxAgeDays?: string;
  reason: string;
}

export async function proposeStaffSettings(ctx: Ctx, p: SettingsInput) {
  await requireStaffFinancing(ctx, "PROPOSE_STAFF_SETTINGS", null);
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can change salary advance settings.");
    const fields: Record<string, string> = {};
    const bps = parsePercentToBp(p.deductionPercent);
    if (bps === null || bps > 10000) fields.deductionPercent = "Enter the deduction as a percentage, for example 2.";
    const min = p.minAmount ? parseNairaToKobo(p.minAmount) : null;
    const max = p.maxAmount ? parseNairaToKobo(p.maxAmount) : null;
    if (p.minAmount && !min) fields.minAmount = "Enter a naira amount or leave blank.";
    if (p.maxAmount && !max) fields.maxAmount = "Enter a naira amount or leave blank.";
    if (min && max && min > max) fields.maxAmount = "The maximum must be at least the minimum.";
    const tenors = (p.tenorOptions ?? "").split(/[,\s]+/).filter(Boolean).map(Number);
    if (tenors.some((t) => !Number.isInteger(t) || t < 1 || t > 360)) fields.tenorOptions = "List whole months separated by commas, for example 6, 12, 24, or leave blank.";
    const docs = (p.requiredDocuments ?? []).filter((d) => (APPLICANT_SUPPORTING_CATEGORIES as string[]).includes(d));
    let unitHead: string | null = null;
    if (p.unitHeadId) {
      const ok = await tx.query(
        `SELECT 1 FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.role = 'UNIT_HEAD' AND ra.active WHERE s.id = $1 AND s.status = 'ACTIVE'`,
        [p.unitHeadId],
      );
      if (!ok.rowCount) fields.unitHeadId = "Choose an active staff member who holds the Unit Head role.";
      else unitHead = p.unitHeadId;
    }
    const prev = (await tx.query("SELECT eligibility_mode, eligibility_percent_bps, salary_record_max_age_days FROM staff_financing_settings ORDER BY version DESC LIMIT 1")).rows[0];
    const mode = p.eligibilityMode ?? prev?.eligibility_mode ?? "MANUAL";
    if (!["MANUAL", "SALARY_REGISTER"].includes(mode)) fields.eligibilityMode = "Choose how eligibility is established.";
    const pctBps = p.eligibilityPercent?.trim() ? parsePercentToBp(p.eligibilityPercent) : (prev?.eligibility_percent_bps ?? 5000);
    if (pctBps === null || pctBps < 1 || pctBps > 10000) fields.eligibilityPercent = "Enter the eligibility percentage of verified monthly salary, for example 50.";
    const maxAge = p.salaryRecordMaxAgeDays?.trim() ? Number(p.salaryRecordMaxAgeDays) : (prev?.salary_record_max_age_days ?? 45);
    if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 400) fields.salaryRecordMaxAgeDays = "Whole days between 1 and 400.";
    if ((p.reason ?? "").trim().length < 3) fields.reason = "Record the reason and the source of the change.";
    if (Object.keys(fields).length) throw invalid("Check the settings.", fields);
    const v = Number((await tx.query("SELECT coalesce(max(version), 0) + 1 AS v FROM staff_financing_settings")).rows[0].v);
    const r = await tx.query<{ id: string }>(
      `INSERT INTO staff_financing_settings (version, deduction_rate_bps, min_amount_kobo, max_amount_kobo, tenor_options_months, required_document_types, unit_head_staff_id, reason, created_by, created_at,
         eligibility_mode, eligibility_percent_bps, salary_record_max_age_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [v, bps, min, max, [...new Set(tenors)].sort((a, b) => a - b), docs, unitHead, p.reason.trim(), actor.staffId, ctx.now, mode, pctBps, maxAge],
    );
    await audit(tx, ctx, { action: "STAFF_FIN_SETTINGS_CHANGED", actorRole: "SUPER_ADMIN", details: { version: v, eligibilityMode: mode, eligibilityPercentBps: pctBps, salaryRecordMaxAgeDays: maxAge, deductionRateBps: bps, minKobo: min, maxKobo: max, tenors, requiredDocuments: docs, unitHeadStaffId: unitHead } });
    return r.rows[0].id;
  });
}
