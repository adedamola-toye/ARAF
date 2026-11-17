/**
 * SeedFi "Proceed with Reason": a controlled exception for RM retail requests whose SeedFi credit check returned a
 * low score (Fail band). The RM may submit the request for review with a meaningful justification. The original
 * SeedFi result is never changed. The exception stays visible throughout, the Team Lead and the Unit Head must each
 * acknowledge it (with a recommendation and remarks) before their decision is saved, and it bypasses nothing:
 * approvals, documents, invoice confirmation and disbursement controls all still apply.
 *
 * Only a completed check with a Fail outcome qualifies. A SeedFi outage, timeout or invalid response is "unavailable"
 * and can never be bypassed (the check must be run again).
 */
import type { Db, Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, gate, invalid } from "../errors";
import { notify } from "./notifications";
import { enqueueEmail } from "../notify/outbox";
import { caseLink, simpleEmail } from "../notify/templates";
import { formatLagos } from "../time";
import type { AppRow } from "./assignment";
import type { TaskRow } from "./workflow";

export type Recommendation = "PROCEED" | "RETURN" | "DECLINE";
export const RECOMMENDATION_LABELS: Record<Recommendation, string> = { PROCEED: "Recommend proceeding", RETURN: "Return to the RM", DECLINE: "Decline" };

export interface FailedCheck {
  checkId: string;
  person: string;
  score: number | null;
  outcome: string;
  checkedAt: string;
}

export interface CreditExceptionRow {
  id: string;
  application_id: string;
  failed_checks: FailedCheck[];
  rm_reason: string;
  raised_by: string;
  raised_at: Date;
  status: "PENDING_REVIEW" | "APPROVED" | "DECLINED" | "WITHDRAWN" | "SUPERSEDED";
  tl_ack_by: string | null;
  tl_ack_at: Date | null;
  tl_recommendation: Recommendation | null;
  tl_remarks: string | null;
  uh_ack_by: string | null;
  uh_ack_at: Date | null;
  uh_recommendation: Recommendation | null;
  uh_remarks: string | null;
  dh_ack_by: string | null;
  dh_ack_at: Date | null;
  dh_recommendation: Recommendation | null;
  dh_remarks: string | null;
  raised_by_name?: string | null;
  tl_name?: string | null;
  uh_name?: string | null;
  dh_name?: string | null;
}

/** A justification must say something: at least 20 characters and 4 words, not filler or a repeated character. */
export function meaningfulReason(text: string | null | undefined): string | null {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  if (t.length < 20) return "Explain why the request should be considered despite the low score (at least 20 characters).";
  const words = t.split(" ").filter((w) => /[a-z]{2,}/i.test(w));
  if (words.length < 4) return "Write the justification in full sentences (at least four words).";
  const letters = t.replace(/[^a-z]/gi, "").toLowerCase();
  if (new Set(letters).size < 5) return "The justification does not look meaningful. Explain the customer's circumstances.";
  if (/^(n\/?a|none|nil|test|ok|okay|asdf|qwerty|xxx+|\.+)$/i.test(t) || /(.)\1{6,}/.test(t)) return "The justification does not look meaningful. Explain the customer's circumstances.";
  return null;
}

export async function creditExceptionFor(q: Db, appId: string): Promise<CreditExceptionRow | null> {
  return (
    (
      await q.query<CreditExceptionRow>(
        `SELECT e.*, r.full_name AS raised_by_name, t.full_name AS tl_name, u.full_name AS uh_name, d.full_name AS dh_name FROM credit_exceptions e
           JOIN staff r ON r.id = e.raised_by LEFT JOIN staff t ON t.id = e.tl_ack_by LEFT JOIN staff u ON u.id = e.uh_ack_by LEFT JOIN staff d ON d.id = e.dh_ack_by
          WHERE e.application_id = $1 ORDER BY (e.status = 'PENDING_REVIEW') DESC, e.raised_at DESC LIMIT 1`,
        [appId],
      )
    ).rows[0] ?? null
  );
}
export const openCreditException = async (q: Db, appId: string) => {
  const e = await creditExceptionFor(q, appId);
  return e && e.status === "PENDING_REVIEW" ? e : null;
};

