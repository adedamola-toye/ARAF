/**
 * Read models for the Staff Personal Financing screens. Every list is scoped to what the viewer's
 * role allows; nothing here changes data.
 */
import type { Db } from "../db";
import { hmac, safeEqualHex } from "../crypto";
import { STAFF_STATUSES, type StaffStatus } from "@/lib/staff-financing";
import { DISBURSEMENT_ROLES, type StaffRequestRow } from "./core";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function heldRoles(q: Db, staffId: string): Promise<Set<string>> {
  return new Set(
    (await q.query<{ role: string }>("SELECT ra.role FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.staff_id = $1 AND ra.active AND s.status = 'ACTIVE'", [staffId])).rows.map((r) => r.role),
  );
}

export type QueueView = "pm" | "uh" | "dh" | "do" | "docs" | "ops";
export const QUEUE_LABELS: Record<QueueView, string> = {
  pm: "Product Manager",
  uh: "Unit Head",
  dh: "Divisional Head",
  do: "Disbursement",
  docs: "Legal and Shariah",
  ops: "Operations",
};

export function viewsFor(roles: Set<string>): QueueView[] {
  const v: QueueView[] = [];
  if (roles.has("PRODUCT_MANAGER")) v.push("pm");
  if (roles.has("UNIT_HEAD")) v.push("uh");
  if (roles.has("DIVISIONAL_HEAD")) v.push("dh");
  if (DISBURSEMENT_ROLES.some((r) => roles.has(r))) v.push("do");
  if (roles.has("LEGAL_REVIEWER") || roles.has("SHARIAH_REVIEWER")) v.push("docs");
  if (roles.has("SUPER_ADMIN")) v.push("ops");
  return v;
}

/** Signed, short-lived document links bound to the viewer and session (namespaced away from case documents). */
const LINK_TTL = 300;
export function staffDocLink(docId: string, staffId: string, sessionId: string, mode: "view" | "download", now = new Date()) {
  const exp = Math.floor(now.getTime() / 1000) + LINK_TTL;
  const sig = hmac(`staff-doc:${docId}|${staffId}|${sessionId}|${mode}|${exp}`);
  return `/api/staff-requests/documents/${docId}?mode=${mode}&exp=${exp}&sig=${sig}`;
}
export function verifyStaffDocLink(docId: string, staffId: string, sessionId: string, mode: string, exp: string, sig: string, now = new Date()) {
  if (!/^\d+$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig) || Number(exp) < Math.floor(now.getTime() / 1000)) return false;
  return safeEqualHex(sig, hmac(`staff-doc:${docId}|${staffId}|${sessionId}|${mode}|${exp}`));
}

export async function requestDetail(q: Db, req: StaffRequestRow) {
  const [reviews, events, docs, assignments, archive, sharepoint, handover, groups, people] = await Promise.all([
    q.query("SELECT r.*, s.full_name AS actor_name, d.full_name AS designated_name FROM staff_request_reviews r JOIN staff s ON s.id = r.actor_id LEFT JOIN staff d ON d.id = r.designated_next_id WHERE r.request_id = $1 ORDER BY r.created_at", [req.id]),
    q.query("SELECT e.*, s.full_name AS actor_name FROM staff_request_events e LEFT JOIN staff s ON s.id = e.actor_id WHERE e.request_id = $1 ORDER BY e.id", [req.id]),
    q.query("SELECT d.*, s.full_name AS uploaded_by_name FROM staff_request_documents d LEFT JOIN staff s ON s.id = d.uploaded_by WHERE d.request_id = $1 AND d.removed_at IS NULL ORDER BY d.seq", [req.id]),
    q.query("SELECT a.*, o.full_name AS officer_name, b.full_name AS assigned_by_name FROM staff_request_assignments a JOIN staff o ON o.id = a.officer_id LEFT JOIN staff b ON b.id = a.assigned_by WHERE a.request_id = $1 ORDER BY a.assigned_at", [req.id]),
    q.query("SELECT * FROM staff_request_archives WHERE request_id = $1", [req.id]),
    q.query("SELECT * FROM staff_request_sharepoint WHERE request_id = $1", [req.id]),
    q.query("SELECT * FROM staff_request_handovers WHERE request_id = $1", [req.id]),
    q.query(
      `SELECT g.*, r.full_name AS received_by_name, v.full_name AS reviewed_by_name FROM staff_request_handover_groups g JOIN staff_request_handovers h ON h.id = g.handover_id
         LEFT JOIN staff r ON r.id = g.received_by LEFT JOIN staff v ON v.id = g.reviewed_by WHERE h.request_id = $1 ORDER BY g.group_code`,
      [req.id],
    ),
    q.query(
      "SELECT id, full_name FROM staff WHERE id = ANY($1)",
      [[req.pm_reviewer_id, req.unit_head_id, req.divisional_head_id, req.approved_by, req.disbursement_officer_id, req.disbursement_confirmed_by, req.returned_by, req.declined_by].filter(Boolean)],
    ),
  ]);
  const name = new Map(people.rows.map((p: any) => [p.id, p.full_name]));
  return {
    reviews: reviews.rows,
    events: events.rows,
    docs: docs.rows,
    assignments: assignments.rows,
    archive: archive.rows[0] ?? null,
    sharepoint: sharepoint.rows[0] ?? null,
    handover: handover.rows[0] ?? null,
    groups: groups.rows,
    nameOf: (id: string | null | undefined) => (id ? (name.get(id) ?? "—") : "—"),
  };
}

