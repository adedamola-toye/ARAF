/**
 * SLA reminders: when an assigned officer has not acted on a request within the configured time (three continuous
 * hours by default), ARAF emails them a reminder. Runs on the background worker (never depends on a browser).
 *
 *  - The clock starts when the request enters the officer's actionable queue (assignment time). Opening a request or
 *    viewing documents does not stop it; only a saved workflow action does (the item then leaves the queue).
 *  - A new assignment (reassignment, return, next stage) starts a new clock; earlier reminders stay in the history.
 *  - One reminder per assignment and threshold (database-unique and outbox-deduplicated), with outbox retries and
 *    delivery status. Completed, cancelled and declined items are never reminded.
 *  - Queues: retail and WakeelBoost approval tasks, Staff Salary Advance stages, Altphones reviews, invoice confirmation.
 *    Where a queue is held by a role pool rather than one person (e.g. Product Manager queues), every active holder
 *    of that role is reminded.
 */
import type { Db } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { systemCtx } from "../context";
import { audit } from "../audit";
import { forbidden, invalid } from "../errors";
import { holdsRole } from "./access";
import { enqueueEmail } from "../notify/outbox";
import { config } from "../config";
import { REQUIRED_ACTION, STAGE_LABELS, type Stage } from "./stages";
import { STAFF_STATUS_LABELS } from "@/lib/staff-financing";
import { formatLagos, lagosDate } from "../time";

export const QUEUES = {
  RETAIL_TASK: "Retail and WakeelBoost approvals",
  STAFF_REQUEST: "Staff Salary Advance",
  ALTPHONES: "Altphones reviews",
  INVOICE_CONFIRMATION: "Invoice confirmation",
} as const;
export type Queue = keyof typeof QUEUES;

export interface SlaPolicy {
  reminder_hours: string;
  repeat_hours: string | null;
  hour_mode: "CALENDAR" | "WORKING";
  working_start: number;
  working_end: number;
  working_days: number[];
  holidays: string[];
  excluded_queues: string[];
  cc_emails: string[];
  subject_template: string;
  body_template: string;
  enabled: boolean;
  updated_at: Date;
}

export async function slaPolicy(q: Db): Promise<SlaPolicy> {
  const r = (await q.query("SELECT *, to_json(holidays) AS holidays FROM sla_policy WHERE id = 1")).rows[0];
  return { ...r, holidays: (r.holidays ?? []).map(String) };
}

const LAGOS_OFFSET_MS = 60 * 60 * 1000;

/** The moment `hours` of SLA time have elapsed after `from` (continuous, or counting only working hours in Lagos). */
export function slaDeadline(from: Date, hours: number, p: Pick<SlaPolicy, "hour_mode" | "working_start" | "working_end" | "working_days" | "holidays">): Date {
  if (p.hour_mode !== "WORKING") return new Date(from.getTime() + hours * 3600_000);
  let remaining = hours * 3600_000;
  let t = from.getTime();
  for (let guard = 0; guard < 24 * 400 && remaining > 0; guard++) {
    const local = new Date(t + LAGOS_OFFSET_MS);
    const day = local.getUTCDay() === 0 ? 7 : local.getUTCDay();
    const date = local.toISOString().slice(0, 10);
    const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - LAGOS_OFFSET_MS;
    const open = dayStart + p.working_start * 3600_000;
    const close = dayStart + p.working_end * 3600_000;
    if (!p.working_days.includes(day) || p.holidays.includes(date) || t >= close) {
      t = dayStart + 24 * 3600_000 + p.working_start * 3600_000;
      continue;
    }
    if (t < open) t = open;
    const slice = Math.min(remaining, close - t);
    t += slice;
    remaining -= slice;
    if (remaining > 0) t = dayStart + 24 * 3600_000 + p.working_start * 3600_000;
  }
  return new Date(t);
}

export interface PendingItem {
  queue: Queue;
  key: string;
  assignedAt: Date;
  officers: { id: string; email: string; name: string }[];
  reference: string;
  customer: string;
  product: string;
  action: string;
  link: string;
  applicationId: string | null;
}

