/** Altphones dashboards: queues, buckets and concise reporting. Read-only queries. */
import type { Db } from "../db";
import type { AltStatus } from "@/lib/altphones";
import { activeRoles, BPM_ROLE, currentSettings, PM_ROLE } from "./core";

export const BUCKETS = {
  drafts: { label: "New sale in progress", statuses: ["DRAFT"] },
  payment: { label: "Pending payments", statuses: ["AWAITING_PAYMENT", "AWAITING_DOWN_PAYMENT"] },
  preparing: { label: "Handover, mandates and contract", statuses: ["PAID", "IN_PREPARATION", "RETURNED_FOR_CORRECTION"] },
  approval: { label: "Pending approvals", statuses: ["UNDER_BPM_REVIEW", "UNDER_PM_REVIEW", "UNDER_UNIT_HEAD_REVIEW"] },
  approved: { label: "Approved for disbursement", statuses: ["APPROVED"] },
  completed: { label: "Completed transactions", statuses: ["COMPLETED", "DISBURSED"] },
  closed: { label: "Declined, rejected or cancelled", statuses: ["CREDIT_DECLINED", "REJECTED", "CANCELLED"] },
} satisfies Record<string, { label: string; statuses: AltStatus[] }>;
export type Bucket = keyof typeof BUCKETS;

export interface AppListRow {
  id: string;
  ref: string;
  kind: "OUTRIGHT" | "CREDIT";
  channel: "DO" | "SA";
  status: AltStatus;
  customer_name: string | null;
  model_name: string | null;
  tenure_months: number | null;
  origin_name: string | null;
  supply_name: string | null;
  originator_name: string | null;
  legacy: boolean;
  refund_status: string | null;
  updated_at: Date;
  submitted_at: Date | null;
}

const LIST_SQL = `SELECT a.id, a.ref, a.kind, a.channel, a.status, a.customer_name, a.model_name, a.tenure_months, a.legacy, a.refund_status, a.updated_at, a.submitted_at,
        o.name AS origin_name, s.name AS supply_name, coalesce(st.full_name, a.legacy_officer) AS originator_name
   FROM altphones_applications a
   LEFT JOIN locations o ON o.id = a.origin_location_id
   LEFT JOIN locations s ON s.id = a.supply_location_id
   LEFT JOIN staff st ON st.id = a.originator_id`;

export async function myBucketCounts(q: Db, staffId: string): Promise<Record<Bucket, number>> {
  const rows = (await q.query<{ status: string; n: string }>("SELECT status, count(*) AS n FROM altphones_applications WHERE originator_id = $1 AND NOT legacy GROUP BY status", [staffId])).rows;
  const out = Object.fromEntries(Object.keys(BUCKETS).map((k) => [k, 0])) as Record<Bucket, number>;
  for (const r of rows) for (const [k, b] of Object.entries(BUCKETS)) if ((b.statuses as string[]).includes(r.status)) out[k as Bucket] += Number(r.n);
  return out;
}

export async function myApplications(q: Db, staffId: string, bucket: Bucket | null, limit = 50): Promise<AppListRow[]> {
  const statuses = bucket ? (BUCKETS[bucket].statuses as string[]) : null;
  return (await q.query<AppListRow>(`${LIST_SQL} WHERE a.originator_id = $1 AND NOT a.legacy AND ($2::text[] IS NULL OR a.status = ANY($2)) ORDER BY a.updated_at DESC LIMIT $3`, [staffId, statuses, limit])).rows;
}

export interface ReviewQueues {
  bpm: AppListRow[] | null;
  bpmReturned: AppListRow[] | null;
  pm: AppListRow[] | null;
  uh: AppListRow[] | null;
}

export async function reviewQueues(q: Db, staffId: string): Promise<ReviewQueues> {
  const roles = await activeRoles(q, staffId);
  const s = await currentSettings(q);
  const list = (where: string, params: unknown[] = []) => q.query<AppListRow>(`${LIST_SQL} WHERE ${where} ORDER BY a.submitted_at NULLS LAST, a.updated_at LIMIT 200`, params).then((r) => r.rows);
  return {
    bpm: roles.has(BPM_ROLE) ? await list("a.status = 'UNDER_BPM_REVIEW' AND a.originator_id <> $1 AND (a.routed_bpm_id IS NULL OR a.routed_bpm_id = $1)", [staffId]) : null,
    bpmReturned: roles.has(BPM_ROLE) ? await list("a.status = 'RETURNED_FOR_CORRECTION' AND a.channel = 'SA'") : null,
    pm: roles.has(PM_ROLE) ? await list("a.status = 'UNDER_PM_REVIEW' AND a.originator_id <> $1", [staffId]) : null,
    uh: roles.has("UNIT_HEAD") && s.unit_head_staff_id === staffId ? await list("a.status = 'UNDER_UNIT_HEAD_REVIEW'") : null,
  };
}

export async function reviewQueueCount(q: Db, staffId: string): Promise<number> {
  const r = await reviewQueues(q, staffId);
  return (r.bpm?.length ?? 0) + (r.pm?.length ?? 0) + (r.uh?.length ?? 0);
}

export async function reviewHistory(q: Db, staffId: string, limit = 50) {
  return (
    await q.query<{ id: string; ref: string; stage: string; action: string; comments: string | null; decided_at: Date; status: AltStatus; customer_name: string | null }>(
      `SELECT a.id, a.ref, r.stage, r.action, r.comments, r.decided_at, a.status, a.customer_name FROM altphones_reviews r JOIN altphones_applications a ON a.id = r.application_id
        WHERE r.actor_id = $1 ORDER BY r.decided_at DESC LIMIT $2`,
      [staffId, limit],
    )
  ).rows;
}