/**
 * RM: Proceed with Reason. Requires at least one current low-score (Fail) check on the draft. Records the
 * justification against the failed checks; editing the reason later keeps the history in the audit trail.
 */
export async function proceedWithReason(ctx: Ctx, appId: string, reason: string, currentFailures: (q: Db) => Promise<FailedCheck[]>) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const problem = meaningfulReason(reason);
  if (problem) throw invalid(problem, { exceptionReason: problem });
  return withTx(async (tx) => {
    const app = (await tx.query<AppRow>("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [appId])).rows[0];
    if (!app || app.workflow !== "RETAIL") throw invalid("This is not a retail request.");
    if (app.initiator_id !== actor.staffId) throw forbidden("Only the RM who originated the request can proceed with a reason.");
    if (!["DRAFT", "INITIATOR_CORRECTION"].includes(app.stage)) throw gate("The justification is recorded before the request is submitted.");
    const failed = await currentFailures(tx);
    if (!failed.length) throw gate("Proceed with Reason applies only when SeedFi has returned a low credit score.");
    const text = reason.trim().replace(/\s+/g, " ");
    const open = await openCreditException(tx, appId);
    if (open) {
      await tx.query("UPDATE credit_exceptions SET rm_reason = $2, failed_checks = $3 WHERE id = $1", [open.id, text, JSON.stringify(failed)]);
      await audit(tx, ctx, { action: "CREDIT_EXCEPTION_REASON_UPDATED", actorRole: app.initiator_role, applicationId: appId, reason: text, details: { exceptionId: open.id, previousReason: open.rm_reason, failedChecks: failed } });
      return { id: open.id, updated: true };
    }
    const id = (
      await tx.query<{ id: string }>("INSERT INTO credit_exceptions (application_id, failed_checks, rm_reason, raised_by, raised_at) VALUES ($1,$2,$3,$4,$5) RETURNING id", [appId, JSON.stringify(failed), text, actor.staffId, ctx.now])
    ).rows[0].id;
    await audit(tx, ctx, { action: "CREDIT_EXCEPTION_RAISED", actorRole: app.initiator_role, applicationId: appId, reason: text, details: { exceptionId: id, failedChecks: failed, status: "PENDING_REVIEW" } });
    return { id, updated: false };
  });
}

/** Which reviewer must acknowledge the exception at this stage (null: none). */
export function ackSlot(e: CreditExceptionRow, stage: string): "tl" | "uh" | "dh" | null {
  if (stage === "TEAM_LEAD_REVIEW" && !e.tl_ack_at) return "tl";
  if (stage === "UNIT_HEAD_REVIEW" && !e.uh_ack_at) return "uh";
  // Unit Head-originated CX requests have neither a Team Lead nor a Unit Head review: the Divisional Head acknowledges.
  if (stage === "DIVISIONAL_HEAD_REVIEW" && !e.tl_ack_at && !e.uh_ack_at && !e.dh_ack_at) return "dh";
  return null;
}

export interface ExceptionAck {
  acknowledged: boolean;
  recommendation: Recommendation;
  remarks: string;
}

/** Before every Team Lead / Unit Head (or, where neither reviews, Divisional Head) decision: refused until acknowledged. */
export async function requireExceptionAck(tx: Tx, app: AppRow, task: TaskRow) {
  const e = await openCreditException(tx, app.id);
  if (e && ackSlot(e, task.stage)) throw gate("This request carries a credit score exception. Acknowledge it (with your recommendation and remarks) before recording your decision.");
}

/** The assigned reviewer acknowledges the exception, with a recommendation and remarks. */
export async function acknowledgeCreditException(ctx: Ctx, appId: string, ack: ExceptionAck) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const fields: Record<string, string> = {};
  if (!ack?.acknowledged) fields.exceptionAcknowledged = "Acknowledge the credit score exception.";
  if (!ack || !["PROCEED", "RETURN", "DECLINE"].includes(ack.recommendation)) fields.exceptionRecommendation = "Choose your recommendation on the exception.";
  if ((ack?.remarks ?? "").trim().length < 10) fields.exceptionRemarks = "Record your remarks on the exception (at least 10 characters).";
  if (Object.keys(fields).length) throw invalid("Complete the acknowledgement.", fields);
  return withTx(async (tx) => {
    const app = (await tx.query<AppRow>("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [appId])).rows[0];
    const task = (await tx.query<TaskRow>("SELECT * FROM tasks WHERE application_id = $1 AND status = 'OPEN' FOR UPDATE", [appId])).rows[0];
    if (!app || !task || task.assignee_id !== actor.staffId) throw forbidden("Only the reviewer this request is assigned to can acknowledge the exception.");
    const e = await openCreditException(tx, appId);
    if (!e) throw gate("There is no open credit score exception on this request.");
    assertNotSelfReview(e, actor.staffId);
    const slot = ackSlot(e, task.stage);
    if (!slot) throw gate("The exception has already been acknowledged at this stage.");
    await tx.query(`UPDATE credit_exceptions SET ${slot}_ack_by = $2, ${slot}_ack_at = $3, ${slot}_recommendation = $4, ${slot}_remarks = $5 WHERE id = $1`, [e.id, actor.staffId, ctx.now, ack.recommendation, ack.remarks.trim()]);
    await audit(tx, ctx, { action: "CREDIT_EXCEPTION_ACKNOWLEDGED", actorRole: task.assignee_role, applicationId: appId, stage: task.stage, reason: ack.remarks.trim(), details: { exceptionId: e.id, reviewer: slot.toUpperCase(), recommendation: ack.recommendation } });
    return { slot };
  });
}

/** Keeps the exception's outcome in step with the request (final approval, decline, withdrawal). */
export async function settleCreditException(tx: Tx, appId: string, stage: string, now: Date) {
  const status = stage === "OFFER_PREPARATION" ? "APPROVED" : stage === "REJECTED" ? "DECLINED" : stage === "WITHDRAWN" || stage === "EXPIRED" ? "WITHDRAWN" : null;
  if (!status) return;
  await tx.query("UPDATE credit_exceptions SET status = $2, closed_at = $3 WHERE application_id = $1 AND status = 'PENDING_REVIEW'", [appId, status, now]);
}

/** A later Pass/Fair on every person makes the exception unnecessary (kept, marked superseded). */
export async function supersedeIfCleared(tx: Tx, ctx: Ctx, appId: string, stillFailing: number) {
  if (stillFailing > 0) return;
  const r = await tx.query<{ id: string }>("UPDATE credit_exceptions SET status = 'SUPERSEDED', closed_at = $2 WHERE application_id = $1 AND status = 'PENDING_REVIEW' RETURNING id", [appId, ctx.now]);
  if (r.rowCount) await audit(tx, ctx, { action: "CREDIT_EXCEPTION_SUPERSEDED", applicationId: appId, details: { exceptionId: r.rows[0].id, reason: "A later SeedFi check returned Pass or Fair for every person." } });
}

const HEADING: Record<"tl" | "uh" | "dh", string> = {
  tl: "CREDIT SCORE EXCEPTION — SEEDFI LOW SCORE",
  uh: "CREDIT SCORE EXCEPTION — REQUIRES ATTENTION",
  dh: "CREDIT SCORE EXCEPTION — REQUIRES ATTENTION",
};

/** Explicit notification (in-app and email) to the reviewer a task with an open exception is assigned to. */
export async function notifyExceptionReviewer(tx: Tx, ctx: Ctx, app: AppRow, taskId: string, stage: string, staffId: string) {
  const e = await openCreditException(tx, app.id);
  if (!e) return;
  const slot = ackSlot(e, stage);
  if (!slot) return;
  const who = (await tx.query<{ email: string; full_name: string }>("SELECT email, full_name FROM staff WHERE id = $1", [staffId])).rows[0];
  const failed = e.failed_checks.map((f) => `${f.person}: Seed Score ${f.score ?? "not returned"} (${f.outcome === "FAIL" ? "low score" : f.outcome.toLowerCase()}), assessed ${formatLagos(f.checkedAt)}`);
  const lines = [
    HEADING[slot],
    "",
    `Customer: ${app.customer_name ?? "—"}`,
    `Facility reference: ${app.ref}`,
    `Product: ${app.product_label ?? app.product_code ?? "—"}`,
    `Original SeedFi result: ${failed.join("; ")}`,
    `RM's justification: ${e.rm_reason}`,
    ...(slot !== "tl" && e.tl_ack_at ? [`Team Lead acknowledgement: ${formatLagos(e.tl_ack_at)} · ${e.tl_recommendation ? RECOMMENDATION_LABELS[e.tl_recommendation] : ""} · ${e.tl_remarks ?? ""}`] : []),
    "",
    "You must acknowledge the exception, choose a recommendation and record your remarks before completing your review. Proceeding does not constitute credit approval.",
    "",
    caseLink(app.id, taskId),
  ];
  await notify(tx, ctx.now, { recipientId: staffId, kind: "CREDIT_EXCEPTION", title: `${HEADING[slot]}: ${app.ref}`, body: `${app.customer_name ?? ""} · ${app.product_label ?? ""}. RM's justification: ${e.rm_reason}`, applicationId: app.id, link: `/requests/${app.id}?task=${taskId}`, dedupeKey: `credit-exception:${e.id}:${taskId}` });
  if (who?.email) await enqueueEmail(tx, ctx.now, { kind: "CREDIT_EXCEPTION", dedupeKey: `credit-exception:${e.id}:${taskId}`, applicationId: app.id, to: [who.email], subject: `${HEADING[slot]} — ${app.ref}`, text: simpleEmail([`Dear ${who.full_name},`, "", ...lines]) });
}

/** Exception reporting: totals, pending reviews, outcomes and disbursed exception facilities. */
export async function creditExceptionReport(q: Db) {
  const n = async (sql: string) => Number((await q.query<{ n: string }>(sql)).rows[0].n);
  const rows = (
    await q.query<{ ref: string; id: string; application_id: string; customer_name: string | null; product_label: string | null; status: string; stage: string; raised_at: Date; rm_reason: string; tl_ack_at: Date | null; uh_ack_at: Date | null; disbursed: boolean }>(
      `SELECT a.ref, e.id, e.application_id, a.customer_name, a.product_label, e.status, a.stage, e.raised_at, e.rm_reason, e.tl_ack_at, e.uh_ack_at,
              (a.stage IN ('PAYMENT_RECONCILIATION','FULFILMENT','COMPLETED','COMPLETION','CLOSED','VENDOR_CONFIRMATION')) AS disbursed
         FROM credit_exceptions e JOIN applications a ON a.id = e.application_id ORDER BY e.raised_at DESC LIMIT 200`,
    )
  ).rows;
  return {
    total: await n("SELECT count(*) AS n FROM credit_exceptions WHERE status <> 'SUPERSEDED'"),
    pendingTeamLead: await n("SELECT count(*) AS n FROM credit_exceptions e JOIN applications a ON a.id = e.application_id WHERE e.status = 'PENDING_REVIEW' AND a.stage = 'TEAM_LEAD_REVIEW'"),
    pendingUnitHead: await n("SELECT count(*) AS n FROM credit_exceptions e JOIN applications a ON a.id = e.application_id WHERE e.status = 'PENDING_REVIEW' AND a.stage = 'UNIT_HEAD_REVIEW'"),
    approved: await n("SELECT count(*) AS n FROM credit_exceptions WHERE status = 'APPROVED'"),
    declined: await n("SELECT count(*) AS n FROM credit_exceptions WHERE status = 'DECLINED'"),
    disbursed: rows.filter((r) => r.disbursed).length,
    rows,
  };
}

export function assertNotSelfReview(e: CreditExceptionRow, staffId: string) {
  if (e.raised_by === staffId) throw conflict("You raised this exception and cannot review it.");
}

/** Serialisable view for the screens. */
export function exceptionView(e: CreditExceptionRow) {
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    status: e.status,
    rmReason: e.rm_reason,
    raisedBy: e.raised_by_name ?? null,
    raisedAt: new Date(e.raised_at).toISOString(),
    failed: e.failed_checks.map((f) => ({ person: f.person, score: f.score, checkedAt: f.checkedAt })),
    tl: { name: e.tl_name ?? null, at: iso(e.tl_ack_at), recommendation: e.tl_recommendation, remarks: e.tl_remarks },
    uh: { name: e.uh_name ?? null, at: iso(e.uh_ack_at), recommendation: e.uh_recommendation, remarks: e.uh_remarks },
    dh: { name: e.dh_name ?? null, at: iso(e.dh_ack_at), recommendation: e.dh_recommendation, remarks: e.dh_remarks },
  };
}
