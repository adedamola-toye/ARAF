import type { Db } from "../db";
import { db } from "../db";
import type { Ctx } from "../context";
import { auditOutsideTx } from "../audit";
import { decryptField } from "../crypto";
import { forbidden, notFound } from "../errors";
import { maskWithLast4 } from "../mask";
import { caseAccess } from "./access";
import { latestAssessment } from "./assessment";
import { listDocuments } from "./documents";
import { workingVersionRead } from "./versions";
import type { Stage } from "./stages";

// ------------------------------------------------------------------ action queue

export const QUEUE_SORTS = {
  assigned: "t.assigned_at",
  waiting: "t.assigned_at",
  amount: "a.requested_amount_kobo",
  customer: "a.customer_name",
  ref: "a.ref",
  stage: "t.stage",
} as const;
export type QueueSort = keyof typeof QUEUE_SORTS;

export interface QueueQuery {
  sort?: QueueSort;
  dir?: "asc" | "desc";
  stage?: string | null;
  role?: string | null;
  q?: string | null;
  page?: number;
  pageSize?: number;
}

export interface QueueItem {
  task_id: string;
  application_id: string;
  ref: string;
  customer_name: string | null;
  requested_amount_kobo: string | null;
  stage: Stage;
  assignee_role: string;
  assigned_at: Date;
  required_action: string;
  applicant_type: string;
}

/**
 * Every open task assigned to the officer, across all of their roles. Filtering never hides
 * items silently: `total` is the filtered count and `allTotal` the unfiltered count.
 */