export interface QueueFilters {
  q?: string;
  status?: string;
  page?: number;
}
const PAGE = 20;

function where(base: string[], params: unknown[], f: QueueFilters) {
  if (f.q) {
    params.push(`%${f.q.trim()}%`);
    base.push(`(r.ref ILIKE $${params.length} OR r.full_name ILIKE $${params.length} OR r.staff_number ILIKE $${params.length})`);
  }
  if (f.status && (STAFF_STATUSES as readonly string[]).includes(f.status)) {
    params.push(f.status);
    base.push(`r.status = $${params.length}`);
  }
  return base.length ? `WHERE ${base.join(" AND ")}` : "";
}

/** Rows for a role queue (with search, status filter and pagination). */
export async function queueRows(q: Db, view: QueueView, staffId: string, f: QueueFilters) {
  const params: unknown[] = [staffId];
  const conds: string[] = [];
  switch (view) {
    case "pm":
      conds.push("r.submission_count > 0", "r.applicant_id <> $1");
      break;
    case "uh":
      conds.push("(r.unit_head_id = $1 OR EXISTS (SELECT 1 FROM staff_request_reviews x WHERE x.request_id = r.id AND x.actor_id = $1 AND x.stage = 'UNIT_HEAD'))", "r.applicant_id <> $1");
      break;
    case "dh":
      conds.push("EXISTS (SELECT 1 FROM staff_request_reviews x WHERE x.request_id = r.id AND x.stage = 'UNIT_HEAD' AND x.action = 'APPROVE')", "r.applicant_id <> $1");
      break;
    case "do":
      conds.push("EXISTS (SELECT 1 FROM staff_request_assignments x WHERE x.request_id = r.id AND x.officer_id = $1)");
      break;
    case "docs":
      conds.push("EXISTS (SELECT 1 FROM staff_request_handovers h WHERE h.request_id = r.id)", "r.applicant_id <> $1");
      break;
    case "ops":
      conds.push("r.status <> 'DRAFT'", "$1::uuid IS NOT NULL");
      break;
  }
  const w = where(conds, params, f);
  const page = Math.max(1, f.page ?? 1);
  const total = Number((await q.query(`SELECT count(*) AS n FROM staff_requests r ${w}`, params)).rows[0].n);
  // Items needing the viewer's action first, then most recently updated.
  const actionable: Record<QueueView, string> = {
    pm: "r.status = 'SUBMITTED' OR (r.status = 'UNDER_PM_REVIEW' AND r.pm_reviewer_id = $1)",
    uh: "r.status = 'UNDER_UNIT_HEAD_REVIEW' AND r.unit_head_id = $1",
    dh: "r.status = 'UNDER_DIVISIONAL_HEAD_REVIEW'",
    do: "r.status IN ('ASSIGNED_FOR_DISBURSEMENT','DISBURSEMENT_IN_PROGRESS') AND r.disbursement_officer_id = $1",
    docs: "r.documentation_status IN ('SENT_TO_LEGAL_SHARIAH','RECEIVED_BY_LEGAL_SHARIAH')",
    ops: "r.offer_blocked_reason IS NOT NULL OR r.doc_last_error IS NOT NULL OR (r.status = 'AWAITING_SIGNED_OFFER' AND r.signed_offer_received_at IS NOT NULL)",
  };
  const rows = (
    await q.query(
      `SELECT r.*, (${actionable[view]}) AS needs_action, a.full_name AS applicant_name
         FROM staff_requests r JOIN staff a ON a.id = r.applicant_id ${w}
        ORDER BY (${actionable[view]}) DESC, r.updated_at DESC LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`,
      params,
    )
  ).rows;
  return { rows, total, page, pages: Math.max(1, Math.ceil(total / PAGE)) };
}

