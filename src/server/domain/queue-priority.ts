/**
 * Action queue priority. Every open task falls into exactly one group, checked in this order:
 *   OVERDUE   past its SLA reminder deadline (business-hours aware, from the SLA policy);
 *   URGENT    carries a material flag a reviewer must see (credit score exception under review,
 *             Vendor Financing business photograph skipped, request suspended);
 *   RETURNED  sent back to the originator for correction;
 *   NEW       assigned within the last 24 hours;
 *   OTHER     everything else still pending.
 * Within the queue, items are ordered by group, then by how long they have waited (oldest first).
 */
import type { Db } from "../db";
import { slaPolicy, slaStatus } from "./sla-reminders";
import type { QueueItem } from "./views";

export type Priority = "OVERDUE" | "URGENT" | "RETURNED" | "NEW" | "OTHER";
export const PRIORITY_ORDER: Priority[] = ["OVERDUE", "URGENT", "RETURNED", "NEW", "OTHER"];
export const PRIORITY_LABEL: Record<Priority, string> = { OVERDUE: "Overdue", URGENT: "Needs attention", RETURNED: "Returned", NEW: "New", OTHER: "Other pending" };

export function queuePriority(
  row: Pick<QueueItem, "stage" | "assigned_at" | "suspended" | "photo_skipped" | "application_id">,
  now: Date,
  overdue: (assignedAt: Date) => boolean,
  exceptionIds: Set<string>,
): Priority {
  const assigned = new Date(row.assigned_at);
  if (overdue(assigned)) return "OVERDUE";
  if (row.suspended || row.photo_skipped || exceptionIds.has(row.application_id)) return "URGENT";
  if (row.stage === "INITIATOR_CORRECTION") return "RETURNED";
  if (now.getTime() - assigned.getTime() < 24 * 3600_000) return "NEW";
  return "OTHER";
}

/** A ready-made classifier using the configured SLA policy and open credit exceptions. */
export async function priorityClassifier(q: Db, now: Date) {
  const sla = await slaPolicy(q);
  const exceptionIds = new Set((await q.query<{ application_id: string }>("SELECT application_id FROM credit_exceptions WHERE status = 'PENDING_REVIEW'")).rows.map((x) => x.application_id));
  return (row: Parameters<typeof queuePriority>[0]) => queuePriority(row, now, (a) => !!slaStatus(a, now, sla)?.overdue, exceptionIds);
}

/** The person's most pressing open task other than `exceptTaskId` (for "Next case"). */
export async function nextTask(q: Db, staffId: string, now: Date, exceptTaskId?: string | null) {
  const rows = (
    await q.query<QueueItem>(
      `SELECT t.id AS task_id, t.application_id, a.ref, a.customer_name, a.requested_amount_kobo, t.stage, t.assignee_role, t.assigned_at, t.required_action,
              a.applicant_type, a.product_label, a.suspended_at IS NOT NULL AS suspended,
              EXISTS (SELECT 1 FROM vf_photo_reviews pr WHERE pr.application_id = a.id AND pr.decision = 'SKIPPED') AS photo_skipped
         FROM tasks t JOIN applications a ON a.id = t.application_id
        WHERE t.status = 'OPEN' AND t.assignee_id = $1 AND ($2::uuid IS NULL OR t.id <> $2) ORDER BY t.assigned_at LIMIT 300`,
      [staffId, exceptTaskId ?? null],
    )
  ).rows;
  if (!rows.length) return null;
  const pri = await priorityClassifier(q, now);
  return rows.map((r) => ({ r, p: PRIORITY_ORDER.indexOf(pri(r)) })).sort((a, b) => a.p - b.p || new Date(a.r.assigned_at).getTime() - new Date(b.r.assigned_at).getTime())[0].r;
}
