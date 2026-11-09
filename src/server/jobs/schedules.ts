import type { Tx } from "../db";
import { db, withTx } from "../db";
import { systemCtx } from "../context";
import { audit } from "../audit";
import { formatKobo } from "../money";
import { enqueueEmail } from "../notify/outbox";
import { simpleEmail, caseLink } from "../notify/templates";
import { STAGE_LABELS, type Stage } from "../domain/stages";
import { expandRegions } from "../domain/roles";
import { addDaysToDateString, fromLagos, lagosDate, lagosParts, lagosWeekStart } from "../time";

/** How long after the scheduled instant a missed run is still caught up (worker downtime). */
export const CATCH_UP_MS = 3 * 24 * 3600_000;

export interface WeeklyPeriod {
  key: string;
  start: Date; // Monday 00:00 Africa/Lagos (= Sunday 23:00 UTC)
  end: Date; // next Monday 00:00 Lagos
  startDate: string;
  endDate: string; // Sunday (inclusive)
}

/** The weekly digest fires at "Sunday midnight as Monday begins" in Africa/Lagos. */
export function currentWeeklyPeriod(now: Date): WeeklyPeriod {
  const start = lagosWeekStart(now);
  const startDate = lagosDate(start);
  return { key: `W${startDate}`, start, end: new Date(start.getTime() + 7 * 86400_000), startDate, endDate: addDaysToDateString(startDate, 6) };
}

export interface MonthlyPeriod {
  key: string;
  dueAt: Date;
  start: Date; // first day of prior month 00:00 Lagos
  end: Date; // first day of this month 00:00 Lagos
  label: string;
}
export function currentMonthlyPeriod(now: Date, dayOfMonth: number, hour: number, minute: number): MonthlyPeriod {
  const p = lagosParts(now);
  const dueAt = fromLagos(p.year, p.month, dayOfMonth, hour, minute);
  const py = p.month === 1 ? p.year - 1 : p.year;
  const pm = p.month === 1 ? 12 : p.month - 1;
  return {
    key: `M${py}-${String(pm).padStart(2, "0")}`,
    dueAt,
    start: fromLagos(py, pm, 1),
    end: fromLagos(p.year, p.month, 1),
    label: new Date(Date.UTC(py, pm - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
  };
}

async function claimRun(tx: Tx, code: string, key: string, start: Date, end: Date, now: Date) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`schedule:${code}`]);
  await tx.query(
    `INSERT INTO schedule_runs (code, period_key, period_start, period_end, started_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code, period_key) DO NOTHING`,
    [code, key, start, end, now],
  );
  return (await tx.query("SELECT * FROM schedule_runs WHERE code = $1 AND period_key = $2", [code, key])).rows[0];
}

/**
 * Weekly initiator digest. Idempotent per (period, recipient): reruns, restarts and multiple
 * workers never send a second digest for the same week.
 */
