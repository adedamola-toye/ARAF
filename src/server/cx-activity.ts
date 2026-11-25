/**
 * CX credit reviewer activity, for the credit leads and the CX Group Head.
 *
 * Every figure comes from the immutable decision record written when a reviewer acts: the reviewer, the
 * action (recommend, return or decline), the reason, the time and the request. Nothing is estimated or
 * invented. The report never grants an approval: it is a read-only view of what CX reviewers did.
 */
import type { Db } from "./db";
import { forbidden } from "./errors";
import { holdsRole } from "./domain/access";
import type { Role } from "./domain/roles";
import { addDaysToDateString, fromLagos, lagosDate } from "./time";

/** Credit leadership, the Merchant Officer Head and the retail CX Group Head (plus the Super Admin) may read the activity report. */
export const CX_ACTIVITY_ROLES: readonly Role[] = ["CREDIT_LEAD_1", "CREDIT_LEAD_2", "MERCHANT_OFFICER_HEAD", "CX_GROUP_HEAD", "SUPER_ADMIN"];

/** Actions a CX credit reviewer can take on a request. */
export const CX_ACTIONS = ["RECOMMEND", "APPROVE", "RETURN", "REJECT", "REQUEST_INITIATOR"] as const;
export type CxAction = (typeof CX_ACTIONS)[number];

const POSITIVE = ["RECOMMEND", "APPROVE", "ENDORSE", "PROCEED"];
const CORRECTIONS = ["RETURN", "REQUEST_INITIATOR", "SEND_FOR_CORRECTION"];

export interface CxActivityFilter {
  from?: string | null;
  to?: string | null;
  reviewer?: string | null;
  action?: string | null;
}

export interface CxActivityRow {
  decision_id: string;
  application_id: string;
  ref: string;
  customer_name: string | null;
  product_label: string | null;
  product_code: string | null;
  stage: string;
  action: string;
  reason: string | null;
  reviewer_id: string;
  reviewer_name: string;
  reviewer_email: string;
  decided_at: Date;
  task_entered_at: Date;
  turnaround_ms: string;
  invalidated_at: Date | null;
}

export interface CxReviewerSummary {
  reviewer_id: string;
  reviewer_name: string;
  reviewer_email: string;
  total: number;
  positive: number;
  corrections: number;
  declines: number;
  avg_hours: string | null;
}

export interface CxActivity {
  rows: CxActivityRow[];
  reviewers: CxReviewerSummary[];
  reviewerOptions: { id: string; name: string }[];
  summary: {
    total: number;
    positive: number;
    corrections: number;
    declines: number;
    reviewers: number;
    open_now: number;
    avg_hours: string | null;
  };
  from: string;
  to: string;
}

export async function cxActivityAccess(q: Db, staffId: string): Promise<boolean> {
  const held = await Promise.all(CX_ACTIVITY_ROLES.map((r) => holdsRole(q, staffId, r)));
  return held.some(Boolean);
}

export async function requireCxActivityAccess(q: Db, staffId: string): Promise<void> {
  if (!(await cxActivityAccess(q, staffId))) throw forbidden("Only credit leads, the Merchant Officer Head, the CX Group Head or the Super Admin can see CX reviewer activity.");
}

function dateBounds(filter: CxActivityFilter, now: Date) {
  const today = lagosDate(now);
  const to = filter.to && /^\d{4}-\d{2}-\d{2}$/.test(filter.to) ? filter.to : today;
  const from = filter.from && /^\d{4}-\d{2}-\d{2}$/.test(filter.from) ? filter.from : addDaysToDateString(to, -29);
  const fromParts = from.split("-").map(Number);
  const afterTo = addDaysToDateString(to, 1).split("-").map(Number);
  return { from, to, start: fromLagos(fromParts[0], fromParts[1], fromParts[2]), end: fromLagos(afterTo[0], afterTo[1], afterTo[2]) };
}