export async function actionQueue(q: Db, staffId: string, query: QueueQuery) {
  const sortCol = QUEUE_SORTS[query.sort ?? "assigned"] ?? QUEUE_SORTS.assigned;
  // "waiting" descending means longest waiting first = oldest assignment first.
  let dir = query.dir === "desc" ? "DESC" : "ASC";
  if (query.sort === "waiting") dir = query.dir === "asc" ? "DESC" : "ASC";
  const pageSize = Math.min(Math.max(query.pageSize ?? 20, 5), 100);
  const page = Math.max(query.page ?? 1, 1);
  const where = ["t.status = 'OPEN'", "t.assignee_id = $1"];
  const params: unknown[] = [staffId];
  if (query.stage) {
    params.push(query.stage);
    where.push(`t.stage = $${params.length}`);
  }
  if (query.role) {
    params.push(query.role);
    where.push(`t.assignee_role = $${params.length}`);
  }
  if (query.q) {
    params.push(`%${query.q.toLowerCase()}%`);
    where.push(`(lower(a.ref) LIKE $${params.length} OR lower(coalesce(a.customer_name,'')) LIKE $${params.length})`);
  }
  const base = `FROM tasks t JOIN applications a ON a.id = t.application_id WHERE ${where.join(" AND ")}`;
  const total = Number((await q.query<{ n: string }>(`SELECT count(*) AS n ${base}`, params)).rows[0].n);
  const allTotal = Number((await q.query<{ n: string }>("SELECT count(*) AS n FROM tasks WHERE status = 'OPEN' AND assignee_id = $1", [staffId])).rows[0].n);
  const rows = (
    await q.query<QueueItem>(
      `SELECT t.id AS task_id, t.application_id, a.ref, a.customer_name, a.requested_amount_kobo, t.stage, t.assignee_role, t.assigned_at,
              t.required_action, a.applicant_type
       ${base} ORDER BY ${sortCol} ${dir} NULLS LAST, t.id ASC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    )
  ).rows;
  const facets = (
    await q.query<{ stage: string; assignee_role: string; n: string }>(
      "SELECT stage, assignee_role, count(*) AS n FROM tasks WHERE status = 'OPEN' AND assignee_id = $1 GROUP BY 1,2",
      [staffId],
    )
  ).rows;
  return { rows, total, allTotal, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), facets };
}

// ------------------------------------------------------------------ initiator progress

export async function initiatorRequests(q: Db, staffId: string) {
  return (
    await q.query(
      `SELECT a.id, a.ref, a.customer_name, a.requested_amount_kobo, a.stage, a.status, a.route, a.applicant_type, a.created_at, a.submitted_at, a.updated_at,
              t.id AS task_id, t.assigned_at, t.entered_at, s.full_name AS owner_name, t.assignee_role AS owner_role, t.assignee_id AS owner_id
         FROM applications a
         LEFT JOIN tasks t ON t.application_id = a.id AND t.status = 'OPEN'
         LEFT JOIN staff s ON s.id = t.assignee_id
        WHERE a.initiator_id = $1
        ORDER BY a.updated_at DESC`,
      [staffId],
    )
  ).rows;
}

export async function bookedRequests(q: Db, opts: { initiatorId?: string | null }) {
  const params: unknown[] = [];
  let where = "TRUE";
  if (opts.initiatorId) {
    params.push(opts.initiatorId);
    where = `a.initiator_id = $1`;
  }
  const rows = (
    await q.query(
      `SELECT a.id, a.ref, a.customer_name, a.requested_amount_kobo, a.status, a.stage, a.vendor_confirmed_at, a.process_completed_at, a.repayment_prompts_active_at,
              d.amount_kobo AS disbursed_kobo, d.approved_amount_kobo, d.transaction_ref, d.disbursed_on, d.recorded_at,
              s.full_name AS owner_name,
              (SELECT json_agg(json_build_object('seq', r.seq, 'due', r.due_date, 'amount', r.amount_kobo) ORDER BY r.seq)
                 FROM repayment_instalments r WHERE r.disbursement_id = d.id) AS schedule
         FROM applications a JOIN disbursements d ON d.application_id = a.id JOIN staff s ON s.id = a.initiator_id
        WHERE ${where}
        ORDER BY d.disbursed_on DESC, a.ref`,
      params,
    )
  ).rows;
  return rows;
}

/** Upcoming instalments for an initiator's closed cases (repayment prompts). */
export async function repaymentPrompts(q: Db, staffId: string, fromDate: string, toDate: string) {
  return (
    await q.query(
      `SELECT a.id, a.ref, a.customer_name, r.seq, r.due_date, r.amount_kobo
         FROM repayment_instalments r JOIN applications a ON a.id = r.application_id
        WHERE a.initiator_id = $1 AND a.repayment_prompts_active_at IS NOT NULL AND r.due_date BETWEEN $2 AND $3
        ORDER BY r.due_date, a.ref`,
      [staffId, fromDate, toDate],
    )
  ).rows;
}

// ------------------------------------------------------------------ case detail

export async function getCase(ctx: Ctx, appId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const app = (await db.query("SELECT * FROM applications WHERE id = $1", [appId])).rows[0];
  if (!app) throw notFound("Request not found.");
  const access = await caseAccess(db, actor.staffId, appId);
  if (!access.canView) {
    await auditOutsideTx(ctx, { action: "CASE_VIEW", outcome: "DENIED", applicationId: appId });
    throw forbidden("You do not have access to this request.");
  }
  const versionId = app.current_version_id;
  const version = versionId ? (await db.query("SELECT * FROM application_versions WHERE id = $1", [versionId])).rows[0] : null;
  const working = await workingVersionRead(db, appId);
  const directors = version ? (await db.query("SELECT id, position, full_name, bvn_last4 FROM application_directors WHERE version_id = $1 ORDER BY position", [version.id])).rows : [];
  const versions = (await db.query("SELECT id, version_no, created_at, submitted_at, material_digest FROM application_versions WHERE application_id = $1 ORDER BY version_no", [appId])).rows;
  const tasks = (
    await db.query(
      `SELECT t.*, s.full_name AS assignee_name, c.full_name AS completed_by_name,
              (SELECT max(sent_at) FROM reminders r WHERE r.task_id = t.id) AS last_reminder_at
         FROM tasks t LEFT JOIN staff s ON s.id = t.assignee_id LEFT JOIN staff c ON c.id = t.completed_by
        WHERE t.application_id = $1 ORDER BY t.seq`,
      [appId],
    )
  ).rows;
  const decisions = (
    await db.query(
      `SELECT d.*, s.full_name AS actor_name, v.version_no FROM decisions d JOIN staff s ON s.id = d.actor_id
         LEFT JOIN application_versions v ON v.id = d.version_id WHERE d.application_id = $1 ORDER BY d.seq`,
      [appId],
    )
  ).rows;
  const corrections = (await db.query("SELECT c.*, s.full_name AS requested_by_name FROM corrections c JOIN staff s ON s.id = c.requested_by WHERE application_id = $1 ORDER BY seq", [appId])).rows;
  const assessment = await latestAssessment(db, appId);
  const assessments = (await db.query("SELECT a.*, s.full_name AS assessor_name FROM credit_assessments a JOIN staff s ON s.id = a.assessor_id WHERE application_id = $1 ORDER BY created_at DESC", [appId])).rows;
  const documents = await listDocuments(db, appId);
  const disbursement = (await db.query("SELECT d.*, s.full_name AS recorded_by_name FROM disbursements d JOIN staff s ON s.id = d.recorded_by WHERE application_id = $1", [appId])).rows[0] ?? null;
  const instalments = (await db.query("SELECT * FROM repayment_instalments WHERE application_id = $1 ORDER BY seq", [appId])).rows;
  const closure = (await db.query("SELECT c.*, o.status AS delivery_status, o.attempts, o.last_error, o.sent_at FROM closure_events c LEFT JOIN notification_outbox o ON o.id = c.outbox_id WHERE c.application_id = $1", [appId])).rows[0] ?? null;
  const people = (
    await db.query(
      `SELECT id, full_name, email FROM staff WHERE id = ANY($1::uuid[])`,
      [[app.initiator_id, app.endorser_id, app.first_reviewer_id, app.second_reviewer_id, app.pack_co3_id, app.do1_id, app.do2_id, app.selected_rbe_id, app.vendor_confirmed_by, app.process_completed_by].filter(Boolean)],
    )
  ).rows;
  const openTask = tasks.find((t: { status: string }) => t.status === "OPEN") ?? null;
  await auditOutsideTx(ctx, { action: "CASE_VIEW", applicationId: appId, stage: app.stage, details: { capacities: access.capacities } });
  return {
    app,
    access,
    version,
    working,
    directors,
    versions,
    tasks,
    openTask,
    decisions,
    corrections,
    assessment,
    assessments,
    documents,
    disbursement,
    instalments,
    closure,
    people: Object.fromEntries(people.map((p: { id: string; full_name: string }) => [p.id, p.full_name])) as Record<string, string>,
    masked: {
      bvn: maskWithLast4(version?.bvn_last4),
      tin: version?.tin_last4 ? maskWithLast4(version.tin_last4, 10) : "—",
    },
  };
}

/** Reveal restricted identifiers to an authorised case stakeholder. Always audited. */
export async function revealIdentifiers(ctx: Ctx, appId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const access = await caseAccess(db, actor.staffId, appId);
  if (!access.canView) {
    await auditOutsideTx(ctx, { action: "SENSITIVE_REVEAL", outcome: "DENIED", applicationId: appId });
    throw forbidden();
  }
  const app = (await db.query("SELECT current_version_id FROM applications WHERE id = $1", [appId])).rows[0];
  const v = app?.current_version_id ? (await db.query("SELECT bvn_enc, tin_enc FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0] : null;
  const dirs = app?.current_version_id ? (await db.query("SELECT full_name, bvn_enc FROM application_directors WHERE version_id = $1 ORDER BY position", [app.current_version_id])).rows : [];
  await auditOutsideTx(ctx, { action: "SENSITIVE_REVEAL", applicationId: appId, details: { fields: ["bvn", "tin", "directors.bvn"] } });
  return {
    bvn: v?.bvn_enc ? decryptField(v.bvn_enc) : null,
    tin: v?.tin_enc ? decryptField(v.tin_enc) : null,
    directors: dirs.map((d: { full_name: string; bvn_enc: string }) => ({ fullName: d.full_name, bvn: decryptField(d.bvn_enc) })),
  };
}