export async function runWeeklyDigest(now = new Date()): Promise<{ ran: boolean; sent: number; period: string }> {
  const settings = (await db.query("SELECT * FROM schedule_settings WHERE code = 'WEEKLY_DIGEST'")).rows[0];
  const period = currentWeeklyPeriod(now);
  if (!settings?.enabled || now < period.start || now.getTime() - period.start.getTime() > CATCH_UP_MS) return { ran: false, sent: 0, period: period.key };
  return withTx(async (tx) => {
    const run = await claimRun(tx, "WEEKLY_DIGEST", period.key, period.start, period.end, now);
    if (run.status === "DONE") return { ran: false, sent: 0, period: period.key };
    const ctx = systemCtx(now);
    const prevStart = new Date(period.start.getTime() - 7 * 86400_000);
    const initiators = (
      await tx.query<{ id: string; email: string; full_name: string }>(
        `SELECT DISTINCT s.id, s.email, s.full_name FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active
          WHERE s.status = 'ACTIVE' AND ra.role IN ('RM','ANM','MERCHANT_OFFICER') ORDER BY s.full_name`,
      )
    ).rows;
    let sent = 0;
    for (const ini of initiators) {
      const disb = (
        await tx.query(
          `SELECT a.id, a.ref, a.customer_name, d.amount_kobo, to_char(d.disbursed_on,'YYYY-MM-DD') AS disbursed_on, d.transaction_ref
             FROM disbursements d JOIN applications a ON a.id = d.application_id
            WHERE a.initiator_id = $1 AND d.recorded_at >= $2 AND d.recorded_at < $3 ORDER BY d.disbursed_on`,
          [ini.id, prevStart, period.start],
        )
      ).rows;
      const due = (
        await tx.query(
          `SELECT a.id, a.ref, a.customer_name, r.seq, to_char(r.due_date,'YYYY-MM-DD') AS due_date, r.amount_kobo
             FROM repayment_instalments r JOIN applications a ON a.id = r.application_id
            WHERE a.initiator_id = $1 AND a.repayment_prompts_active_at IS NOT NULL AND r.due_date BETWEEN $2 AND $3
            ORDER BY r.due_date, a.ref`,
          [ini.id, period.startDate, period.endDate],
        )
      ).rows;
      const summary = { disbursements: disb.length, repaymentsDue: due.length, periodStart: period.startDate, periodEnd: period.endDate };
      const del = await tx.query<{ id: string }>(
        `INSERT INTO digest_deliveries (run_id, code, period_key, recipient_id, summary, created_at) VALUES ($1,'WEEKLY_DIGEST',$2,$3,$4,$5)
         ON CONFLICT (code, period_key, recipient_id) DO NOTHING RETURNING id`,
        [run.id, period.key, ini.id, JSON.stringify(summary), now],
      );
      if (!del.rowCount || (!disb.length && !due.length)) continue;
      const lines = [
        `Hello ${ini.full_name},`,
        "",
        `Your WakeelBoost summary for the week ${period.startDate} to ${period.endDate} (Africa/Lagos).`,
        "",
        `Successful disbursements in the past week: ${disb.length}`,
        ...disb.map((d) => `  - ${d.ref} ${d.customer_name}: ${formatKobo(Number(d.amount_kobo))} on ${d.disbursed_on} (ref ${d.transaction_ref})`),
        "",
        `Repayments due this week (Monday–Sunday): ${due.length}`,
        ...due.map((r) => `  - ${r.due_date} ${r.ref} ${r.customer_name} instalment ${r.seq}: ${formatKobo(Number(r.amount_kobo))} ${caseLink(r.id)}`),
      ];
      const out = await enqueueEmail(tx, now, {
        kind: "WEEKLY_DIGEST",
        dedupeKey: `weekly:${period.key}:${ini.id}`,
        to: [ini.email],
        subject: `WakeelBoost weekly summary: ${period.startDate} – ${period.endDate}`,
        text: simpleEmail(lines),
      });
      await tx.query("UPDATE digest_deliveries SET outbox_id = $2 WHERE id = $1", [del.rows[0].id, out.id]);
      sent++;
    }
    await tx.query("UPDATE schedule_runs SET status = 'DONE', finished_at = $2 WHERE id = $1", [run.id, now]);
    await audit(tx, ctx, { action: "WEEKLY_DIGEST_RUN", details: { period: period.key, recipients: initiators.length, sent } });
    return { ran: true, sent, period: period.key };
  });
}

/** Default monthly recipients when none are configured: Credit Leads, MO Lead, ANM Leads and Unit Head. */
const DEFAULT_MONTHLY_ROLES = ["CREDIT_LEAD_1", "CREDIT_LEAD_2", "MERCHANT_OFFICER_LEAD", "ANM_LEAD_NORTH", "ANM_LEAD_SOUTH", "UNIT_HEAD"];

/** Regions a recipient may see: region-scoped only when every assignment is region-scoped. */
async function recipientRegions(tx: Tx, staffId: string): Promise<string[] | null> {
  const roles = (await tx.query<{ role: string; region: string | null }>("SELECT role, region FROM role_assignments WHERE staff_id = $1 AND active", [staffId])).rows;
  const zones = roles.map((r) => (r.role === "ANM_LEAD_NORTH" ? "NORTH" : r.role === "ANM_LEAD_SOUTH" ? "SOUTH" : null));
  if (roles.length && zones.every((x) => x)) return [...new Set(zones as string[])];
  return null;
}

export async function monthlySummary(tx: Tx, start: Date, end: Date, regions: string[] | null, now: Date) {
  const regionValues = regions ? expandRegions(regions) : null;
  const regionSql = regionValues ? "AND a.region = ANY($3::text[])" : "";
  const params: unknown[] = regionValues ? [start, end, regionValues] : [start, end];
  const one = async (sql: string, extra: unknown[] = []) => (await tx.query(sql, [...params, ...extra])).rows[0];
  const pipeline = await one(
    `SELECT count(*) FILTER (WHERE a.submitted_at >= $1 AND a.submitted_at < $2) AS submitted,
            count(*) FILTER (WHERE a.status = 'IN_PROGRESS') AS in_progress,
            count(*) FILTER (WHERE a.rejected_at >= $1 AND a.rejected_at < $2) AS rejected
       FROM applications a WHERE a.status <> 'DRAFT' ${regionSql}`,
  );
  const booked = await one(
    `SELECT count(*) AS n, coalesce(sum(d.amount_kobo),0) AS total FROM disbursements d JOIN applications a ON a.id = d.application_id
      WHERE d.recorded_at >= $1 AND d.recorded_at < $2 ${regionSql}`,
  );
  const corrections = await one(
    `SELECT count(*) AS n FROM corrections c JOIN applications a ON a.id = c.application_id WHERE c.created_at >= $1 AND c.created_at < $2 ${regionSql}`,
  );
  const turnaround = (
    await tx.query(
      `SELECT t.stage, count(*) AS n, round(avg(extract(epoch FROM (t.completed_at - t.entered_at))/3600)::numeric,1) AS avg_hours
         FROM tasks t JOIN applications a ON a.id = t.application_id
        WHERE t.completed_at >= $1 AND t.completed_at < $2 ${regionSql} GROUP BY t.stage ORDER BY t.stage`,
      params,
    )
  ).rows;
  const today = lagosDate(now);
  const upcoming = (
    await tx.query(
      `SELECT count(*) AS n, coalesce(sum(r.amount_kobo),0) AS total FROM repayment_instalments r JOIN applications a ON a.id = r.application_id
        WHERE r.due_date BETWEEN $1 AND $2 ${regionSql}`,
      regions ? [today, addDaysToDateString(today, 30), regions] : [today, addDaysToDateString(today, 30)],
    )
  ).rows[0];
  return { pipeline, booked, corrections, turnaround, upcoming };
}