export async function cxReviewerActivity(q: Db, filter: CxActivityFilter = {}, now = new Date()): Promise<CxActivity> {
  const { from, to, start, end } = dateBounds(filter, now);
  const where = [`d.actor_role = 'CX_CREDIT_REVIEWER'`, `d.created_at >= $1`, `d.created_at < $2`];
  const params: unknown[] = [start, end];
  if (filter.reviewer) {
    params.push(filter.reviewer);
    where.push(`d.actor_id = $${params.length}`);
  }
  if (filter.action && (CX_ACTIONS as readonly string[]).includes(filter.action)) {
    params.push(filter.action);
    where.push(`d.action = $${params.length}`);
  }
  const clause = where.join(" AND ");

  const rows = (
    await q.query<CxActivityRow>(
      `SELECT d.id AS decision_id, d.application_id, a.ref, a.customer_name, a.product_label, a.product_code,
              d.stage, d.action, d.reason, d.actor_id AS reviewer_id, s.full_name AS reviewer_name, s.email AS reviewer_email,
              d.created_at AS decided_at, t.entered_at AS task_entered_at,
              (extract(epoch FROM (d.created_at - t.entered_at)) * 1000)::text AS turnaround_ms,
              d.invalidated_at
         FROM decisions d
         JOIN applications a ON a.id = d.application_id
         JOIN staff s ON s.id = d.actor_id
         JOIN tasks t ON t.id = d.task_id
        WHERE ${clause}
        ORDER BY d.created_at DESC, d.seq DESC
        LIMIT 2000`,
      params,
    )
  ).rows;

  const reviewers = (
    await q.query<CxReviewerSummary>(
      `SELECT d.actor_id AS reviewer_id, s.full_name AS reviewer_name, s.email AS reviewer_email,
              count(*)::int AS total,
              count(*) FILTER (WHERE d.action = ANY($${params.length + 1}::text[]))::int AS positive,
              count(*) FILTER (WHERE d.action = ANY($${params.length + 2}::text[]))::int AS corrections,
              count(*) FILTER (WHERE d.action = 'REJECT')::int AS declines,
              round(avg(extract(epoch FROM (d.created_at - t.entered_at)) / 3600)::numeric, 1)::text AS avg_hours
         FROM decisions d
         JOIN staff s ON s.id = d.actor_id
         JOIN tasks t ON t.id = d.task_id
        WHERE ${clause}
        GROUP BY d.actor_id, s.full_name, s.email
        ORDER BY s.full_name`,
      [...params, POSITIVE, CORRECTIONS],
    )
  ).rows;

  const reviewerOptions = (
    await q.query<{ id: string; name: string }>(
      `SELECT DISTINCT d.actor_id AS id, s.full_name AS name
         FROM decisions d JOIN staff s ON s.id = d.actor_id
        WHERE d.actor_role = 'CX_CREDIT_REVIEWER' AND d.created_at >= $1 AND d.created_at < $2
        ORDER BY s.full_name`,
      [start, end],
    )
  ).rows;

  const open = (
    await q.query<{ n: number }>("SELECT count(*)::int AS n FROM tasks WHERE status = 'OPEN' AND assignee_role = 'CX_CREDIT_REVIEWER'")
  ).rows[0];

  const total = rows.length;
  const positive = rows.filter((r) => POSITIVE.includes(r.action)).length;
  const corrections = rows.filter((r) => CORRECTIONS.includes(r.action)).length;
  const declines = rows.filter((r) => r.action === "REJECT").length;
  const turnarounds = rows.map((r) => Number(r.turnaround_ms)).filter((n) => Number.isFinite(n) && n >= 0);
  const avgHours = turnarounds.length ? (turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length / 3_600_000).toFixed(1) : null;

  return {
    rows,
    reviewers,
    reviewerOptions,
    summary: {
      total,
      positive,
      corrections,
      declines,
      reviewers: new Set(rows.map((r) => r.reviewer_id)).size,
      open_now: open?.n ?? 0,
      avg_hours: avgHours,
    },
    from,
    to,
  };
}

function csvCell(v: string | number | null): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function cxActivityCsv(data: CxActivity): string {
  const header = ["Reference", "Customer", "Product", "Stage", "Reviewer", "Email", "Action", "Reason", "Decided (Lagos)", "Turnaround (hours)", "Invalidated"];
  const lines = data.rows.map((r) => [
    r.ref,
    r.customer_name ?? "",
    r.product_label ?? r.product_code ?? "",
    r.stage,
    r.reviewer_name,
    r.reviewer_email,
    r.action,
    r.reason ?? "",
    lagosDate(r.decided_at),
    (Number(r.turnaround_ms) / 3_600_000).toFixed(1),
    r.invalidated_at ? "Yes" : "No",
  ]);
  return "﻿" + [header, ...lines].map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
