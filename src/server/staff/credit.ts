/**
 * SeedFi credit check on the Staff Request route: the applicant enters their BVN and BVN details before
 * submitting. Pass or Fair lets the request be submitted; Fail declines it. A check is valid for 30 days.
 */
import type { Db } from "../db";
import { requireStaffFinancing } from "./permission";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { forbidden, invalid } from "../errors";
import { bvnHash, callSeedfi, isCurrentPass, todayIn, validatePerson, type CreditCheckRow, type PersonInput } from "../credit/seedfi";
import { expectStatus, lockRequest, transition } from "./core";

export async function latestStaffCheck(q: Db, requestId: string): Promise<CreditCheckRow | undefined> {
  return (await q.query<CreditCheckRow>("SELECT * FROM credit_checks WHERE staff_request_id = $1 ORDER BY created_at DESC LIMIT 1", [requestId])).rows[0];
}

/** Null when the applicant has a current Pass or Fair. */
export async function staffCreditProblem(q: Db, requestId: string, now: Date): Promise<string | null> {
  const c = await latestStaffCheck(q, requestId);
  return isCurrentPass(c, c?.bvn_hash ?? null, now) ? null : "Run the SeedFi credit check with your BVN.";
}

export async function runStaffCreditCheck(ctx: Ctx, id: string, p: PersonInput & { bvn: string }) {
  await requireStaffFinancing(ctx, "RUN_STAFF_CREDIT_CHECK", id);
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const v = validatePerson(p, todayIn(ctx), p.bvn);
  if (Object.keys(v.errors).length) throw invalid(v.errors.bvn ? "Enter your 11-digit BVN." : "Check the details for the credit check.", v.errors);
  await withTx(async (tx) => {
    const req = await lockRequest(tx, id);
    if (req.applicant_id !== actor.staffId) throw forbidden("Only the applicant can run the credit check.");
    expectStatus(req, ["DRAFT", "RETURNED_FOR_CORRECTION"], "A credit check");
  });
  const r = await callSeedfi(db, { bvn: v.bvn, first: v.first, last: v.last, dob: v.dob, gender: v.gender, phone: v.phone });
  return withTx(async (tx) => {
    const req = await lockRequest(tx, id);
    await tx.query(
      `INSERT INTO credit_checks (staff_request_id, person_key, person_label, bvn_hash, bvn_last4, first_name, last_name, date_of_birth, gender, seedfi_customer_id,
          status, score, overall_score, has_history, outcome, bands, details, error, requested_by, created_at)
       VALUES ($1,'APPLICANT',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [req.id, req.full_name, bvnHash(v.bvn), v.bvn.slice(-4), v.first, v.last, v.dob, v.gender, r.customerId, r.status, r.score, r.overallScore, r.hasHistory, r.outcome, r.bands ? JSON.stringify(r.bands) : null, JSON.stringify(r.details), r.error, actor.staffId, ctx.now],
    );
    const details = { bvnLast4: v.bvn.slice(-4), outcome: r.outcome, score: r.score, overallScore: r.overallScore, error: r.error };
    if (r.outcome === "FAIL") {
      await transition(tx, ctx, req, { action: "CREDIT_CHECK_FAILED", to: "DECLINED", role: "STAFF_APPLICANT", outcome: "DECLINED", comments: `SeedFi Seed Score ${r.score} is below the Fair threshold.`, details });
    } else {
      await transition(tx, ctx, req, { action: r.status === "COMPLETED" ? "CREDIT_CHECK_COMPLETED" : "CREDIT_CHECK_UNAVAILABLE", role: "STAFF_APPLICANT", details });
    }
    const message =
      r.status === "UNAVAILABLE" ? `Integration unavailable — not assessed. ${r.error}` : r.outcome === "FAIL" ? `Seed Score ${r.score}: Fail. This request has been declined.` : `Seed Score ${r.score}: ${r.outcome === "PASS" ? "Pass" : "Fair"}. You can submit your request.`;
    return { outcome: r.outcome ?? "UNAVAILABLE", message };
  });
}