/** Everything currently waiting on an officer, with when it reached them. */
export async function pendingItems(q: Db): Promise<PendingItem[]> {
  const out: PendingItem[] = [];
  const holders = async (role: string) =>
    (await q.query<{ id: string; email: string; name: string }>("SELECT DISTINCT s.id, s.email, s.full_name AS name FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.role = $1 AND ra.active AND s.status = 'ACTIVE'", [role])).rows;
  const person = async (id: string | null) => (id ? (await q.query<{ id: string; email: string; name: string }>("SELECT id, email, full_name AS name FROM staff WHERE id = $1 AND status = 'ACTIVE'", [id])).rows : []);

  // Retail and WakeelBoost approval tasks (one assigned officer each).
  for (const t of (
    await q.query<{ id: string; stage: Stage; assigned_at: Date; staff_id: string; email: string; name: string; ref: string; customer_name: string | null; product_label: string | null; application_id: string }>(
      `SELECT t.id, t.stage, t.assigned_at, s.id AS staff_id, s.email, s.full_name AS name, a.ref, a.customer_name, a.product_label, a.id AS application_id
         FROM tasks t JOIN applications a ON a.id = t.application_id JOIN staff s ON s.id = t.assignee_id
        WHERE t.status = 'OPEN' AND t.assigned_at IS NOT NULL AND a.suspended_at IS NULL AND s.status = 'ACTIVE'`,
    )
  ).rows) {
    out.push({ queue: "RETAIL_TASK", key: t.id, assignedAt: t.assigned_at, officers: [{ id: t.staff_id, email: t.email, name: t.name }], reference: t.ref, customer: t.customer_name ?? "—", product: t.product_label ?? "—", action: REQUIRED_ACTION[t.stage] ?? STAGE_LABELS[t.stage], link: `${config.appUrl}/requests/${t.application_id}?task=${t.id}`, applicationId: t.application_id });
  }

  // Staff Salary Advance: the stage's owner; the clock starts when the request entered its current status.
  for (const r of (
    await q.query<{ id: string; ref: string; status: string; pm_reviewer_id: string | null; unit_head_id: string | null; divisional_head_id: string | null; disbursement_officer_id: string | null; applicant_name: string; entered_at: Date }>(
      `SELECT r.id, r.ref, r.status, r.pm_reviewer_id, r.unit_head_id, r.divisional_head_id, r.disbursement_officer_id, s.full_name AS applicant_name,
              coalesce((SELECT max(e.occurred_at) FROM staff_request_events e WHERE e.request_id = r.id AND e.to_status = r.status), r.updated_at) AS entered_at
         FROM staff_requests r JOIN staff s ON s.id = r.applicant_id
        WHERE r.status IN ('SUBMITTED','UNDER_PM_REVIEW','UNDER_UNIT_HEAD_REVIEW','UNDER_DIVISIONAL_HEAD_REVIEW','ASSIGNED_FOR_DISBURSEMENT','DISBURSEMENT_IN_PROGRESS')`,
    )
  ).rows) {
    const officers =
      r.status === "SUBMITTED" ? await holders("PRODUCT_MANAGER")
      : r.status === "UNDER_PM_REVIEW" ? await person(r.pm_reviewer_id)
      : r.status === "UNDER_UNIT_HEAD_REVIEW" ? (r.unit_head_id ? await person(r.unit_head_id) : await holders("UNIT_HEAD"))
      : r.status === "UNDER_DIVISIONAL_HEAD_REVIEW" ? (r.divisional_head_id ? await person(r.divisional_head_id) : await holders("DIVISIONAL_HEAD"))
      : await person(r.disbursement_officer_id);
    if (!officers.length) continue;
    out.push({ queue: "STAFF_REQUEST", key: `${r.id}:${r.status}`, assignedAt: r.entered_at, officers, reference: r.ref, customer: r.applicant_name, product: "Staff Salary Advance", action: STAFF_STATUS_LABELS[r.status as keyof typeof STAFF_STATUS_LABELS] ?? r.status, link: `${config.appUrl}/staff-request/${r.id}`, applicationId: null });
  }

  // Altphones reviews (BPM: the routed person; Product Manager and Unit Head: role pools).
  for (const a of (
    await q.query<{ id: string; ref: string; status: string; routed_bpm_id: string | null; customer_name: string | null; entered_at: Date }>(
      `SELECT a.id, a.ref, a.status, a.routed_bpm_id, a.customer_name,
              coalesce((SELECT max(e.occurred_at) FROM altphones_events e WHERE e.application_id = a.id AND e.to_status = a.status), a.submitted_at, a.updated_at) AS entered_at
         FROM altphones_applications a WHERE a.status IN ('UNDER_BPM_REVIEW','UNDER_PM_REVIEW','UNDER_UNIT_HEAD_REVIEW')`,
    )
  ).rows) {
    const officers = a.status === "UNDER_BPM_REVIEW" ? await person(a.routed_bpm_id) : await holders(a.status === "UNDER_PM_REVIEW" ? "ALTPHONES_PRODUCT_MANAGER" : "UNIT_HEAD");
    if (!officers.length) continue;
    const action = a.status === "UNDER_BPM_REVIEW" ? "Business Performance Manager review" : a.status === "UNDER_PM_REVIEW" ? "Product Manager review" : "Unit Head approval";
    out.push({ queue: "ALTPHONES", key: `${a.id}:${a.status}`, assignedAt: a.entered_at, officers, reference: a.ref, customer: a.customer_name ?? "—", product: "Altphones", action, link: `${config.appUrl}/altphones/applications/${a.id}`, applicationId: null });
  }

  // Invoice confirmation (the assigned Invoice Confirmation Officer).
  for (const c of (
    await q.query<{ id: string; assigned_at: Date; officer_id: string; email: string; name: string; ref: string; customer_name: string | null; product_label: string | null; application_id: string }>(
      `SELECT c.id, c.assigned_at, s.id AS officer_id, s.email, s.full_name AS name, a.ref, a.customer_name, a.product_label, a.id AS application_id
         FROM invoice_confirmations c JOIN applications a ON a.id = c.application_id JOIN staff s ON s.id = c.officer_id
        WHERE c.status = 'PENDING' AND c.assigned_at IS NOT NULL AND s.status = 'ACTIVE'`,
    )
  ).rows) {
    out.push({ queue: "INVOICE_CONFIRMATION", key: c.id, assignedAt: c.assigned_at, officers: [{ id: c.officer_id, email: c.email, name: c.name }], reference: c.ref, customer: c.customer_name ?? "—", product: c.product_label ?? "—", action: "Confirm the supplier invoice", link: `${config.appUrl}/invoice-confirmation/${c.id}`, applicationId: c.application_id });
  }
  return out;
}

