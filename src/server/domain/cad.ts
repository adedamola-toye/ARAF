/**
 * CAD disbursement workspace: holds, failed / uncertain posting attempts, the pre-disbursement checklist and the
 * dashboard figures.
 *
 * ARAF does not post payments. A disbursement is successful only when Disbursement Officer 2 records the posting
 * with the core-banking transaction reference (existing maker-checker: DO1 checks, DO2 books). This module adds:
 *  - holds (with reason) that block both the DO1 check and the DO2 booking until released;
 *  - failed and uncertain posting attempts. An uncertain attempt blocks booking until someone verifies in core
 *    banking whether it posted (never an automatic retry). If it did post, the booking must use that reference.
 */
import type { Db, Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, gate, invalid, notFound } from "../errors";
import { holdsRole } from "./access";
import { notify } from "./notifications";
import { disbursementBlockers } from "./closing-checklist";
import { last4 } from "../mask";

export const CAD_ROLES = ["DISBURSEMENT_OFFICER_1", "DISBURSEMENT_OFFICER_2"] as const;
const CAD_STAGES = ["DISBURSEMENT_CHECK", "DISBURSEMENT_BOOKING"];
const REF_RE = /^[A-Za-z0-9\-/_.]{4,64}$/;

async function isCad(q: Db, staffId: string) {
  for (const r of CAD_ROLES) if (await holdsRole(q, staffId, r)) return true;
  return false;
}

async function lockCadApp(tx: Tx, ctx: Ctx, appId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!/^[0-9a-f-]{36}$/i.test(appId)) throw notFound("Request not found.");
  if (!(await isCad(tx, actor.staffId))) throw forbidden("Only Disbursement Officers can do this.");
  const app = (await tx.query<{ id: string; ref: string; stage: string; initiator_id: string; customer_name: string | null }>("SELECT id, ref, stage, initiator_id, customer_name FROM applications WHERE id = $1 FOR UPDATE", [appId])).rows[0];
  if (!app) throw notFound("Request not found.");
  if (!CAD_STAGES.includes(app.stage)) throw conflict("This request is not at disbursement.");
  const role = (await holdsRole(tx, actor.staffId, app.stage === "DISBURSEMENT_BOOKING" ? "DISBURSEMENT_OFFICER_2" : "DISBURSEMENT_OFFICER_1")) ? (app.stage === "DISBURSEMENT_BOOKING" ? "DISBURSEMENT_OFFICER_2" : "DISBURSEMENT_OFFICER_1") : "DISBURSEMENT_OFFICER_1";
  return { app, role, staffId: actor.staffId };
}

export async function activeHold(q: Db, appId: string) {
  return (
    await q.query<{ id: string; reason: string; held_at: Date; held_by_name: string; held_role: string }>(
      "SELECT h.id, h.reason, h.held_at, h.held_role, s.full_name AS held_by_name FROM disbursement_holds h JOIN staff s ON s.id = h.held_by WHERE h.application_id = $1 AND h.released_at IS NULL",
      [appId],
    )
  ).rows[0] ?? null;
}

export async function holdDisbursement(ctx: Ctx, appId: string, reason: string) {
  const why = (reason ?? "").trim();
  if (why.length < 10) throw invalid("Give the reason for the hold (at least 10 characters).", { reason: "Reason required." });
  return withTx(async (tx) => {
    const { app, role, staffId } = await lockCadApp(tx, ctx, appId);
    if (await activeHold(tx, appId)) throw conflict("This disbursement is already on hold.");
    await tx.query("INSERT INTO disbursement_holds (application_id, reason, held_by, held_role, held_at) VALUES ($1,$2,$3,$4,$5)", [appId, why, staffId, role, ctx.now]);
    await audit(tx, ctx, { action: "DISBURSEMENT_HELD", actorRole: role, applicationId: appId, stage: app.stage, reason: why });
    await notify(tx, ctx.now, { recipientId: app.initiator_id, kind: "DISBURSEMENT_HELD", title: `${app.ref}: disbursement on hold`, body: why, applicationId: appId, link: `/requests/${appId}`, dedupeKey: `disb-held:${appId}:${ctx.now.getTime()}` });
  });
}