export async function searchApplications(q: Db, term: string, status: string | null, limit = 100) {
  const t = term.trim();
  return (
    await q.query<AppListRow>(
      `${LIST_SQL} WHERE ($1 = '' OR a.ref ILIKE '%' || $1 || '%' OR a.customer_name ILIKE '%' || $1 || '%' OR a.imei = $1 OR a.legacy_ref ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR a.status = $2) ORDER BY a.updated_at DESC LIMIT $3`,
      [t, status, limit],
    )
  ).rows;
}

/** Concise reporting: sales, financing, approval turnaround, officers, upcoming repayments. */
export async function performance(q: Db, sinceDays = 30) {
  const since = `now() - interval '${Math.max(1, Math.min(3650, Math.trunc(sinceDays)))} days'`;
  const totals = (
    await q.query<{ outright: string; credit: string; financed: string; legacy: string; in_review: string; approved: string; avg_turnaround_h: string | null; refunds: string }>(
      `SELECT count(*) FILTER (WHERE status = 'COMPLETED' AND completed_at >= ${since}) AS outright,
              count(*) FILTER (WHERE status = 'DISBURSED' AND completed_at >= ${since}) AS credit,
              coalesce(sum(financed_kobo) FILTER (WHERE status = 'DISBURSED' AND completed_at >= ${since} AND NOT legacy), 0) AS financed,
              count(*) FILTER (WHERE legacy) AS legacy,
              count(*) FILTER (WHERE status IN ('UNDER_BPM_REVIEW','UNDER_PM_REVIEW','UNDER_UNIT_HEAD_REVIEW')) AS in_review,
              count(*) FILTER (WHERE status = 'APPROVED') AS approved,
              round(avg(extract(epoch FROM (approved_at - submitted_at)) / 3600) FILTER (WHERE approved_at >= ${since}), 1) AS avg_turnaround_h,
              count(*) FILTER (WHERE refund_status = 'REQUIRED') AS refunds
         FROM altphones_applications`,
    )
  ).rows[0];
  const officers = (
    await q.query<{ name: string; channel: string; outright: string; credit: string; open: string }>(
      `SELECT coalesce(s.full_name, a.legacy_officer, 'Unknown') AS name, a.channel,
              count(*) FILTER (WHERE a.status = 'COMPLETED') AS outright, count(*) FILTER (WHERE a.status = 'DISBURSED') AS credit,
              count(*) FILTER (WHERE a.status NOT IN ('COMPLETED','DISBURSED','CREDIT_DECLINED','REJECTED','CANCELLED')) AS open
         FROM altphones_applications a LEFT JOIN staff s ON s.id = a.originator_id
        WHERE a.created_at >= ${since} OR a.completed_at >= ${since}
        GROUP BY 1, 2 ORDER BY count(*) FILTER (WHERE a.status IN ('COMPLETED','DISBURSED')) DESC LIMIT 15`,
    )
  ).rows;
  const dues = (
    await q.query<{ month: string; amount: string; n: string }>(
      `SELECT to_char(date_trunc('month', sc.due_date), 'YYYY-MM') AS month, sum(sc.amount_kobo) AS amount, count(*) AS n
         FROM altphones_schedule sc JOIN altphones_applications a ON a.id = sc.application_id
        WHERE a.status = 'DISBURSED' AND sc.basis = 'FINAL' AND sc.due_date >= current_date
        GROUP BY 1 ORDER BY 1 LIMIT 12`,
    )
  ).rows;
  const stock = (await q.query<{ physical: string; reserved: string }>("SELECT coalesce(sum(physical), 0) AS physical, coalesce(sum(reserved), 0) AS reserved FROM altphones_stock")).rows[0];
  return { totals, officers, dues, stock };
}

export async function pendingReplenishments(q: Db) {
  return (
    await q.query(
      `SELECT r.*, l.name AS location_name, m.name AS model_name, s.full_name AS requested_by_name, d.full_name AS decided_by_name
         FROM altphones_replenishments r JOIN locations l ON l.id = r.location_id JOIN altphones_models m ON m.id = r.model_id
         JOIN staff s ON s.id = r.requested_by LEFT JOIN staff d ON d.id = r.decided_by
        ORDER BY (r.status = 'PENDING') DESC, r.requested_at DESC LIMIT 100`,
    )
  ).rows;
}

/** Which Altphones areas this person can open (drives navigation). */
export async function altphonesAccess(q: Db, staffId: string) {
  const roles = await activeRoles(q, staffId);
  const s = await currentSettings(q);
  const originator = roles.has("DELIGHT_OFFICER") || roles.has("SMILE_ASSOCIATE");
  const reviewer = roles.has(BPM_ROLE) || roles.has(PM_ROLE) || (roles.has("UNIT_HEAD") && s.unit_head_staff_id === staffId);
  return {
    originator,
    reviewer,
    pm: roles.has(PM_ROLE),
    admin: roles.has("SUPER_ADMIN"),
    inventory: roles.has(PM_ROLE) || roles.has("SUPER_ADMIN"),
    any: originator || reviewer || roles.has(PM_ROLE) || roles.has("SUPER_ADMIN"),
  };
}
