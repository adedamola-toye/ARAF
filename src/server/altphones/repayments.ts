/**
 * Altphones repayment lifecycle for credit facilities sold through ARAF (status DISBURSED, not legacy imports).
 *
 *  - Repayments are recorded one at a time (Product Manager, Collections Officer, Super Admin) or by the
 *    Unit Head-approved repayments CSV. Each carries a payment reference as evidence; references are unique per
 *    facility and overpayments are refused.
 *  - The ledger is append-only. A mistake is corrected by a reversal (Unit Head or Super Admin, a different
 *    person from whoever recorded it, with a reason).
 *  - The facility's status, amount repaid and completion are recomputed in the same transaction. When the
 *    repayments cover the total repayable the facility is fully repaid: the customer is emailed and the Product
 *    Manager notified.
 */
import type { Db, Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { DomainError, conflict, forbidden, invalid, notFound } from "../errors";
import { formatNaira } from "@/lib/altphones";
import { facilityPosition, type FacilityPosition, type ScheduleRow } from "@/lib/altphones-repayments";
import { lagosDate } from "../time";
import { parseNairaToKobo } from "../money";
import { activeRoles, auditDenied, emailCustomer, isUuid, lockApp, notifyRole, PM_ROLE, recordEvent, settingsById, type AltApp } from "./core";

export const RECORD_ROLES = [PM_ROLE, "COLLECTIONS_OFFICER", "SUPER_ADMIN"] as const;
export const REVERSE_ROLES = ["UNIT_HEAD", "SUPER_ADMIN"] as const;

export interface RepaymentRow {
  id: string;
  kind: "PAYMENT" | "REVERSAL";
  paid_on: string;
  amount_kobo: string;
  reference: string;
  note: string | null;
  reverses_id: string | null;
  source: "MANUAL" | "CSV";
  recorded_by: string;
  recorded_by_name: string | null;
  recorded_role: string | null;
  recorded_at: Date;
  reversed: boolean;
}

export const isFacility = (app: AltApp) => app.kind === "CREDIT" && app.status === "DISBURSED" && !app.legacy;

export async function repaymentAccess(q: Db, staffId: string) {
  const roles = await activeRoles(q, staffId);
  return {
    record: RECORD_ROLES.some((r) => roles.has(r)),
    reverse: REVERSE_ROLES.some((r) => roles.has(r)),
    roles,
  };
}

export async function scheduleOf(q: Db, appId: string): Promise<ScheduleRow[]> {
  return (
    await q.query<{ seq: number; due_date: string; amount_kobo: string }>("SELECT seq, to_char(due_date, 'YYYY-MM-DD') AS due_date, amount_kobo FROM altphones_schedule WHERE application_id = $1 ORDER BY seq", [appId])
  ).rows.map((r) => ({ seq: r.seq, dueDate: r.due_date, amountKobo: Number(r.amount_kobo) }));
}

async function repaidOf(q: Db, appId: string): Promise<number> {
  return Number((await q.query<{ s: string }>("SELECT coalesce(sum(amount_kobo),0)::text AS s FROM altphones_repayments WHERE application_id = $1", [appId])).rows[0].s);
}

export async function positionOf(q: Db, appId: string, today: string): Promise<FacilityPosition> {
  return facilityPosition(await scheduleOf(q, appId), await repaidOf(q, appId), today);
}

export async function repaymentsOf(q: Db, appId: string): Promise<RepaymentRow[]> {
  return (
    await q.query<RepaymentRow>(
      `SELECT r.*, to_char(r.paid_on, 'YYYY-MM-DD') AS paid_on, s.full_name AS recorded_by_name,
              EXISTS (SELECT 1 FROM altphones_repayments x WHERE x.reverses_id = r.id) AS reversed
         FROM altphones_repayments r LEFT JOIN staff s ON s.id = r.recorded_by
        WHERE r.application_id = $1 ORDER BY r.paid_on, r.recorded_at`,
      [appId],
    )
  ).rows;
}

/**
 * Recompute the facility after a repayment or reversal (same transaction). Completion side effects run once,
 * when the facility first becomes fully repaid; a reversal that re-opens it is recorded too.
 */
export async function applyPosition(tx: Tx, ctx: Ctx, app: AltApp): Promise<FacilityPosition> {
  const pos = await positionOf(tx, app.id, lagosDate(ctx.now));
  const wasRepaid = !!app.fully_repaid_at;
  const nowRepaid = pos.status === "FULLY_REPAID";
  await tx.query("UPDATE altphones_applications SET repayment_status = $2, amount_repaid_kobo = $3, fully_repaid_at = $4, updated_at = $5 WHERE id = $1", [
    app.id,
    pos.status,
    pos.repaidKobo,
    nowRepaid ? (app.fully_repaid_at ?? ctx.now) : null,
    ctx.now,
  ]);
  if (nowRepaid && !wasRepaid) {
    await recordEvent(tx, ctx, app, { action: "FULLY_REPAID", details: { totalKobo: pos.totalKobo, repaidKobo: pos.repaidKobo } });
    const s = await settingsById(tx, app.settings_id);
    await emailCustomer(tx, ctx, app, "FULLY_REPAID", "Your Altphones facility is fully repaid", [
      `Thank you. We have received ${formatNaira(pos.repaidKobo)}, the full amount repayable on your ${app.model_name ?? "phone"} facility.`,
      "Your facility is now closed. Keep this email as your confirmation.",
      `Reference: ${app.ref}`,
    ], s.team_email);
    await notifyRole(tx, ctx, app, "FULLY_REPAID", [PM_ROLE], "Altphones facility fully repaid", [`${app.ref} is fully repaid (${formatNaira(pos.repaidKobo)}).`]);
  } else if (!nowRepaid && wasRepaid) {
    await recordEvent(tx, ctx, app, { action: "REOPENED", details: { outstandingKobo: pos.outstandingKobo }, comments: "A reversal re-opened the facility." });
  }
  return pos;
}

export interface RecordInput {
  paidOn: string;
  amount: string;
  reference: string;
  note?: string;
}

/** Validation shared by single entries and the repayments CSV. Returns the amount in kobo. */
export function checkRepayment(app: AltApp, pos: FacilityPosition, p: { paidOn: string | null; amountKobo: number | null; reference: string }, today: string): Record<string, string> {
  const e: Record<string, string> = {};
  if (!isFacility(app)) e.application = "Repayments can be recorded only on an Altphones credit facility after handover.";
  if (!p.paidOn || !/^\d{4}-\d{2}-\d{2}$/.test(p.paidOn)) e.paidOn = "Enter the payment date (YYYY-MM-DD).";
  else if (p.paidOn > today) e.paidOn = "The payment date cannot be in the future.";
  else if (app.handed_over_at && p.paidOn < lagosDate(new Date(app.handed_over_at))) e.paidOn = "The payment date is before the phone was handed over.";
  if (p.amountKobo === null || p.amountKobo <= 0) e.amount = "Enter the amount received (e.g. 9725.00).";
  else if (p.amountKobo > pos.outstandingKobo) e.amount = pos.outstandingKobo === 0 ? "This facility is already fully repaid." : `This is more than the outstanding balance (${formatNaira(pos.outstandingKobo)}). Record overpayments as an exception, not here.`;
  if ((p.reference ?? "").trim().length < 3) e.reference = "Enter the payment reference from the bank statement or receipt (evidence).";
  return e;
}

export async function recordRepayment(ctx: Ctx, appId: string, p: RecordInput) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!isUuid(appId)) throw notFound("Facility not found.");
  try {
    return await withTx(async (tx) => {
      const access = await repaymentAccess(tx, actor.staffId);
      if (!access.record) throw forbidden("Only the Altphones Product Manager, Collections Officers and Super Admins record repayments.");
      const app = await lockApp(tx, appId);
      const today = lagosDate(ctx.now);
      const pos = await positionOf(tx, app.id, today);
      const amountKobo = parseNairaToKobo(p.amount);
      const reference = (p.reference ?? "").trim();
      const e = checkRepayment(app, pos, { paidOn: p.paidOn, amountKobo, reference }, today);
      if (!e.reference && (await tx.query("SELECT 1 FROM altphones_repayments WHERE application_id = $1 AND upper(reference) = upper($2)", [app.id, reference])).rowCount) e.reference = "This payment reference is already recorded on this facility.";
      if (Object.keys(e).length) throw invalid(e.application ?? "Check the repayment details.", e);
      const role = RECORD_ROLES.find((r) => access.roles.has(r))!;
      const id = (
        await tx.query<{ id: string }>(
          `INSERT INTO altphones_repayments (application_id, kind, paid_on, amount_kobo, reference, note, source, recorded_by, recorded_role, recorded_at)
           VALUES ($1,'PAYMENT',$2,$3,$4,$5,'MANUAL',$6,$7,$8) RETURNING id`,
          [app.id, p.paidOn, amountKobo, reference, (p.note ?? "").trim() || null, actor.staffId, role, ctx.now],
        )
      ).rows[0].id;
      await recordEvent(tx, ctx, app, { action: "REPAYMENT_RECORDED", role, details: { repaymentId: id, paidOn: p.paidOn, amountKobo, reference, source: "MANUAL" } });
      const after = await applyPosition(tx, ctx, app);
      return { id, position: after };
    });
  } catch (err) {
    if (err instanceof DomainError && err.code === "FORBIDDEN") await auditDenied(ctx, appId, "REPAYMENT_RECORD", err.message);
    throw err;
  }
}