export async function releaseHold(ctx: Ctx, appId: string, note: string) {
  const text = (note ?? "").trim();
  if (text.length < 10) throw invalid("Say how the hold was resolved (at least 10 characters).", { note: "Required." });
  return withTx(async (tx) => {
    const { app, role, staffId } = await lockCadApp(tx, ctx, appId);
    const h = await activeHold(tx, appId);
    if (!h) throw conflict("This disbursement is not on hold.");
    await tx.query("UPDATE disbursement_holds SET released_at = $2, released_by = $3, release_note = $4 WHERE id = $1", [h.id, ctx.now, staffId, text]);
    await audit(tx, ctx, { action: "DISBURSEMENT_HOLD_RELEASED", actorRole: role, applicationId: appId, stage: app.stage, reason: text, details: { holdId: h.id, heldReason: h.reason } });
  });
}

export interface AttemptRow {
  id: string;
  outcome: "FAILED" | "UNCERTAIN";
  attempted_ref: string | null;
  amount_kobo: string | null;
  note: string;
  recorded_at: Date;
  recorded_by_name: string;
  resolution: "NOT_POSTED" | "POSTED" | null;
  resolution_note: string | null;
  resolved_at: Date | null;
  resolved_by_name: string | null;
}

export async function attempts(q: Db, appId: string): Promise<AttemptRow[]> {
  return (
    await q.query<AttemptRow>(
      `SELECT a.id, a.outcome, a.attempted_ref, a.amount_kobo::text, a.note, a.recorded_at, s.full_name AS recorded_by_name, a.resolution, a.resolution_note, a.resolved_at, r.full_name AS resolved_by_name
         FROM disbursement_attempts a JOIN staff s ON s.id = a.recorded_by LEFT JOIN staff r ON r.id = a.resolved_by WHERE a.application_id = $1 ORDER BY a.recorded_at DESC`,
      [appId],
    )
  ).rows;
}

