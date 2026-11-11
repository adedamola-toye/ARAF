/**
 * Relationship Manager daily request wallet ("Total Requested Today").
 *
 * The request ledger has exactly one immutable row per application, written inside the submission
 * transaction the first time the application is submitted. Drafts, corrections, resubmissions, refreshes
 * and retries never add a row; the amount is the requested amount at first submission, in kobo, and the
 * day is the Africa/Lagos calendar date of that submission. Approved / booked / disbursed amounts are
 * reported separately and never change the ledger.
 */
import type { Db, Tx } from "../db";
import { lagosDate } from "../time";
import type { AppRow } from "./assignment";

export async function recordRequestLedger(tx: Tx, app: Pick<AppRow, "id" | "initiator_id" | "initiator_role" | "requested_amount_kobo" | "customer_name"> & { product_code?: string | null; product_label?: string | null }, now: Date) {
  const amount = Number(app.requested_amount_kobo ?? 0);
  if (!(amount > 0)) return;
  await tx.query(
    `INSERT INTO request_ledger (application_id, initiator_id, initiator_role, submitted_at, lagos_date, requested_amount_kobo, product_code, product_label, customer_name, latest_requested_amount_kobo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$6)
     ON CONFLICT (application_id) DO NOTHING`,
    [app.id, app.initiator_id, app.initiator_role, now, lagosDate(now), amount, app.product_code ?? null, app.product_label ?? null, app.customer_name],
  );
}

/** Keep the latest requested amount visible (history), without changing the submitted amount. */
export async function noteLatestRequestedAmount(tx: Tx, appId: string, amountKobo: number | null) {
  await tx.query("UPDATE request_ledger SET latest_requested_amount_kobo = $2 WHERE application_id = $1", [appId, amountKobo]);
}

export interface WalletRow {
  application_id: string;
  ref: string;
  customer_name: string | null;
  product_label: string | null;
  requested_amount_kobo: string;
  latest_requested_amount_kobo: string | null;
  submitted_at: Date;
  lagos_date: string;
  status: string;
  stage: string;
  approved_kobo: string | null;
  disbursed_kobo: string | null;
}

/** One day's requests for an initiator (scope enforced by the caller passing the actor's own id). */
export async function walletDay(q: Db, initiatorId: string, day: string) {
  const rows = (
    await q.query<WalletRow>(
      `SELECT l.application_id, a.ref, l.customer_name, l.product_label, l.requested_amount_kobo, l.latest_requested_amount_kobo, l.submitted_at,
              to_char(l.lagos_date, 'YYYY-MM-DD') AS lagos_date, a.status, a.stage,
              (SELECT f.principal_kobo FROM facilities f WHERE f.application_id = a.id) AS approved_kobo,
              (SELECT d.amount_kobo FROM disbursements d WHERE d.application_id = a.id) AS disbursed_kobo
         FROM request_ledger l JOIN applications a ON a.id = l.application_id
        WHERE l.initiator_id = $1 AND l.lagos_date = $2::date
        ORDER BY l.submitted_at`,
      [initiatorId, day],
    )
  ).rows;
  const total = rows.reduce((s, r) => s + BigInt(r.requested_amount_kobo), 0n);
  return { day, rows, totalKobo: total.toString(), count: rows.length };
}

export function walletToday(q: Db, initiatorId: string, now: Date) {
  return walletDay(q, initiatorId, lagosDate(now));
}

/** Monthly summary: aggregates the same ledger rows by Lagos day (reconciles exactly with the daily balances). */
export async function walletMonth(q: Db, initiatorId: string, month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Invalid month");
  const days = (
    await q.query<{ day: string; total: string; n: string }>(
      `SELECT to_char(lagos_date, 'YYYY-MM-DD') AS day, sum(requested_amount_kobo)::text AS total, count(*)::text AS n
         FROM request_ledger WHERE initiator_id = $1 AND to_char(lagos_date, 'YYYY-MM') = $2
        GROUP BY lagos_date ORDER BY lagos_date`,
      [initiatorId, month],
    )
  ).rows;
  const total = days.reduce((s, d) => s + BigInt(d.total), 0n);
  const count = days.reduce((s, d) => s + Number(d.n), 0);
  return { month, days: days.map((d) => ({ day: d.day, totalKobo: d.total, count: Number(d.n) })), totalKobo: total.toString(), count };
}

export async function walletMonthsAvailable(q: Db, initiatorId: string): Promise<string[]> {
  return (await q.query<{ m: string }>("SELECT DISTINCT to_char(lagos_date, 'YYYY-MM') AS m FROM request_ledger WHERE initiator_id = $1 ORDER BY m DESC", [initiatorId])).rows.map((r) => r.m);
}
