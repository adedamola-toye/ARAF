/**
 * SeedFi credit check on the Relationship Manager retail route. The initiator runs it before submission on the
 * applicant (individual or enterprise proprietor) or, for a limited company, on each director, using the BVN
 * already captured in the draft. Pass or Fair lets the request be submitted. A low score (Fail) no longer closes
 * the request: the RM may "Proceed with Reason" (credit-exception.ts), which submits it for Team Lead and Unit Head
 * review with the original result kept. An unavailable result can never be bypassed.
 * A check counts only for the BVN currently on the draft and for 30 days.
 */
import type { Db } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { decryptField } from "../crypto";
import { DomainError, forbidden, gate, invalid, notFound } from "../errors";
import { assertCanEdit, lockApp } from "./workflow";
import { openCreditException, type FailedCheck } from "./credit-exception";
import { loadRetailState } from "./retail";
import { bvnHash, callSeedfi, isCurrentPass, SCORE_VALID_DAYS, todayIn, validatePerson, type CreditCheckRow, type PersonInput } from "../credit/seedfi";

export interface CreditPerson {
  key: string;
  label: string;
  bvnHash: string | null;
  bvnLast4: string | null;
  latest: CreditCheckRow | undefined;
  current: boolean;
}

async function persons(q: Db, appId: string): Promise<{ key: string; label: string; bvnEnc: string | null; bvnLast4: string | null }[]> {
  const { app, version, data, directors } = await loadRetailState(q, appId);
  if (app.applicant_type === "LIMITED") {
    return directors.map((d: { position: number; full_name: string; bvn_enc: string; bvn_last4: string }, i: number) => ({
      key: `DIRECTOR:${d.position ?? i + 1}`,
      label: `Director: ${d.full_name}`,
      bvnEnc: d.bvn_enc,
      bvnLast4: d.bvn_last4,
    }));
  }
  return [{ key: "APPLICANT", label: data.customerName || "Applicant", bvnEnc: version?.bvn_enc ?? null, bvnLast4: version?.bvn_last4 ?? null }];
}

export async function retailCreditStatus(q: Db, appId: string, now: Date): Promise<CreditPerson[]> {
  const ps = await persons(q, appId);
  const rows = (
    await q.query<CreditCheckRow>(
      `SELECT DISTINCT ON (c.person_key) c.*, s.full_name AS requested_by_name FROM credit_checks c LEFT JOIN staff s ON s.id = c.requested_by
        WHERE c.application_id = $1 ORDER BY c.person_key, c.created_at DESC`,
      [appId],
    )
  ).rows;
  const latest = new Map(rows.map((r) => [r.person_key, r]));
  return ps.map((p) => {
    const h = p.bvnEnc ? bvnHash(decryptField(p.bvnEnc)) : null;
    const l = latest.get(p.key);
    return { key: p.key, label: p.label, bvnHash: h, bvnLast4: p.bvnLast4, latest: l && l.bvn_hash === h ? l : undefined, current: isCurrentPass(l, h, now) };
  });
}

/** A completed low-score (Fail) check, for the BVN now on the draft, within the validity period. */
export function isCurrentFail(c: CreditCheckRow | undefined, bvnHashNow: string | null, now: Date) {
  if (!c || c.status !== "COMPLETED" || !bvnHashNow || c.bvn_hash !== bvnHashNow || c.outcome !== "FAIL") return false;
  return now.getTime() - new Date(c.created_at).getTime() <= SCORE_VALID_DAYS * 86400_000;
}

/** People whose current SeedFi result is a low score (qualifies for Proceed with Reason). */
export async function currentLowScores(q: Db, appId: string, now: Date): Promise<FailedCheck[]> {
  return (await retailCreditStatus(q, appId, now))
    .filter((p) => isCurrentFail(p.latest, p.bvnHash, now))
    .map((p) => ({ checkId: p.latest!.id, person: p.label, score: p.latest!.score === null ? null : Number(p.latest!.score), outcome: "FAIL", checkedAt: new Date(p.latest!.created_at).toISOString() }));
}