/** Record a posting attempt that did not clearly succeed. Only at booking (DO2). */
export async function recordAttempt(ctx: Ctx, appId: string, p: { outcome: "FAILED" | "UNCERTAIN"; attemptedRef?: string | null; amountKobo?: number | null; note: string }) {
  const note = (p.note ?? "").trim();
  const errors: Record<string, string> = {};
  if (!["FAILED", "UNCERTAIN"].includes(p.outcome)) errors.outcome = "Choose failed or uncertain.";
  if (note.length < 10) errors.note = "Describe what happened (at least 10 characters).";
  const ref = (p.attemptedRef ?? "").trim() || null;
  if (ref && !REF_RE.test(ref)) errors.attemptedRef = "4–64 letters, digits or - / _ .";
  if (p.amountKobo != null && (!Number.isSafeInteger(p.amountKobo) || p.amountKobo <= 0)) errors.amount = "Enter the amount attempted.";
  if (Object.keys(errors).length) throw invalid("Check the attempt details.", errors);
  return withTx(async (tx) => {
    const { app, staffId } = await lockCadApp(tx, ctx, appId);
    if (app.stage !== "DISBURSEMENT_BOOKING") throw gate("Posting attempts are recorded at booking (Disbursement Officer 2).");
    const wf = (await tx.query<{ workflow: string }>("SELECT workflow FROM applications WHERE id = $1", [appId])).rows[0].workflow;
    if (wf === "RETAIL") throw gate("Retail payments are recorded in payment confirmation and reconciliation after the facility is booked.");
    if (!(await holdsRole(tx, staffId, "DISBURSEMENT_OFFICER_2"))) throw forbidden("Only Disbursement Officer 2 records posting attempts.");
    const r = await tx.query<{ id: string }>(
      `INSERT INTO disbursement_attempts (application_id, outcome, attempted_ref, amount_kobo, note, recorded_by, recorded_at, resolution, resolved_by, resolved_at, resolution_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      // A clear failure is resolved as not posted when recorded; an uncertain outcome stays open until verified.
      p.outcome === "FAILED"
        ? [appId, p.outcome, ref, p.amountKobo ?? null, note, staffId, ctx.now, "NOT_POSTED", staffId, ctx.now, "Recorded as a failed posting."]
        : [appId, p.outcome, ref, p.amountKobo ?? null, note, staffId, ctx.now, null, null, null, null],
    );
    await audit(tx, ctx, { action: p.outcome === "FAILED" ? "DISBURSEMENT_ATTEMPT_FAILED" : "DISBURSEMENT_ATTEMPT_UNCERTAIN", actorRole: "DISBURSEMENT_OFFICER_2", applicationId: appId, stage: app.stage, reason: note, details: { attemptId: r.rows[0].id, attemptedRef: ref, amountKobo: p.amountKobo ?? null } });
    return r.rows[0].id;
  });
}

/** Resolve an uncertain attempt after checking core banking. POSTED pins the booking to that reference. */
export async function resolveAttempt(ctx: Ctx, attemptId: string, resolution: "NOT_POSTED" | "POSTED", note: string, postedRef?: string | null) {
  const text = (note ?? "").trim();
  if (text.length < 10) throw invalid("Record how you verified the outcome (at least 10 characters).", { note: "Required." });
  if (!["NOT_POSTED", "POSTED"].includes(resolution)) throw invalid("Choose whether the payment posted.");
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) throw notFound();
  return withTx(async (tx) => {
    const at = (await tx.query<{ id: string; application_id: string; outcome: string; resolution: string | null; attempted_ref: string | null }>("SELECT * FROM disbursement_attempts WHERE id = $1 FOR UPDATE", [attemptId])).rows[0];
    if (!at) throw notFound();
    const { app, role, staffId } = await lockCadApp(tx, ctx, at.application_id);
    if (at.resolution) throw conflict("This attempt has already been resolved.");
    let ref = at.attempted_ref;
    if (resolution === "POSTED") {
      const given = (postedRef ?? "").trim() || null;
      if (given && !REF_RE.test(given)) throw invalid("Enter the posted transaction reference.", { postedRef: "4–64 letters, digits or - / _ ." });
      ref = given ?? ref;
      if (!ref) throw invalid("Enter the posted transaction reference from core banking.", { postedRef: "Required when the payment posted." });
    }
    await tx.query("UPDATE disbursement_attempts SET resolution = $2, resolution_note = $3, resolved_by = $4, resolved_at = $5, attempted_ref = $6 WHERE id = $1", [attemptId, resolution, text, staffId, ctx.now, ref]);
    await audit(tx, ctx, { action: "DISBURSEMENT_ATTEMPT_RESOLVED", actorRole: role, applicationId: app.id, stage: app.stage, reason: text, details: { attemptId, resolution, ref } });
  });
}

/** Checked inside booking: hold, unresolved uncertain attempt, posted-attempt reference. */
export async function bookingBlockers(q: Db, appId: string, transactionRef: string | null): Promise<string[]> {
  const out: string[] = [];
  const h = await activeHold(q, appId);
  if (h) out.push(`On hold: ${h.reason}. Release the hold first.`);
  const list = await attempts(q, appId);
  if (list.some((a) => a.outcome === "UNCERTAIN" && !a.resolution)) out.push("An uncertain posting attempt has not been verified. Check core banking and resolve it before recording the disbursement — never retry blindly.");
  const posted = list.find((a) => a.resolution === "POSTED");
  if (posted && transactionRef != null && posted.attempted_ref && posted.attempted_ref !== transactionRef) {
    out.push(`A previous attempt was verified as posted with reference ${posted.attempted_ref}. Record the disbursement with that reference; do not post again.`);
  }
  return out;
}

// ------------------------------------------------------------------ checklist + dashboard

export interface CheckItem {
  code: string;
  label: string;
  ok: boolean;
  detail: string;
}

/** Read-only pre-disbursement checklist, computed from records. */
export async function preDisbursementChecklist(q: Db, appId: string): Promise<CheckItem[]> {
  const app = (await q.query("SELECT * FROM applications WHERE id = $1", [appId])).rows[0];
  if (!app) return [];
  const dec = (
    await q.query<{ stage: string; actor: string; created_at: Date; reason: string | null }>(
      `SELECT d.stage, s.full_name AS actor, d.created_at, d.reason FROM decisions d JOIN staff s ON s.id = d.actor_id
        WHERE d.application_id = $1 AND d.invalidated_at IS NULL AND d.action IN ('APPROVE','PROCEED') ORDER BY d.created_at`,
      [appId],
    )
  ).rows;
  const uh = dec.filter((d) => ["UNIT_HEAD_REVIEW", "HEAD_OF_UNIT_APPROVAL"].includes(d.stage)).at(-1);
  const dh = dec.filter((d) => d.stage === "DIVISIONAL_HEAD_REVIEW").at(-1);
  const bouquet = (await q.query<{ ref: string }>("SELECT b.ref FROM bouquet_members m JOIN bouquets b ON b.id = m.bouquet_id WHERE m.application_id = $1 AND m.status = 'CONCURRED' ORDER BY m.concurred_at DESC LIMIT 1", [appId])).rows[0];
  const blockers = await disbursementBlockers(q, app);
  const signedMissing = blockers.some((b) => /signed offer/i.test(b));
  const hold = await activeHold(q, appId);
  const list = await attempts(q, appId);
  const dup = await q.query("SELECT 1 FROM disbursements WHERE application_id = $1", [appId]);
  const uncertain = list.some((a) => a.outcome === "UNCERTAIN" && !a.resolution);
  return [
    { code: "AUTHORITY", label: "Approval authority verified", ok: !!uh, detail: uh ? `Unit Head approval by ${uh.actor}` : "No current Unit Head approval on record" },
    { code: "CONCURRENCE", label: "Final concurrence verified", ok: !!dh, detail: dh ? `Divisional Head ${dh.actor}${bouquet ? ` · bouquet ${bouquet.ref}` : ""}` : "No current Divisional Head concurrence on record" },
    { code: "OFFER", label: "Signed offer and acceptance verified", ok: !signedMissing, detail: signedMissing ? "Signed offer letter not in the closing pack" : "Signed offer letter in the closing pack" },
    { code: "CONDITIONS", label: "Conditions precedent satisfied", ok: blockers.length === 0, detail: blockers.length ? blockers.join(" ") : "Closing pack complete; invoice confirmation satisfied" },
    { code: "HOLD", label: "No hold in place", ok: !hold, detail: hold ? `Held: ${hold.reason}` : "Not on hold" },
    { code: "DUPLICATE", label: "Duplicate disbursement checks completed", ok: !dup.rowCount && !uncertain, detail: dup.rowCount ? "A disbursement is already recorded" : uncertain ? "An uncertain posting attempt must be verified first" : "No disbursement or unverified attempt on record" },
  ];
}

export interface CadRow {
  application_id: string;
  ref: string;
  customer_name: string | null;
  product_label: string | null;
  amount_kobo: string;
  stage: string;
  task_id: string | null;
  assignee_name: string | null;
  assigned_at: Date | null;
  mine: boolean;
  held: boolean;
  hold_reason: string | null;
  uncertain: boolean;
}

export async function cadOverview(q: Db, staffId: string, monthStart: Date) {
  const rows = (
    await q.query<CadRow>(
      `SELECT a.id AS application_id, a.ref, a.customer_name, a.product_label, coalesce(a.requested_amount_kobo, 0)::text AS amount_kobo, a.stage,
              t.id AS task_id, s.full_name AS assignee_name, t.assigned_at, (t.assignee_id = $1) AS mine,
              (h.id IS NOT NULL) AS held, h.reason AS hold_reason,
              EXISTS (SELECT 1 FROM disbursement_attempts x WHERE x.application_id = a.id AND x.outcome = 'UNCERTAIN' AND x.resolution IS NULL) AS uncertain
         FROM applications a
         LEFT JOIN tasks t ON t.application_id = a.id AND t.status = 'OPEN'
         LEFT JOIN staff s ON s.id = t.assignee_id
         LEFT JOIN disbursement_holds h ON h.application_id = a.id AND h.released_at IS NULL
        WHERE a.stage IN ('DISBURSEMENT_CHECK','DISBURSEMENT_BOOKING','DISBURSEMENT_CORRECTION')
        ORDER BY t.assigned_at NULLS LAST`,
      [staffId],
    )
  ).rows;
  const sum = (xs: CadRow[]) => xs.reduce((t, r) => t + BigInt(r.amount_kobo), 0n).toString();
  const ready = rows.filter((r) => r.stage === "DISBURSEMENT_BOOKING" && !r.held && !r.uncertain);
  const checking = rows.filter((r) => r.stage === "DISBURSEMENT_CHECK" && !r.held);
  const held = rows.filter((r) => r.held);
  const processing = rows.filter((r) => r.uncertain && !r.held);
  const correction = rows.filter((r) => r.stage === "DISBURSEMENT_CORRECTION");
  const failed = (
    await q.query<{ application_id: string; ref: string; customer_name: string | null; note: string; recorded_at: Date; outcome: string; resolution: string | null }>(
      `SELECT x.application_id, a.ref, a.customer_name, x.note, x.recorded_at, x.outcome, x.resolution FROM disbursement_attempts x JOIN applications a ON a.id = x.application_id
        WHERE x.recorded_at >= $1 ORDER BY x.recorded_at DESC LIMIT 20`,
      [monthStart],
    )
  ).rows;
  const done = (
    await q.query<{ application_id: string; ref: string; customer_name: string | null; amount_kobo: string; transaction_ref: string; disbursed_on: string; recorded_at: Date; recorded_by_name: string }>(
      `SELECT d.application_id, a.ref, a.customer_name, d.amount_kobo::text, d.transaction_ref, d.disbursed_on::text, d.recorded_at, s.full_name AS recorded_by_name
         FROM disbursements d JOIN applications a ON a.id = d.application_id JOIN staff s ON s.id = d.recorded_by ORDER BY d.recorded_at DESC LIMIT 20`,
    )
  ).rows;
  const month = (await q.query<{ n: number; kobo: string }>("SELECT count(*)::int AS n, coalesce(sum(amount_kobo), 0)::text AS kobo FROM disbursements WHERE recorded_at >= $1", [monthStart])).rows[0];
  return {
    ready: { rows: ready, kobo: sum(ready) },
    checking: { rows: checking, kobo: sum(checking) },
    held: { rows: held, kobo: sum(held) },
    processing: { rows: processing, kobo: sum(processing) },
    correction,
    failed,
    done,
    month,
  };
}

/** Completion record: only from a recorded disbursement (never from a button click alone). */
export async function completionRecord(q: Db, appId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(appId)) return null;
  const r = (
    await q.query<{
      application_id: string; ref: string; customer_name: string | null; product_label: string | null; amount_kobo: string; approved_amount_kobo: string; transaction_ref: string;
      disbursed_on: string; recorded_at: Date; recorded_by_name: string; stage: string; current_version_id: string | null; instalments: number; first_due: string | null; instalment_kobo: string | null;
    }>(
      `SELECT d.application_id, a.ref, a.customer_name, a.product_label, d.amount_kobo::text, d.approved_amount_kobo::text, d.transaction_ref, d.disbursed_on::text, d.recorded_at,
              s.full_name AS recorded_by_name, a.stage, a.current_version_id,
              (SELECT count(*)::int FROM repayment_instalments i WHERE i.disbursement_id = d.id) AS instalments,
              (SELECT min(due_date)::text FROM repayment_instalments i WHERE i.disbursement_id = d.id) AS first_due,
              (SELECT amount_kobo::text FROM repayment_instalments i WHERE i.disbursement_id = d.id ORDER BY seq LIMIT 1) AS instalment_kobo
         FROM disbursements d JOIN applications a ON a.id = d.application_id JOIN staff s ON s.id = d.recorded_by WHERE d.application_id = $1`,
      [appId],
    )
  ).rows[0];
  if (!r) return null;
  const ben = r.current_version_id
    ? ((await q.query<{ b: { vendorName?: string; institutionName?: string; accountNumber?: string; accountName?: string } | null }>("SELECT data->'beneficiarySnapshot' AS b FROM application_versions WHERE id = $1", [r.current_version_id])).rows[0]?.b ?? null)
    : null;
  return {
    ...r,
    beneficiary: ben ? { name: ben.accountName ?? ben.vendorName ?? null, vendor: ben.vendorName ?? null, bank: ben.institutionName ?? null, account: ben.accountNumber ? `•••••• ${last4(ben.accountNumber)}` : null } : null,
  };
}

export async function canUseCad(q: Db, staffId: string) {
  return isCad(q, staffId);
}
