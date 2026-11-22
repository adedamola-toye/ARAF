/**
 * Personal home figures and draft management.
 *
 * Financing figures are real records only, for the person's own applications (initiated, or assigned to them as
 * the Relationship Manager):
 *   initiated  = submitted applications (first submission date in the period) — drafts never count;
 *   approved   = final approval recorded in the period (Unit Head / Divisional Head approval);
 *   disbursed  = disbursement recorded with a transaction reference in the period.
 * Periods use Africa/Lagos calendar boundaries.
 */
import type { Db } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, gate } from "../errors";
import { fromLagos, lagosDate, lagosParts, lagosWeekStart } from "../time";
import { lockApp, moveTo, persistApp } from "./workflow";

export type HomePeriod = "today" | "week" | "month" | "year";
export const PERIOD_LABEL: Record<HomePeriod, string> = { today: "Today", week: "This week", month: "This month", year: "This year" };

export function periodStart(p: HomePeriod, now: Date): Date {
  const l = lagosParts(now);
  if (p === "today") return fromLagos(l.year, l.month, l.day);
  if (p === "week") return lagosWeekStart(now);
  if (p === "month") return fromLagos(l.year, l.month, 1);
  return fromLagos(l.year, 1, 1);
}

export interface HomeFigures {
  initiated: { kobo: string; count: number };
  approved: { kobo: string; count: number };
  disbursed: { kobo: string; count: number };
}

export async function initiatorFigures(q: Db, staffId: string, period: HomePeriod, now: Date): Promise<HomeFigures> {
  const from = periodStart(period, now);
  const r = (
    await q.query<{ ik: string; ic: string; ak: string; ac: string; dk: string; dc: string }>(
      `WITH mine AS (SELECT a.* FROM applications a WHERE (a.initiator_id = $1 OR a.assigned_rm_id = $1) AND a.submitted_at IS NOT NULL),
            appr AS (SELECT m.id, m.requested_amount_kobo,
                            (SELECT max(d.created_at) FROM decisions d WHERE d.application_id = m.id AND d.invalidated_at IS NULL AND d.action IN ('APPROVE','PROCEED')
                               AND d.stage IN ('DIVISIONAL_HEAD_REVIEW','UNIT_HEAD_REVIEW')) AS approved_at FROM mine m)
       SELECT coalesce(sum(requested_amount_kobo) FILTER (WHERE submitted_at >= $2 AND submitted_at < $3), 0) AS ik,
              count(*) FILTER (WHERE submitted_at >= $2 AND submitted_at < $3) AS ic,
              (SELECT coalesce(sum(requested_amount_kobo), 0) FROM appr WHERE approved_at >= $2 AND approved_at < $3) AS ak,
              (SELECT count(*) FROM appr WHERE approved_at >= $2 AND approved_at < $3) AS ac,
              (SELECT coalesce(sum(ds.amount_kobo), 0) FROM disbursements ds JOIN mine m2 ON m2.id = ds.application_id WHERE ds.disbursed_on >= $4::date AND ds.disbursed_on <= $5::date) AS dk,
              (SELECT count(*) FROM disbursements ds JOIN mine m2 ON m2.id = ds.application_id WHERE ds.disbursed_on >= $4::date AND ds.disbursed_on <= $5::date) AS dc
         FROM mine`,
      [staffId, from, new Date(now.getTime() + 1), lagosDate(from), lagosDate(now)],
    )
  ).rows[0];
  return { initiated: { kobo: r.ik, count: Number(r.ic) }, approved: { kobo: r.ak, count: Number(r.ac) }, disbursed: { kobo: r.dk, count: Number(r.dc) } };
}

export interface DraftRow {
  id: string;
  ref: string;
  customer_name: string | null;
  product_label: string | null;
  requested_amount_kobo: string | null;
  updated_at: Date;
  created_at: Date;
}

export async function myDrafts(q: Db, staffId: string): Promise<DraftRow[]> {
  return (
    await q.query<DraftRow>(
      "SELECT id, ref, customer_name, product_label, requested_amount_kobo, updated_at, created_at FROM applications WHERE initiator_id = $1 AND stage = 'DRAFT' ORDER BY updated_at DESC LIMIT 50",
      [staffId],
    )
  ).rows;
}

export async function myReturned(q: Db, staffId: string) {
  return (
    await q.query<DraftRow & { task_id: string | null }>(
      `SELECT a.id, a.ref, a.customer_name, a.product_label, a.requested_amount_kobo, a.updated_at, a.created_at, t.id AS task_id
         FROM applications a LEFT JOIN tasks t ON t.application_id = a.id AND t.status = 'OPEN'
        WHERE (a.initiator_id = $1 OR a.assigned_rm_id = $1) AND a.stage = 'INITIATOR_CORRECTION' ORDER BY a.updated_at DESC LIMIT 50`,
      [staffId],
    )
  ).rows;
}

/**
 * Delete a draft: only the person who started it, only while it has never been submitted. The record is closed
 * (stage Withdrawn) and audited rather than erased, so nothing submitted can ever be removed this way and other
 * applications are unaffected. A deleted draft never counts in any figure (it was never submitted).
 */
export async function deleteDraft(ctx: Ctx, appId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!/^[0-9a-f-]{36}$/i.test(appId)) throw gate("Draft not found.");
  return withTx(async (tx) => {
    const app = await lockApp(tx, appId);
    if (app.initiator_id !== actor.staffId) throw forbidden("Only the person who started this draft can delete it.");
    if (app.stage !== "DRAFT" || app.submitted_at) throw conflict("Only an unsubmitted draft can be deleted. A submitted request can only be withdrawn.");
    await tx.query("UPDATE applications SET withdrawn_at = $2 WHERE id = $1", [appId, ctx.now]);
    await moveTo(tx, ctx, app, "WITHDRAWN", null);
    await persistApp(tx, app, ctx.now);
    await audit(tx, ctx, { action: "DRAFT_DELETED", actorRole: app.initiator_role, applicationId: appId, details: { ref: app.ref } });
  });
}