/** Blockers for submission (empty when every person has a current Pass or Fair, or a low score covered by Proceed with Reason). */
export async function retailCreditBlockers(q: Db, appId: string, now: Date): Promise<string[]> {
  const st = await retailCreditStatus(q, appId, now);
  const exception = await openCreditException(q, appId);
  const out: string[] = [];
  for (const p of st) {
    if (!p.bvnHash || p.current) continue;
    if (isCurrentFail(p.latest, p.bvnHash, now)) {
      if (!exception) out.push(`SeedFi returned a low credit score for ${p.label}. Use Proceed with Reason to submit the request for review, or withdraw it.`);
      continue;
    }
    out.push(`Run the SeedFi credit check for ${p.label}.`);
  }
  return out;
}

export async function runRetailCreditCheck(ctx: Ctx, appId: string, personKey: string, p: PersonInput) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const v = validatePerson(p, todayIn(ctx));
  if (Object.keys(v.errors).length) throw invalid("Check the details for the credit check.", v.errors);
  let bvn: string;
  let label: string;
  try {
    ({ bvn, label } = await withTx(async (tx) => {
      const app = await lockApp(tx, appId);
      if (app.workflow !== "RETAIL") throw invalid("This is not a retail application.");
      if (app.initiator_id !== actor.staffId) throw forbidden("Only the initiator runs the credit check.");
      await assertCanEdit(tx, ctx, app);
      const person = (await persons(tx, appId)).find((x) => x.key === personKey);
      if (!person) throw notFound("Choose the applicant or director to check.");
      if (!person.bvnEnc) throw gate(`Save the BVN for ${person.label} in the request first.`);
      return { bvn: decryptField(person.bvnEnc), label: person.label };
    }));
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") await auditOutsideTx(ctx, { action: "CREDIT_CHECK_DENIED", outcome: "DENIED", applicationId: appId, reason: e.message });
    throw e;
  }
  const r = await callSeedfi(db, { bvn, first: v.first, last: v.last, dob: v.dob, gender: v.gender, phone: v.phone });
  return withTx(async (tx) => {
    const app = await lockApp(tx, appId);
    await tx.query(
      `INSERT INTO credit_checks (application_id, person_key, person_label, bvn_hash, bvn_last4, first_name, last_name, date_of_birth, gender, seedfi_customer_id,
          status, score, overall_score, has_history, outcome, bands, details, error, requested_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [app.id, personKey, label, bvnHash(bvn), bvn.slice(-4), v.first, v.last, v.dob, v.gender, r.customerId, r.status, r.score, r.overallScore, r.hasHistory, r.outcome, r.bands ? JSON.stringify(r.bands) : null, JSON.stringify(r.details), r.error, actor.staffId, ctx.now],
    );
    await audit(tx, ctx, {
      action: r.status === "COMPLETED" ? "CREDIT_CHECK_COMPLETED" : "CREDIT_CHECK_UNAVAILABLE",
      actorRole: app.initiator_role,
      applicationId: app.id,
      stage: app.stage,
      details: { person: label, bvnLast4: bvn.slice(-4), outcome: r.outcome, score: r.score, overallScore: r.overallScore, error: r.error },
    });
    if (r.outcome === "FAIL") {
      // Low score: the request stays open. The RM may Proceed with Reason; the original result is kept as returned.
      await audit(tx, ctx, { action: "CREDIT_CHECK_LOW_SCORE", actorRole: app.initiator_role, applicationId: app.id, reason: `Seed Score ${r.score} for ${label} is in the low-score band.`, details: { person: label, score: r.score } });
    }
    const message =
      r.status === "UNAVAILABLE"
        ? `Integration unavailable — not assessed. ${r.error}`
        : r.outcome === "FAIL"
          ? `Credit assessment unsuccessful: SeedFi returned a low credit score (${r.score}) for ${label}. You may submit the request for further review by proceeding with a reason. Proceeding does not constitute credit approval.`
          : `Seed Score ${r.score} for ${label}: ${r.outcome === "PASS" ? "Pass" : "Fair"}.`;
    return { outcome: r.outcome ?? "UNAVAILABLE", message };
  });
}