export function fillTemplate(tpl: string, v: Record<string, string>) {
  return tpl.replace(/\[([A-Za-z ]+)\]/g, (m, k: string) => (k in v ? v[k] : m));
}

/** Worker: send due reminders (idempotent). Returns the number of reminders sent. */
export async function runSlaReminders(now: Date): Promise<number> {
  const p = await slaPolicy(db);
  if (!p.enabled) return 0;
  const hours = Number(p.reminder_hours);
  const repeat = p.repeat_hours === null ? null : Number(p.repeat_hours);
  let sent = 0;
  for (const it of await pendingItems(db)) {
    if (p.excluded_queues.includes(it.queue)) continue;
    const first = slaDeadline(it.assignedAt, hours, p);
    if (now < first) continue;
    // Threshold 1 at the SLA, then (when configured) one more each repeat interval.
    let threshold = 1;
    let due = first;
    if (repeat) {
      while (true) {
        const next = slaDeadline(due, repeat, p);
        if (next > now) break;
        due = next;
        threshold++;
        if (threshold > 50) break;
      }
    }
    const done = await db.query("SELECT 1 FROM sla_reminders WHERE queue = $1 AND task_key = $2 AND assigned_at = $3 AND threshold_no = $4", [it.queue, it.key, it.assignedAt, threshold]);
    if (done.rowCount) continue;
    for (const o of it.officers) {
      const values = { "Officer Name": o.name, "Customer Name": it.customer, Reference: it.reference, "Facility Reference": it.reference, Product: it.product, Action: it.action, "Date and Time": formatLagos(it.assignedAt), "Secure Link to Request": it.link };
      await withTx(async (tx) => {
        const ins = await tx.query<{ id: string }>(
          `INSERT INTO sla_reminders (queue, task_key, assigned_at, threshold_no, officer_id, reference, due_at, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (queue, task_key, assigned_at, threshold_no) DO NOTHING RETURNING id`,
          [it.queue, `${it.key}${it.officers.length > 1 ? `#${o.id}` : ""}`, it.assignedAt, threshold, o.id, it.reference, due, now],
        );
        if (!ins.rowCount) return;
        const out = await enqueueEmail(tx, now, {
          kind: "SLA_REMINDER",
          dedupeKey: `sla-reminder:${it.queue}:${it.key}:${o.id}:${it.assignedAt.getTime()}:${threshold}`,
          applicationId: it.applicationId,
          to: [o.email],
          cc: p.cc_emails,
          subject: fillTemplate(p.subject_template, values),
          text: fillTemplate(p.body_template, values),
        });
        await tx.query("UPDATE sla_reminders SET outbox_id = $2 WHERE id = $1", [ins.rows[0].id, out.id]);
        await audit(tx, systemCtx(now), { action: "SLA_REMINDER_SENT", applicationId: it.applicationId, details: { queue: it.queue, taskKey: it.key, officerId: o.id, reference: it.reference, assignedAt: it.assignedAt.toISOString(), dueAt: due.toISOString(), threshold } });
        sent++;
      });
    }
    // Pool queues record one row per officer; mark the item itself as reminded for this threshold.
    if (it.officers.length > 1) await db.query("INSERT INTO sla_reminders (queue, task_key, assigned_at, threshold_no, officer_id, reference, due_at, sent_at) VALUES ($1,$2,$3,$4,NULL,$5,$6,$7) ON CONFLICT DO NOTHING", [it.queue, it.key, it.assignedAt, threshold, it.reference, due, now]);
  }
  return sent;
}

/** Elapsed time and SLA status for a queue row. */
export function slaStatus(assignedAt: Date | null, now: Date, p: Pick<SlaPolicy, "reminder_hours" | "hour_mode" | "working_start" | "working_end" | "working_days" | "holidays">) {
  if (!assignedAt) return null;
  const due = slaDeadline(new Date(assignedAt), Number(p.reminder_hours), p);
  const ms = now.getTime() - new Date(assignedAt).getTime();
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return { elapsed: h ? `${h}h ${m}m` : `${m}m`, overdue: now >= due, due };
}

export interface SlaPolicyInput {
  reminderHours: number;
  repeatHours: number | null;
  hourMode: "CALENDAR" | "WORKING";
  workingStart: number;
  workingEnd: number;
  workingDays: number[];
  holidays: string[];
  excludedQueues: string[];
  ccEmails: string[];
  subjectTemplate: string;
  bodyTemplate: string;
  enabled: boolean;
  reason: string;
}

/** Super Admin: change the SLA policy (direct, with a reason; audited with the previous and new values). */
export async function saveSlaPolicy(ctx: Ctx, p: SlaPolicyInput) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const e: Record<string, string> = {};
  if (!(p.reminderHours > 0 && p.reminderHours <= 168)) e.reminderHours = "Between 0 and 168 hours.";
  if (p.repeatHours !== null && !(p.repeatHours > 0 && p.repeatHours <= 168)) e.repeatHours = "Between 0 and 168 hours, or leave empty.";
  if (!(p.workingStart >= 0 && p.workingStart < p.workingEnd && p.workingEnd <= 24)) e.workingEnd = "Working hours must end after they start.";
  if (!p.workingDays.length || p.workingDays.some((d) => d < 1 || d > 7)) e.workingDays = "Choose at least one working day.";
  if (p.holidays.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) e.holidays = "Holidays as YYYY-MM-DD, one per line.";
  if (p.excludedQueues.some((x) => !(x in QUEUES))) e.excludedQueues = "Unknown queue.";
  if (p.ccEmails.some((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) e.ccEmails = "Enter valid email addresses.";
  if (p.subjectTemplate.trim().length < 5) e.subjectTemplate = "Enter the subject.";
  if (p.bodyTemplate.trim().length < 20) e.bodyTemplate = "Enter the email body.";
  if (p.reason.trim().length < 20) e.reason = "Explain the change (at least 20 characters).";
  if (Object.keys(e).length) throw invalid("Check the highlighted settings.", e);
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can change SLA reminders.");
    const before = await slaPolicy(tx);
    await tx.query(
      `UPDATE sla_policy SET reminder_hours = $1, repeat_hours = $2, hour_mode = $3, working_start = $4, working_end = $5, working_days = $6, holidays = $7::date[],
          excluded_queues = $8, cc_emails = $9, subject_template = $10, body_template = $11, enabled = $12, updated_by = $13, updated_at = $14 WHERE id = 1`,
      [p.reminderHours, p.repeatHours, p.hourMode, p.workingStart, p.workingEnd, p.workingDays, p.holidays, p.excludedQueues, p.ccEmails, p.subjectTemplate.trim(), p.bodyTemplate.trim(), p.enabled, actor.staffId, ctx.now],
    );
    await audit(tx, ctx, { action: "SLA_POLICY_CHANGED", actorRole: "SUPER_ADMIN", reason: p.reason.trim(), details: { previous: before, next: p } });
  });
}

export async function recentReminders(q: Db, limit = 50) {
  return (
    await q.query<{ queue: string; reference: string; officer: string | null; due_at: Date; sent_at: Date; status: string | null; threshold_no: number }>(
      `SELECT r.queue, r.reference, s.full_name AS officer, r.due_at, r.sent_at, o.status, r.threshold_no FROM sla_reminders r
         LEFT JOIN staff s ON s.id = r.officer_id LEFT JOIN notification_outbox o ON o.id = r.outbox_id
        WHERE r.officer_id IS NOT NULL ORDER BY r.sent_at DESC LIMIT $1`,
      [limit],
    )
  ).rows;
}

export const todayLagos = (now: Date) => lagosDate(now);