export async function runMonthlyReport(now = new Date()): Promise<{ ran: boolean; sent: number; period: string }> {
  const s = (await db.query("SELECT * FROM schedule_settings WHERE code = 'MONTHLY_REPORT'")).rows[0];
  const period = currentMonthlyPeriod(now, s?.day_of_month ?? 1, s?.hour ?? 8, s?.minute ?? 0);
  if (!s?.enabled || now < period.dueAt || now.getTime() - period.dueAt.getTime() > CATCH_UP_MS) return { ran: false, sent: 0, period: period.key };
  return withTx(async (tx) => {
    const run = await claimRun(tx, "MONTHLY_REPORT", period.key, period.start, period.end, now);
    if (run.status === "DONE") return { ran: false, sent: 0, period: period.key };
    const ctx = systemCtx(now);
    const recipients = (
      s.recipient_staff_ids?.length
        ? await tx.query<{ id: string; email: string; full_name: string }>("SELECT id, email, full_name FROM staff WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'", [s.recipient_staff_ids])
        : await tx.query<{ id: string; email: string; full_name: string }>(
            `SELECT DISTINCT s.id, s.email, s.full_name FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active
              WHERE s.status = 'ACTIVE' AND ra.role = ANY($1::text[])`,
            [DEFAULT_MONTHLY_ROLES],
          )
    ).rows;
    let sent = 0;
    for (const r of recipients) {
      const regions = await recipientRegions(tx, r.id);
      const sum = await monthlySummary(tx, period.start, period.end, regions, now);
      const del = await tx.query<{ id: string }>(
        `INSERT INTO digest_deliveries (run_id, code, period_key, recipient_id, summary, created_at) VALUES ($1,'MONTHLY_REPORT',$2,$3,$4,$5)
         ON CONFLICT (code, period_key, recipient_id) DO NOTHING RETURNING id`,
        [run.id, period.key, r.id, JSON.stringify({ ...sum, regions }), now],
      );
      if (!del.rowCount) continue;
      const lines = [
        `Hello ${r.full_name},`,
        "",
        `WakeelBoost monthly summary for ${period.label}${regions ? ` (scope: ${regions.join(", ")})` : " (bank-wide)"}.`,
        "",
        "Pipeline",
        `  Submitted in month: ${sum.pipeline.submitted}`,
        `  Currently in progress: ${sum.pipeline.in_progress}`,
        `  Rejected in month: ${sum.pipeline.rejected}`,
        `  Corrections requested in month: ${sum.corrections.n}`,
        "",
        `Booked in month: ${sum.booked.n} disbursement(s), ${formatKobo(Number(sum.booked.total))}`,
        "",
        "Turnaround by stage (average hours, tasks completed in month)",
        ...sum.turnaround.map((t: { stage: Stage; n: string; avg_hours: string }) => `  ${STAGE_LABELS[t.stage] ?? t.stage}: ${t.avg_hours}h over ${t.n} task(s)`),
        "",
        `Upcoming repayments (next 30 days): ${sum.upcoming.n}, ${formatKobo(Number(sum.upcoming.total))}`,
      ];
      const out = await enqueueEmail(tx, now, {
        kind: "MONTHLY_REPORT",
        dedupeKey: `monthly:${period.key}:${r.id}`,
        to: [r.email],
        subject: `WakeelBoost monthly summary: ${period.label}`,
        text: simpleEmail(lines),
      });
      await tx.query("UPDATE digest_deliveries SET outbox_id = $2 WHERE id = $1", [del.rows[0].id, out.id]);
      sent++;
    }
    await tx.query("UPDATE schedule_runs SET status = 'DONE', finished_at = $2 WHERE id = $1", [run.id, now]);
    await audit(tx, ctx, { action: "MONTHLY_REPORT_RUN", details: { period: period.key, recipients: recipients.length, sent } });
    return { ran: true, sent, period: period.key };
  });
}