export async function reverseRepayment(ctx: Ctx, repaymentId: string, reason: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!isUuid(repaymentId)) throw notFound("Repayment not found.");
  let appId: string | null = null;
  try {
    return await withTx(async (tx) => {
      const access = await repaymentAccess(tx, actor.staffId);
      if (!access.reverse) throw forbidden("Only a Unit Head or Super Admin can reverse a repayment.");
      const r = (await tx.query<{ id: string; application_id: string; kind: string; amount_kobo: string; reference: string; recorded_by: string }>("SELECT * FROM altphones_repayments WHERE id = $1", [repaymentId])).rows[0];
      if (!r) throw notFound("Repayment not found.");
      appId = r.application_id;
      if (r.kind !== "PAYMENT") throw invalid("Only a payment can be reversed.");
      if (r.recorded_by === actor.staffId) throw forbidden("A repayment must be reversed by someone other than the person who recorded it.");
      const why = (reason ?? "").trim();
      if (why.length < 10) throw invalid("Explain why this repayment is being reversed (at least 10 characters).", { reason: "Enter the reason for the reversal." });
      const app = await lockApp(tx, r.application_id);
      if ((await tx.query("SELECT 1 FROM altphones_repayments WHERE reverses_id = $1", [r.id])).rowCount) throw conflict("This repayment has already been reversed.");
      const role = REVERSE_ROLES.find((x) => access.roles.has(x))!;
      await tx.query(
        `INSERT INTO altphones_repayments (application_id, kind, paid_on, amount_kobo, reference, note, reverses_id, source, recorded_by, recorded_role, recorded_at)
         VALUES ($1,'REVERSAL',$2,$3,$4,$5,$6,'MANUAL',$7,$8,$9)`,
        [app.id, lagosDate(ctx.now), -Number(r.amount_kobo), `REV-${r.reference}`.slice(0, 120), why, r.id, actor.staffId, role, ctx.now],
      );
      await recordEvent(tx, ctx, app, { action: "REPAYMENT_REVERSED", role, comments: why, details: { repaymentId: r.id, amountKobo: Number(r.amount_kobo), reference: r.reference } });
      return { position: await applyPosition(tx, ctx, app) };
    });
  } catch (err) {
    if (err instanceof DomainError && err.code === "FORBIDDEN") await auditDenied(ctx, appId, "REPAYMENT_REVERSE", err.message);
    throw err;
  }
}