const avgHours = (expr: string) => `round(avg(extract(epoch FROM (${expr})) / 3600)::numeric, 1)`;

/** KPI tiles per role view (values in kobo or counts). */
export async function queueMetrics(q: Db, view: QueueView, staffId: string) {
  const one = async (sql: string, p: unknown[] = [staffId]) => (await q.query(sql, p)).rows[0];
  switch (view) {
    case "pm":
      return one(
        `SELECT count(*) FILTER (WHERE status = 'SUBMITTED' OR (status = 'UNDER_PM_REVIEW' AND pm_reviewer_id = $1)) AS awaiting,
                (SELECT count(*) FROM staff_request_reviews WHERE stage = 'PRODUCT_MANAGER' AND actor_id = $1) AS reviewed,
                (SELECT count(*) FROM staff_request_reviews WHERE stage = 'PRODUCT_MANAGER' AND action = 'RETURN' AND actor_id = $1) AS returned,
                (SELECT count(*) FROM staff_request_reviews WHERE stage = 'PRODUCT_MANAGER' AND action = 'FORWARD' AND actor_id = $1) AS checklists,
                (SELECT ${avgHours("v.created_at - r2.submitted_at")} FROM staff_request_reviews v JOIN staff_requests r2 ON r2.id = v.request_id WHERE v.stage = 'PRODUCT_MANAGER' AND v.actor_id = $1 AND v.created_at >= r2.submitted_at) AS avg_hours
           FROM staff_requests WHERE applicant_id <> $1`,
      );
    case "uh":
      return one(
        `SELECT count(*) FILTER (WHERE status = 'UNDER_UNIT_HEAD_REVIEW' AND unit_head_id = $1) AS awaiting,
                (SELECT count(*) FROM staff_request_reviews WHERE stage = 'UNIT_HEAD' AND actor_id = $1 AND action = 'APPROVE') AS approved,
                (SELECT count(*) FROM staff_request_reviews WHERE stage = 'UNIT_HEAD' AND actor_id = $1 AND action = 'RETURN') AS returned,
                (SELECT count(*) FROM staff_request_reviews WHERE stage = 'UNIT_HEAD' AND actor_id = $1 AND action = 'DECLINE') AS declined,
                (SELECT ${avgHours("u.created_at - p.created_at")} FROM staff_request_reviews u JOIN LATERAL (SELECT created_at FROM staff_request_reviews p WHERE p.request_id = u.request_id AND p.stage = 'PRODUCT_MANAGER' AND p.action = 'FORWARD' AND p.created_at <= u.created_at ORDER BY p.created_at DESC LIMIT 1) p ON true WHERE u.stage = 'UNIT_HEAD' AND u.actor_id = $1) AS avg_hours
           FROM staff_requests`,
      );
    case "dh":
      return one(
        `SELECT count(*) FILTER (WHERE status = 'UNDER_DIVISIONAL_HEAD_REVIEW' AND applicant_id <> $1) AS awaiting,
                coalesce(sum(gross_kobo) FILTER (WHERE submission_count > 0), 0) AS requested_kobo,
                coalesce(sum(gross_kobo) FILTER (WHERE approved_at IS NOT NULL OR status IN ('COMPLETED')), 0) AS approved_kobo,
                coalesce(sum(gross_kobo) FILTER (WHERE status = 'DECLINED'), 0) AS declined_kobo,
                (SELECT ${avgHours("d.created_at - u.created_at")} FROM staff_request_reviews d JOIN LATERAL (SELECT created_at FROM staff_request_reviews u WHERE u.request_id = d.request_id AND u.stage = 'UNIT_HEAD' AND u.action = 'APPROVE' AND u.created_at <= d.created_at ORDER BY u.created_at DESC LIMIT 1) u ON true WHERE d.stage = 'DIVISIONAL_HEAD' AND d.action <> 'AMEND') AS avg_hours
           FROM staff_requests`,
      );
    case "do":
      return one(
        `SELECT count(*) FILTER (WHERE disbursement_officer_id = $1 AND status IN ('ASSIGNED_FOR_DISBURSEMENT','DISBURSEMENT_IN_PROGRESS')) AS assigned,
                count(*) FILTER (WHERE disbursement_officer_id = $1 AND status = 'ASSIGNED_FOR_DISBURSEMENT') AS awaiting,
                count(*) FILTER (WHERE disbursement_confirmed_by = $1 AND status = 'COMPLETED') AS completed,
                coalesce(sum(disbursed_amount_kobo) FILTER (WHERE disbursement_confirmed_by = $1), 0) AS net_kobo,
                (SELECT count(*) FROM staff_request_events e JOIN staff_requests x ON x.id = e.request_id WHERE e.action IN ('SIGNED_OFFER_RETURNED') AND e.actor_id = $1) AS exceptions
           FROM staff_requests`,
      );
    case "docs":
      return one(
        `SELECT count(*) FILTER (WHERE documentation_status = 'SENT_TO_LEGAL_SHARIAH') AS sent,
                count(*) FILTER (WHERE documentation_status = 'RECEIVED_BY_LEGAL_SHARIAH') AS received,
                count(*) FILTER (WHERE documentation_status = 'REVIEW_COMPLETED') AS completed
           FROM staff_requests WHERE applicant_id <> $1`,
      );
    case "ops":
      return one(
        `SELECT count(*) FILTER (WHERE offer_blocked_reason IS NOT NULL AND status = 'APPROVED') AS offers_blocked,
                count(*) FILTER (WHERE status = 'AWAITING_SIGNED_OFFER' AND signed_offer_received_at IS NOT NULL) AS unassigned,
                count(*) FILTER (WHERE status = 'COMPLETED' AND documentation_status IN ('PREPARING_ARCHIVE','AWAITING_SHAREPOINT') AND doc_last_error IS NOT NULL) AS doc_failures,
                count(*) FILTER (WHERE status = 'AWAITING_SIGNED_OFFER' AND signed_offer_received_at IS NULL) AS awaiting_signature
           FROM staff_requests WHERE $1::uuid IS NOT NULL`,
      );
  }
}

export async function myRequestRows(q: Db, staffId: string) {
  return (
    await q.query<StaffRequestRow & { latest_event: string | null; latest_at: Date | null }>(
      `SELECT r.*, e.action AS latest_event, e.occurred_at AS latest_at
         FROM staff_requests r
         LEFT JOIN LATERAL (SELECT action, occurred_at FROM staff_request_events WHERE request_id = r.id AND action NOT IN ('DOCUMENT_VIEWED','DOCUMENT_DOWNLOADED','DRAFT_SAVED') ORDER BY id DESC LIMIT 1) e ON true
        WHERE r.applicant_id = $1 ORDER BY r.created_at DESC`,
      [staffId],
    )
  ).rows;
}

export function isStatus(s: string): s is StaffStatus {
  return (STAFF_STATUSES as readonly string[]).includes(s);
}

/** Items waiting for this person's action across their staff financing roles (navigation badge). */
export async function staffActionCount(q: Db, staffId: string, roles: Set<string>): Promise<number> {
  const parts: string[] = [];
  if (roles.has("PRODUCT_MANAGER")) parts.push("(status = 'SUBMITTED' OR (status = 'UNDER_PM_REVIEW' AND pm_reviewer_id = $1))");
  if (roles.has("UNIT_HEAD")) parts.push("(status = 'UNDER_UNIT_HEAD_REVIEW' AND unit_head_id = $1)");
  if (roles.has("DIVISIONAL_HEAD")) parts.push("(status = 'UNDER_DIVISIONAL_HEAD_REVIEW')");
  if (DISBURSEMENT_ROLES.some((r) => roles.has(r))) parts.push("(status IN ('ASSIGNED_FOR_DISBURSEMENT','DISBURSEMENT_IN_PROGRESS') AND disbursement_officer_id = $1)");
  if (!parts.length) return 0;
  return Number((await q.query(`SELECT count(*) AS n FROM staff_requests WHERE applicant_id <> $1 AND (${parts.join(" OR ")})`, [staffId])).rows[0].n);
}