// ------------------------------------------------------------------ duplicate customers

export interface DuplicateWarning {
  source: "ARAF" | "HISTORICAL";
  ref: string;
  status: string;
  outstandingKobo: number | null;
}

/**
 * Other facilities for the same customer (by BVN): ARAF credit sales in progress or not yet fully repaid, and
 * verified historical accounts that are not completed or cancelled. A warning for the originator and reviewers;
 * it does not block the sale.
 */
export async function otherFacilities(q: Db, bvnHash: string, excludeAppId: string): Promise<DuplicateWarning[]> {
  const live = await q.query<{ ref: string; status: string; repayment_status: string | null; total: string | null; repaid: string }>(
    `SELECT ref, status, repayment_status, total_repayment_kobo::text AS total, amount_repaid_kobo::text AS repaid FROM altphones_applications
      WHERE bvn_hash = $1 AND id <> $2 AND kind = 'CREDIT' AND NOT legacy
        AND status NOT IN ('DRAFT','CREDIT_DECLINED','REJECTED','CANCELLED')
        AND coalesce(repayment_status, '') <> 'FULLY_REPAID'
      ORDER BY created_at`,
    [bvnHash, excludeAppId],
  );
  const hist = await q.query<{ ref: string; status: string; outstanding_kobo: string | null }>(
    "SELECT ref, status, outstanding_kobo::text AS outstanding_kobo FROM altphones_historical_accounts WHERE bvn_hash = $1 AND status NOT IN ('COMPLETED','CANCELLED') ORDER BY ref",
    [bvnHash],
  );
  return [
    ...live.rows.map((r) => ({ source: "ARAF" as const, ref: r.ref, status: r.status === "DISBURSED" ? (r.repayment_status ?? "NOT_STARTED") : r.status, outstandingKobo: r.total !== null ? Number(r.total) - Number(r.repaid) : null })),
    ...hist.rows.map((r) => ({ source: "HISTORICAL" as const, ref: r.ref, status: r.status, outstandingKobo: r.outstanding_kobo !== null ? Number(r.outstanding_kobo) : null })),
  ];
}
