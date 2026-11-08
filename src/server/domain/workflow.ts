/**
 * WakeelBoost workflow domain module (server-side only).
 *
 * Every transition runs in a single database transaction that:
 *   1. claims an idempotency key (duplicate submissions replay the first result),
 *   2. locks the application and the open task (concurrency guard + optional lock_version check),
 *   3. verifies the actor is the task assignee AND still holds the task's role,
 *   4. records the decision against the exact application version and document pack reviewed,
 *   5. completes the task and opens the next one (assignment stored once, here),
 *   6. writes audit events and outbox notifications.
 * See docs/WORKFLOW.md for the state map.
 */
import type { Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { config } from "../config";
import { decryptField, encryptField, hmac } from "../crypto";
import { DomainError, conflict, forbidden, gate, invalid, notFound } from "../errors";
import { last4 } from "../mask";
import { formatKobo } from "../money";
import { addDaysToDateString, isValidDateString, lagosDate, formatLagos } from "../time";
import { enqueueEmail } from "../notify/outbox";
import { simpleEmail, caseLink } from "../notify/templates";
import {
  BVN_RE,
  TIN_RE,
  assetCostKobo,
  displayCustomerName,
  draftDataSchema,
  materialDigest,
  validateForSubmission,
  type ApplicantType,
  type DraftData,
} from "./application-data";
import { type AppRow, chooseAssignee, openTask, type Chosen } from "./assignment";
import { holdsRole } from "./access";
import { latestAssessment } from "./assessment";
import { activeCalculator, calculatorUsableForApproval, findCalculator } from "./apr/registry";
import { currentCleanDocuments, PACK } from "./documents";
import { isInitiatorRole, type InitiatorRole } from "./roles";
import { routeForAmount } from "./routing";
import { pricingSettingsAt } from "./pricing";
import { CREDIT_APPROVAL_STAGES, REASON_REQUIRED, STAGE_LABELS, allowedActions, type Stage, type TaskAction } from "./stages";

export interface ActionResult {
  applicationId: string;
  stage: Stage;
  message: string;
  replayed?: boolean;
}

// ------------------------------------------------------------------ helpers

async function lockApp(tx: Tx, appId: string): Promise<AppRow> {
  const r = await tx.query<AppRow>("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [appId]);
  if (!r.rows[0]) throw notFound("Request not found.");
  return r.rows[0];
}

async function persistApp(tx: Tx, app: AppRow, now: Date) {
  await tx.query(
    `UPDATE applications SET stage=$2, status=$3, route=$4, current_version_id=$5, requested_amount_kobo=$6, customer_name=$7,
       selected_rbe_id=$8, endorser_id=$9, first_reviewer_id=$10, second_reviewer_id=$11, pack_co3_id=$12, do1_id=$13, do2_id=$14,
       active_correction_id=$15, customer_id=$16, lock_version = lock_version + 1, updated_at=$17
     WHERE id=$1`,
    [
      app.id, app.stage, app.status, app.route, app.current_version_id, app.requested_amount_kobo, app.customer_name,
      app.selected_rbe_id, app.endorser_id, app.first_reviewer_id, app.second_reviewer_id, app.pack_co3_id, app.do1_id, app.do2_id,
      app.active_correction_id, app.customer_id, now,
    ],
  );
}

function statusForStage(stage: Stage, current: string): AppRow["status"] {
  if (stage === "REJECTED") return "REJECTED";
  if (stage === "CLOSED") return "CLOSED";
  if (stage === "DRAFT") return "DRAFT";
  if (current === "BOOKED") return "BOOKED";
  return "IN_PROGRESS";
}

async function moveTo(tx: Tx, ctx: Ctx, app: AppRow, stage: Stage, chosen: Chosen | null, note?: string) {
  const from = app.stage;
  app.stage = stage;
  app.status = statusForStage(stage, app.status);
  await audit(tx, ctx, { action: "STAGE_CHANGED", applicationId: app.id, stage, details: { from, to: stage } });
  if (chosen) return openTask(tx, ctx, app, stage, chosen, note);
  return null;
}

async function idempotent(
  tx: Tx,
  ctx: Ctx,
  key: string,
  action: string,
  appId: string | null,
  fn: () => Promise<ActionResult>,
): Promise<ActionResult> {
  if (!key || key.length < 8 || key.length > 100) throw invalid("Missing or invalid idempotency key.");
  const ins = await tx.query(
    `INSERT INTO idempotency_keys (key, staff_id, action, application_id, created_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (key) DO NOTHING RETURNING key`,
    [key, ctx.actor!.staffId, action, appId, ctx.now],
  );
  if (!ins.rowCount) {
    const ex = (await tx.query("SELECT * FROM idempotency_keys WHERE key = $1", [key])).rows[0];
    if (!ex || ex.staff_id !== ctx.actor!.staffId || ex.action !== action) throw conflict("Duplicate request key.");
    if (!ex.result) throw conflict("This request is already being processed.");
    return { ...(ex.result as ActionResult), replayed: true };
  }
  const result = await fn();
  await tx.query("UPDATE idempotency_keys SET result = $2 WHERE key = $1", [key, JSON.stringify(result)]);
  return result;
}

async function recordDecision(tx: Tx, ctx: Ctx, app: AppRow, task: TaskRow, action: string, reason: string | null, assessmentId: string | null = null) {
  const docs = await currentCleanDocuments(tx, app.id);
  await tx.query(
    `INSERT INTO decisions (application_id, task_id, version_id, assessment_id, stage, actor_id, actor_role, action, reason, reviewed_documents, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      app.id, task.id, task.version_id ?? app.current_version_id, assessmentId, task.stage, ctx.actor!.staffId, task.assignee_role, action, reason,
      JSON.stringify(docs.map((d) => ({ id: d.id, category: d.category, version: d.version_no, filename: d.filename }))), ctx.now,
    ],
  );
}

async function completeTask(tx: Tx, ctx: Ctx, task: TaskRow, outcome: string, attestation: Record<string, unknown> = {}) {
  await tx.query(
    `UPDATE tasks SET status='COMPLETED', completed_at=$2, completed_by=$3, outcome=$4, attestation=$5 WHERE id=$1`,
    [task.id, ctx.now, ctx.actor!.staffId, outcome, JSON.stringify(attestation)],
  );
}

export interface TaskRow {
  id: string;
  application_id: string;
  stage: Stage;
  assignee_role: string;
  assignee_id: string | null;
  status: string;
  version_id: string | null;
  assigned_at: Date | null;
  entered_at: Date;
}

async function staffEmail(tx: Tx, id: string | null): Promise<string | null> {
  if (!id) return null;
  return (await tx.query<{ email: string }>("SELECT email FROM staff WHERE id = $1", [id])).rows[0]?.email ?? null;
}

function retentionDate(now: Date) {
  const d = lagosDate(now);
  const [y, m, day] = d.split("-");
  return `${Number(y) + config.retentionYears}-${m}-${day === "29" && m === "02" ? "28" : day}`;
}

// ------------------------------------------------------------------ drafts

export interface DirectorFormRow {
  id?: string | null; // existing director row id (to keep BVN when the field is left blank)
  fullName: string;
  bvn?: string | null;
}
export interface DraftInput {
  data: Partial<DraftData>;
  bvn?: string | null;
  tin?: string | null;
  directors?: DirectorFormRow[];
  expectedLockVersion?: number | null;
}

export async function createDraft(ctx: Ctx, p: { initiatorRole: string; applicantType: ApplicantType }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!isInitiatorRole(p.initiatorRole)) throw invalid("Choose RM, ANM or Merchant Officer as the initiating role.");
  if (!["INDIVIDUAL", "ENTERPRISE", "LIMITED"].includes(p.applicantType)) throw invalid("Choose Individual, Enterprise or Limited.");
  return withTx(async (tx) => {
    const ra = (
      await tx.query(
        `SELECT ra.region, ra.business_unit FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id
          WHERE ra.staff_id = $1 AND ra.role = $2 AND ra.active AND s.status = 'ACTIVE'`,
        [actor.staffId, p.initiatorRole],
      )
    ).rows[0];
    if (!ra) throw forbidden("You do not hold the selected initiator role.");
    const seq = (await tx.query<{ n: string }>("SELECT nextval('application_ref_seq') AS n")).rows[0].n;
    const ref = `WB-${lagosDate(ctx.now).slice(0, 4)}-${String(seq).padStart(6, "0")}`;
    const app = (
      await tx.query<{ id: string }>(
        `INSERT INTO applications (ref, applicant_type, initiator_id, initiator_role, region, business_unit, status, stage, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'DRAFT','DRAFT',$7,$7) RETURNING id`,
        [ref, p.applicantType, actor.staffId, p.initiatorRole, ra.region, ra.business_unit, ctx.now],
      )
    ).rows[0];
    await tx.query(
      `INSERT INTO application_versions (application_id, version_no, data, created_by, created_at) VALUES ($1,1,$2,$3,$4)`,
      [app.id, JSON.stringify(draftDataSchema.parse({})), actor.staffId, ctx.now],
    );
    await audit(tx, ctx, { action: "DRAFT_CREATED", actorRole: p.initiatorRole, applicationId: app.id, stage: "DRAFT", details: { ref, applicantType: p.applicantType } });
    return { id: app.id, ref };
  });
}

interface VersionRow {
  id: string;
  application_id: string;
  version_no: number;
  data: DraftData;
  bvn_enc: string | null;
  bvn_last4: string | null;
  tin_enc: string | null;
  tin_last4: string | null;
  requested_amount_kobo: string | null;
  material_digest: string | null;
  submitted_at: Date | null;
}

export async function workingVersion(tx: Tx, appId: string): Promise<VersionRow | null> {
  return (await tx.query<VersionRow>("SELECT * FROM application_versions WHERE application_id = $1 AND submitted_at IS NULL", [appId])).rows[0] ?? null;
}

/** Ensure a working (unsubmitted) version exists, cloning the current submitted version when correcting. */
async function ensureWorkingVersion(tx: Tx, ctx: Ctx, app: AppRow): Promise<VersionRow> {
  const w = await workingVersion(tx, app.id);
  if (w) return w;
  if (!app.current_version_id) throw new Error("No version to clone");
  const cur = (await tx.query<VersionRow>("SELECT * FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0];
  const ins = await tx.query<VersionRow>(
    `INSERT INTO application_versions (application_id, version_no, data, bvn_enc, bvn_last4, tin_enc, tin_last4, requested_amount_kobo, created_by, created_at)
     SELECT application_id, (SELECT max(version_no)+1 FROM application_versions WHERE application_id = $1), data, bvn_enc, bvn_last4, tin_enc, tin_last4,
            requested_amount_kobo, $3, $4 FROM application_versions WHERE id = $2 RETURNING *`,
    [app.id, cur.id, ctx.actor!.staffId, ctx.now],
  );
  await tx.query(
    `INSERT INTO application_directors (version_id, position, full_name, bvn_enc, bvn_last4)
     SELECT $2, position, full_name, bvn_enc, bvn_last4 FROM application_directors WHERE version_id = $1`,
    [cur.id, ins.rows[0].id],
  );
  return ins.rows[0];
}

async function assertCanEdit(tx: Tx, ctx: Ctx, app: AppRow) {
  const actor = ctx.actor!;
  if (app.initiator_id !== actor.staffId) throw forbidden("Only the initiator can edit this request.");
  if (!(await holdsRole(tx, actor.staffId, app.initiator_role))) throw forbidden("Your initiator role is no longer active.");
  if (app.stage === "DRAFT") return;
  if (app.stage === "INITIATOR_CORRECTION") {
    const t = (await tx.query("SELECT * FROM tasks WHERE application_id = $1 AND status = 'OPEN'", [app.id])).rows[0];
    if (t && t.assignee_id === actor.staffId) return;
  }
  throw forbidden("This request cannot be edited at its current stage.");
}

export async function saveDraft(ctx: Ctx, appId: string, input: DraftInput) {
  if (!ctx.actor) throw forbidden();
  return withTx(async (tx) => {
    const app = await lockApp(tx, appId);
    await assertCanEdit(tx, ctx, app);
    if (input.expectedLockVersion != null && input.expectedLockVersion !== app.lock_version) {
      throw conflict("This request was changed elsewhere. Reload and try again.");
    }
    const v = await ensureWorkingVersion(tx, ctx, app);
    const parsed = draftDataSchema.safeParse({ ...v.data, ...input.data });
    if (!parsed.success) throw invalid("Some fields are not valid.", Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message])));
    const data = parsed.data;
    const errors: Record<string, string> = {};
    let bvnEnc = v.bvn_enc;
    let bvnL4 = v.bvn_last4;
    let tinEnc = v.tin_enc;
    let tinL4 = v.tin_last4;
    if (input.bvn) {
      const b = input.bvn.replace(/\s/g, "");
      if (!BVN_RE.test(b)) errors.bvn = "BVN must be 11 digits.";
      else {
        bvnEnc = encryptField(b);
        bvnL4 = last4(b);
      }
    }
    if (input.tin) {
      const t = input.tin.replace(/\s/g, "");
      if (!TIN_RE.test(t)) errors.tin = "TIN must be 8–14 digits (optionally followed by -NNNN).";
      else {
        tinEnc = encryptField(t);
        tinL4 = last4(t);
      }
    }
    if (app.applicant_type === "LIMITED") {
      bvnEnc = null;
      bvnL4 = null;
    }
    if (app.applicant_type === "INDIVIDUAL" && input.tin === "") {
      tinEnc = null;
      tinL4 = null;
    }
    if (data.rbeId && app.initiator_role === "RM") {
      const ok = await holdsRole(tx, data.rbeId, "RBE");
      if (!ok) errors.rbeId = "Select an active Regional Business Executive.";
    }
    if (app.initiator_role !== "RM") data.rbeId = null;

    let directorRows: { full_name: string; bvn_enc: string; bvn_last4: string }[] | null = null;
    if (input.directors && app.applicant_type === "LIMITED") {
      const existing = (await tx.query("SELECT * FROM application_directors WHERE version_id = $1", [v.id])).rows;
      directorRows = [];
      input.directors.forEach((d, idx) => {
        const name = (d.fullName ?? "").trim();
        const bvn = (d.bvn ?? "").replace(/\s/g, "");
        if (!name && !bvn) return;
        if (!name) errors[`directors.${idx}.fullName`] = "Director name is required.";
        if (bvn) {
          if (!BVN_RE.test(bvn)) errors[`directors.${idx}.bvn`] = "Director BVN must be 11 digits.";
          else directorRows!.push({ full_name: name, bvn_enc: encryptField(bvn), bvn_last4: last4(bvn) });
        } else {
          const ex = existing.find((e: { id: string }) => e.id === d.id);
          if (ex) directorRows!.push({ full_name: name, bvn_enc: ex.bvn_enc, bvn_last4: ex.bvn_last4 });
          else errors[`directors.${idx}.bvn`] = "Director BVN is required.";
        }
      });
    }
    if (Object.keys(errors).length) throw invalid("Some fields are not valid.", errors);

    await tx.query(
      `UPDATE application_versions SET data=$2, bvn_enc=$3, bvn_last4=$4, tin_enc=$5, tin_last4=$6, requested_amount_kobo=$7 WHERE id=$1`,
      [v.id, JSON.stringify(data), bvnEnc, bvnL4, tinEnc, tinL4, data.requestedAmountKobo],
    );
    if (directorRows) {
      await tx.query("DELETE FROM application_directors WHERE version_id = $1", [v.id]);
      for (const [i, d] of directorRows.entries()) {
        await tx.query(`INSERT INTO application_directors (version_id, position, full_name, bvn_enc, bvn_last4) VALUES ($1,$2,$3,$4,$5)`, [v.id, i + 1, d.full_name, d.bvn_enc, d.bvn_last4]);
      }
    }
    if (app.stage === "DRAFT") {
      app.customer_name = displayCustomerName(app.applicant_type, data);
      app.requested_amount_kobo = data.requestedAmountKobo;
      app.selected_rbe_id = data.rbeId;
    }
    await persistApp(tx, app, ctx.now);
    await audit(tx, ctx, {
      action: "DRAFT_SAVED",
      actorRole: app.initiator_role,
      applicationId: app.id,
      stage: app.stage,
      details: { versionNo: v.version_no, bvnChanged: !!input.bvn, tinChanged: !!input.tin, directorCount: directorRows?.length ?? null },
    });
    return { versionId: v.id };
  });
}

/** Validate the working (or current) version for submission and finalise it. */
async function finaliseVersionForSubmission(tx: Tx, ctx: Ctx, app: AppRow): Promise<{ material: boolean; version: VersionRow }> {
  const working = await workingVersion(tx, app.id);
  const version = working ?? (await tx.query<VersionRow>("SELECT * FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0];
  const directors = (await tx.query("SELECT * FROM application_directors WHERE version_id = $1 ORDER BY position", [version.id])).rows;
  const docs = await currentCleanDocuments(tx, app.id);
  const errors = validateForSubmission({
    type: app.applicant_type,
    initiatorRole: app.initiator_role,
    data: version.data,
    hasBvn: !!version.bvn_enc,
    hasTin: !!version.tin_enc,
    directors: directors.map((d: { full_name: string; bvn_enc: string }) => ({ fullName: d.full_name, hasBvn: !!d.bvn_enc })),
    currentDocumentCategories: [...new Set(docs.map((d) => d.category))],
    now: ctx.now,
    maxTenorMonths: Math.min(6, (await pricingSettingsAt(tx, ctx.now)).maxTenorMonths),
  });
  if (version.data.requestedAmountKobo !== null && !errors.requestedAmountKobo) {
    try {
      routeForAmount(version.data.requestedAmountKobo);
    } catch (e) {
      if (e instanceof DomainError) errors.requestedAmountKobo = e.fields?.requestedAmountKobo ?? e.message;
    }
  }
  if (app.initiator_role === "RM" && version.data.rbeId) {
    if (!(await holdsRole(tx, version.data.rbeId, "RBE")) || version.data.rbeId === app.initiator_id) errors.rbeId = "Select an active Regional Business Executive.";
  }
  if (Object.keys(errors).length) throw invalid("The request is incomplete. Fix the highlighted items and submit again.", errors);

  const digest = materialDigest({
    type: app.applicant_type,
    data: version.data,
    bvnPlain: version.bvn_enc ? decryptField(version.bvn_enc) : null,
    tinPlain: version.tin_enc ? decryptField(version.tin_enc) : null,
    directors: directors.map((d: { full_name: string; bvn_enc: string }) => ({ fullName: d.full_name, bvnPlain: decryptField(d.bvn_enc) })),
  });
  let material = false;
  if (working) {
    if (app.current_version_id) {
      const prev = (await tx.query<{ material_digest: string }>("SELECT material_digest FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0];
      material = prev.material_digest !== digest;
    }
    await tx.query("UPDATE application_versions SET submitted_at = $2, material_digest = $3 WHERE id = $1", [working.id, ctx.now, digest]);
    app.current_version_id = working.id;
  }
  app.customer_name = displayCustomerName(app.applicant_type, version.data);
  app.requested_amount_kobo = version.data.requestedAmountKobo;
  app.selected_rbe_id = app.initiator_role === "RM" ? version.data.rbeId : null;

  // Customer record (per-customer audit trail): link repeat customers by identity hash.
  const identity =
    app.applicant_type === "LIMITED"
      ? `RC:${version.data.registrationNumber.toUpperCase()}`
      : version.bvn_enc
        ? `BVN:${decryptField(version.bvn_enc)}`
        : null;
  const identityHash = identity ? hmac(identity) : null;
  const cust = await tx.query<{ id: string }>(
    `INSERT INTO customers (applicant_type, display_name, identity_hash, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)
     ON CONFLICT (identity_hash) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at RETURNING id`,
    [app.applicant_type, app.customer_name, identityHash, ctx.now],
  );
  app.customer_id = cust.rows[0].id;
  return { material, version: working ?? version };
}

/** Initiator submits a draft for business endorsement. */
export async function submitApplication(ctx: Ctx, appId: string, idempotencyKey: string): Promise<ActionResult> {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) =>
    idempotent(tx, ctx, idempotencyKey, "SUBMIT", appId, async () => {
      const app = await lockApp(tx, appId);
      if (app.initiator_id !== actor.staffId) throw forbidden("Only the initiator can submit this request.");
      if (app.stage !== "DRAFT") throw conflict("This request has already been submitted.");
      if (!(await holdsRole(tx, actor.staffId, app.initiator_role))) throw forbidden("Your initiator role is no longer active.");
      await finaliseVersionForSubmission(tx, ctx, app);
      (app as { submitted_at: Date | null }).submitted_at = ctx.now;
      await tx.query("UPDATE applications SET submitted_at = $2 WHERE id = $1", [app.id, ctx.now]);
      await audit(tx, ctx, { action: "REQUEST_SUBMITTED", actorRole: app.initiator_role, applicationId: app.id, customerId: app.customer_id, stage: "DRAFT", details: { versionId: app.current_version_id } });
      const chosen = await chooseAssignee(tx, app, "BUSINESS_ENDORSEMENT", {
        preferred: app.initiator_role === "RM" ? app.selected_rbe_id : null,
        requirePreferred: app.initiator_role === "RM",
      });
      await moveTo(tx, ctx, app, "BUSINESS_ENDORSEMENT", chosen);
      await persistApp(tx, app, ctx.now);
      return { applicationId: app.id, stage: app.stage, message: "Request submitted for business endorsement." };
    }),
  );
}

// ------------------------------------------------------------------ task actions

export interface BookingInput {
  amountKobo: number;
  disbursedOn: string; // YYYY-MM-DD
  transactionRef: string;
  schedule: { dueDate: string; amountKobo: number }[];
}

export interface TaskActionInput {
  taskId: string;
  action: TaskAction;
  reason?: string | null;
  idempotencyKey: string;
  expectedLockVersion?: number | null;
  invoiceLogged?: boolean;
  invoiceDialogConfirmed?: boolean;
  crmsLogged?: boolean;
  booking?: BookingInput;
}

export async function performTaskAction(ctx: Ctx, input: TaskActionInput): Promise<ActionResult> {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  try {
    return await withTx(async (tx) => {
      const t0 = (await tx.query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [input.taskId])).rows[0];
      if (!t0) throw notFound("Task not found.");
      return idempotent(tx, ctx, input.idempotencyKey, `TASK:${input.action}`, t0.application_id, async () => {
        const app = await lockApp(tx, t0.application_id);
        const task = (await tx.query<TaskRow>("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [input.taskId])).rows[0];
        if (task.status !== "OPEN") throw conflict("This task has already been actioned and is no longer in your queue.");
        if (task.assignee_id !== actor.staffId) throw forbidden("This task is not assigned to you.");
        if (!(await holdsRole(tx, actor.staffId, task.assignee_role))) throw forbidden("Your role assignment for this task is no longer active.");
        if (input.expectedLockVersion != null && input.expectedLockVersion !== app.lock_version) {
          throw conflict("This request changed since you opened it. Reload to see the latest version.");
        }
        if (!allowedActions(task.stage, app.route).includes(input.action)) {
          throw invalid(`"${input.action}" is not available at ${STAGE_LABELS[task.stage]}.`);
        }
        const reason = (input.reason ?? "").trim() || null;
        if (REASON_REQUIRED.includes(input.action) && (!reason || reason.length < 3)) {
          throw invalid("A reason is required for this action.", { reason: "Enter a reason." });
        }
        ctx.actor = { ...actor, activeRole: task.assignee_role };
        const message = await dispatch(tx, ctx, app, task, input, reason);
        await persistApp(tx, app, ctx.now);
        await audit(tx, ctx, {
          action: `TASK_${input.action}`,
          actorRole: task.assignee_role,
          applicationId: app.id,
          stage: task.stage,
          reason,
          assignmentFrom: actor.staffId,
          details: { taskId: task.id, nextStage: app.stage, versionId: task.version_id },
        });
        return { applicationId: app.id, stage: app.stage, message };
      });
    });
  } catch (e) {
    if (e instanceof DomainError && (e.code === "FORBIDDEN" || e.code === "GATE")) {
      await auditOutsideTx(ctx, { action: `TASK_${input.action}`, outcome: e.code === "FORBIDDEN" ? "DENIED" : "FAILURE", reason: e.message, details: { taskId: input.taskId } });
    }
    throw e;
  }
}

async function dispatch(tx: Tx, ctx: Ctx, app: AppRow, task: TaskRow, input: TaskActionInput, reason: string | null): Promise<string> {
  const a = input.action;
  if (a === "REJECT") return reject(tx, ctx, app, task, reason!);

  switch (task.stage) {
    case "BUSINESS_ENDORSEMENT": {
      if (a === "RETURN") return returnToInitiator(tx, ctx, app, task, reason!);
      const route = routeForAmount(Number(app.requested_amount_kobo));
      await recordDecision(tx, ctx, app, task, a, reason);
      await completeTask(tx, ctx, task, a);
      app.endorser_id = ctx.actor!.staffId;
      if (app.route !== route.route) {
        app.route = route.route;
        app.first_reviewer_id = null;
        app.second_reviewer_id = null;
      }
      const chosen = await chooseAssignee(tx, app, "FIRST_CREDIT_REVIEW", { preferred: app.first_reviewer_id });
      app.first_reviewer_id = chosen.staffId;
      await moveTo(tx, ctx, app, "FIRST_CREDIT_REVIEW", chosen);
      return `Endorsed. Routed to first credit review (Route ${route.route}).`;
    }
    case "FIRST_CREDIT_REVIEW": {
      if (a === "RETURN") return returnToInitiator(tx, ctx, app, task, reason!);
      // Server-side gates: three credit reports, valid assessment, invoice logged + dialog acknowledged.
      const docs = await currentCleanDocuments(tx, app.id);
      const reports = docs.filter((d) => d.category === "CREDIT_REPORT");
      if (reports.length < 3) throw gate(`Upload three credit reports before approval (currently ${reports.length}).`);
      const assessment = await latestAssessment(tx, app.id);
      if (!assessment || assessment.version_id !== app.current_version_id) throw gate("Complete the APR calculation with DSR for the current version before approval.");
      const calc = findCalculator(`${assessment.calculator_id}@${assessment.calculator_version}`);
      if (!calc || !calculatorUsableForApproval(calc) || (config.isProduction && !assessment.production_validated)) {
        throw gate("Credit approval is blocked: the bank's APR workbook rules are not configured and validated for production.");
      }
      if (calc.usesPricingSettings) {
        const current = await pricingSettingsAt(tx, ctx.now);
        const used = (assessment.outputs as { pricing?: { settings?: { id: string; version: number } } }).pricing?.settings;
        if (!used || used.id !== current.id) {
          throw gate(`WakeelBoost pricing settings changed since this assessment (v${used?.version ?? "?"} → v${current.version}). Recalculate the assessment under the current settings before approval.`);
        }
      }
      if (!input.invoiceLogged) throw gate('Confirm "Logged invoice on invoice portal" before approval.');
      if (!input.invoiceDialogConfirmed) throw gate('Confirm the "Do not forget to log invoice" reminder before approval.');
      await recordDecision(tx, ctx, app, task, a, reason, assessment.id);
      await completeTask(tx, ctx, task, a, { invoiceLogged: true, invoiceDialogConfirmed: true, attestedAt: ctx.now.toISOString(), assessmentId: assessment.id });
      const chosen = await chooseAssignee(tx, app, "SECOND_CREDIT_REVIEW", { preferred: app.second_reviewer_id, random: true });
      app.second_reviewer_id = chosen.staffId;
      await moveTo(tx, ctx, app, "SECOND_CREDIT_REVIEW", chosen);
      return "Approved. Assigned for second credit review.";
    }
    case "SECOND_CREDIT_REVIEW":
    case "UNIT_HEAD_REVIEW":
    case "DIVISIONAL_HEAD_REVIEW": {
      if (a === "RETURN") return creditCorrection(tx, ctx, app, task, reason!);
      const assessment = await latestAssessment(tx, app.id);
      await recordDecision(tx, ctx, app, task, a, reason, assessment?.id ?? null);
      await completeTask(tx, ctx, task, a);
      const next: Stage = task.stage === "SECOND_CREDIT_REVIEW" ? "UNIT_HEAD_REVIEW" : task.stage === "UNIT_HEAD_REVIEW" ? "DIVISIONAL_HEAD_REVIEW" : "OFFER_PREPARATION";
      const chosen = await chooseAssignee(tx, app, next, {});
      await moveTo(tx, ctx, app, next, chosen);
      return next === "OFFER_PREPARATION" ? "Approved. The initiator has been assigned to prepare the signed offer pack." : `Approved. Sent to ${STAGE_LABELS[next]}.`;
    }
    case "CREDIT_CORRECTION": {
      if (a === "REQUEST_INITIATOR") return returnToInitiator(tx, ctx, app, task, reason!);
      const corr = await activeCorrection(tx, app, "CREDIT_CORRECTION");
      await recordDecision(tx, ctx, app, task, a, reason);
      await completeTask(tx, ctx, task, a);
      const assessment = await latestAssessment(tx, app.id);
      const reports = (await currentCleanDocuments(tx, app.id)).filter((d) => d.category === "CREDIT_REPORT").map((d) => d.id).sort();
      const reassessed = (assessment?.id ?? null) !== corr.baseline_assessment_id || JSON.stringify(reports) !== JSON.stringify([...(corr.baseline_reports ?? [])].sort());
      if (reassessed) {
        await invalidateCreditApprovals(tx, ctx, app, "Credit assessment or credit reports changed during correction");
        await resolveAllCorrections(tx, ctx, app, "REASSESSED");
        const chosen = await chooseAssignee(tx, app, "FIRST_CREDIT_REVIEW", { preferred: ctx.actor!.staffId });
        await moveTo(tx, ctx, app, "FIRST_CREDIT_REVIEW", chosen, "Re-review after reassessment");
        return "Underwriting changed: returned to first credit review for fresh approval.";
      }
      await resolveCorrection(tx, ctx, corr.id, "RESUBMITTED");
      app.active_correction_id = corr.parent_id;
      const chosen = await chooseAssignee(tx, app, corr.from_stage, { preferred: corr.from_assignee_id, requirePreferred: corr.from_stage === "SECOND_CREDIT_REVIEW" });
      await moveTo(tx, ctx, app, corr.from_stage, chosen, "Returned after correction");
      return `Correction resolved. Returned to ${STAGE_LABELS[corr.from_stage]}.`;
    }
    case "INITIATOR_CORRECTION":
      return resubmitByInitiator(tx, ctx, app, task);
    case "OFFER_PREPARATION": {
      const docs = await currentCleanDocuments(tx, app.id);
      const cats = new Set(docs.map((d) => d.category));
      const missing = ["GENERATED_OFFER", ...PACK].filter((c) => !cats.has(c));
      if (missing.length) throw gate(`The offer pack is incomplete. Missing: ${missing.map((m) => m.replace(/_/g, " ").toLowerCase()).join(", ")}.`);
      await recordDecision(tx, ctx, app, task, a, reason);
      await completeTask(tx, ctx, task, a);
      if (app.active_correction_id) {
        await resolveCorrection(tx, ctx, app.active_correction_id, "RESUBMITTED");
        app.active_correction_id = null;
      }
      const co3Pref = app.pack_co3_id ?? (await involvedCo3(tx, app));
      const chosen = await chooseAssignee(tx, app, "CO3_PACK_REVIEW", { preferred: co3Pref });
      app.pack_co3_id = chosen.staffId;
      await moveTo(tx, ctx, app, "CO3_PACK_REVIEW", chosen);
      return "Offer pack submitted to Credit Officer 3.";
    }
    case "CO3_PACK_REVIEW": {
      if (a === "RETURN") {
        await createCorrection(tx, ctx, app, task, "OFFER_PREPARATION", reason!, null);
        await recordDecision(tx, ctx, app, task, a, reason);
        await completeTask(tx, ctx, task, a);
        const chosen = await chooseAssignee(tx, app, "OFFER_PREPARATION");
        await moveTo(tx, ctx, app, "OFFER_PREPARATION", chosen, reason ?? undefined);
        return "Pack returned to the initiator for correction.";
      }
      const evidence = (await currentCleanDocuments(tx, app.id)).filter((d) => d.category === "INSURANCE_EVIDENCE" && d.uploaded_role === "CREDIT_OFFICER_3");
      if (!evidence.length) throw gate("Upload separate evidence of insurance before forwarding the pack.");
      await recordDecision(tx, ctx, app, task, a, reason);
      await completeTask(tx, ctx, task, a);
      const chosen = await chooseAssignee(tx, app, "DISBURSEMENT_CHECK", { preferred: app.do1_id });
      app.do1_id = chosen.staffId;
      await moveTo(tx, ctx, app, "DISBURSEMENT_CHECK", chosen);
      return "Pack forwarded to Disbursement Officer 1.";
    }
    case "DISBURSEMENT_CHECK": {
      if (a === "SEND_FOR_CORRECTION") {
        await createCorrection(tx, ctx, app, task, "DISBURSEMENT_CORRECTION", reason!, null);
        await recordDecision(tx, ctx, app, task, a, reason);
        await completeTask(tx, ctx, task, a);
        const chosen = await chooseAssignee(tx, app, "DISBURSEMENT_CORRECTION", { preferred: app.pack_co3_id });
        app.pack_co3_id = chosen.staffId ?? app.pack_co3_id;
        await moveTo(tx, ctx, app, "DISBURSEMENT_CORRECTION", chosen, reason ?? undefined);
        return "Sent back to Credit Officer 3 for correction.";
      }
      if (!input.crmsLogged) throw gate('Toggle "Logged CRMS" before selecting Okay.');
      await recordDecision(tx, ctx, app, task, a, reason);
      await completeTask(tx, ctx, task, a, { crmsLogged: true, attestedAt: ctx.now.toISOString() });
      const chosen = await chooseAssignee(tx, app, "DISBURSEMENT_BOOKING", { preferred: app.do2_id });
      app.do2_id = chosen.staffId;
      await moveTo(tx, ctx, app, "DISBURSEMENT_BOOKING", chosen);
      return "Documents checked. Sent to Disbursement Officer 2.";
    }
    case "DISBURSEMENT_CORRECTION": {
      if (app.active_correction_id) {
        await resolveCorrection(tx, ctx, app.active_correction_id, "RESUBMITTED");
        app.active_correction_id = null;
      }
      await recordDecision(tx, ctx, app, task, a, reason);
      await completeTask(tx, ctx, task, a);
      const chosen = await chooseAssignee(tx, app, "DISBURSEMENT_CHECK", { preferred: app.do1_id, requirePreferred: true });
      await moveTo(tx, ctx, app, "DISBURSEMENT_CHECK", chosen);
      return "Correction resolved. Resubmitted to Disbursement Officer 1.";
    }
    case "DISBURSEMENT_BOOKING":
      return book(tx, ctx, app, task, input.booking);
    case "COMPLETION":
      return completeProcess(tx, ctx, app, task);
    case "VENDOR_CONFIRMATION": {
      const st = (await tx.query("SELECT process_completed_at FROM applications WHERE id = $1", [app.id])).rows[0];
      if (!st.process_completed_at) throw gate("Credit Officer 3 must complete the process first.");
      await recordDecision(tx, ctx, app, task, a, reason);
      await completeTask(tx, ctx, task, a);
      await tx.query(
        `UPDATE applications SET vendor_confirmed_at=$2, vendor_confirmed_by=$3, repayment_prompts_active_at=$2, closed_at=$2, retention_until=$4 WHERE id=$1`,
        [app.id, ctx.now, ctx.actor!.staffId, retentionDate(ctx.now)],
      );
      app.status = "CLOSED";
      await moveTo(tx, ctx, app, "CLOSED", null);
      await audit(tx, ctx, { action: "REPAYMENT_PROMPTS_ACTIVATED", applicationId: app.id, stage: "CLOSED" });
      return "Vendor payment confirmed. The request is closed and repayment prompts are active.";
    }
    default:
      throw invalid("No action is available at this stage.");
  }
}

async function involvedCo3(tx: Tx, app: AppRow): Promise<string | null> {
  for (const id of [app.first_reviewer_id, app.second_reviewer_id]) {
    if (id && (await holdsRole(tx, id, "CREDIT_OFFICER_3"))) return id;
  }
  return null;
}

async function reject(tx: Tx, ctx: Ctx, app: AppRow, task: TaskRow, reason: string): Promise<string> {
  await recordDecision(tx, ctx, app, task, "REJECT", reason);
  await completeTask(tx, ctx, task, "REJECT");
  await resolveAllCorrections(tx, ctx, app, "CASE_REJECTED");
  await tx.query("UPDATE applications SET rejected_at=$2, retention_until=$3 WHERE id=$1", [app.id, ctx.now, retentionDate(ctx.now)]);
  await moveTo(tx, ctx, app, "REJECTED", null);
  const email = await staffEmail(tx, app.initiator_id);
  if (email) {
    await enqueueEmail(tx, ctx.now, {
      kind: "REJECTION",
      dedupeKey: `reject:${app.id}`,
      applicationId: app.id,
      to: [email],
      subject: `WakeelBoost ${app.ref}: request rejected`,
      text: simpleEmail([
        `Request ${app.ref} (${app.customer_name}) was rejected at ${STAGE_LABELS[task.stage]}.`,
        `Reason: ${reason}`,
        `Decision time: ${formatLagos(ctx.now)}`,
        "",
        `View the request: ${caseLink(app.id)}`,
      ]),
    });
  }
  return "Request rejected. The initiator has been notified.";
}

interface CorrectionRow {
  id: string;
  parent_id: string | null;
  from_stage: Stage;
  from_assignee_id: string | null;
  to_stage: Stage;
  baseline_assessment_id: string | null;
  baseline_reports: string[];
}

async function createCorrection(tx: Tx, ctx: Ctx, app: AppRow, task: TaskRow, toStage: Stage, reason: string, parentId: string | null) {
  const assessment = await latestAssessment(tx, app.id);
  const reports = (await currentCleanDocuments(tx, app.id)).filter((d) => d.category === "CREDIT_REPORT").map((d) => d.id).sort();
  const r = await tx.query<{ id: string }>(
    `INSERT INTO corrections (application_id, parent_id, from_stage, from_assignee_id, from_role, to_stage, reason, requested_by,
       baseline_version_id, baseline_assessment_id, baseline_reports, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [app.id, parentId, task.stage, ctx.actor!.staffId, task.assignee_role, toStage, reason, ctx.actor!.staffId, app.current_version_id, assessment?.id ?? null, JSON.stringify(reports), ctx.now],
  );
  app.active_correction_id = r.rows[0].id;
  await audit(tx, ctx, { action: "CORRECTION_REQUESTED", applicationId: app.id, stage: task.stage, reason, details: { correctionId: r.rows[0].id, toStage } });
  return r.rows[0].id;
}

async function activeCorrection(tx: Tx, app: AppRow, toStage: Stage): Promise<CorrectionRow> {
  if (!app.active_correction_id) throw conflict("No open correction was found for this request.");
  const c = (await tx.query<CorrectionRow>("SELECT * FROM corrections WHERE id = $1", [app.active_correction_id])).rows[0];
  if (!c || c.to_stage !== toStage) throw conflict("The open correction does not match this stage.");
  return c;
}

async function resolveCorrection(tx: Tx, ctx: Ctx, id: string, resolution: string) {
  await tx.query("UPDATE corrections SET resolved_at=$2, resolution=$3 WHERE id=$1 AND resolved_at IS NULL", [id, ctx.now, resolution]);
}
async function resolveAllCorrections(tx: Tx, ctx: Ctx, app: AppRow, resolution: string) {
  await tx.query("UPDATE corrections SET resolved_at=$2, resolution=$3 WHERE application_id=$1 AND resolved_at IS NULL", [app.id, ctx.now, resolution]);
  app.active_correction_id = null;
}

/** Return to the initiator: from business endorsement, first credit review or (via the first reviewer) a later credit stage. */
async function returnToInitiator(tx: Tx, ctx: Ctx, app: AppRow, task: TaskRow, reason: string): Promise<string> {
  const parent = task.stage === "CREDIT_CORRECTION" ? app.active_correction_id : null;
  await createCorrection(tx, ctx, app, task, "INITIATOR_CORRECTION", reason, parent);
  await recordDecision(tx, ctx, app, task, task.stage === "CREDIT_CORRECTION" ? "REQUEST_INITIATOR" : "RETURN", reason);
  await completeTask(tx, ctx, task, task.stage === "CREDIT_CORRECTION" ? "REQUEST_INITIATOR" : "RETURN");
  const chosen = await chooseAssignee(tx, app, "INITIATOR_CORRECTION");
  await moveTo(tx, ctx, app, "INITIATOR_CORRECTION", chosen, reason);
  return "Returned to the initiator for correction.";
}

/** A later credit correction returns to the assigned first credit reviewer. */
async function creditCorrection(tx: Tx, ctx: Ctx, app: AppRow, task: TaskRow, reason: string): Promise<string> {
  await createCorrection(tx, ctx, app, task, "CREDIT_CORRECTION", reason, app.active_correction_id);
  await recordDecision(tx, ctx, app, task, "RETURN", reason);
  await completeTask(tx, ctx, task, "RETURN");
  const chosen = await chooseAssignee(tx, app, "CREDIT_CORRECTION", { preferred: app.first_reviewer_id, requirePreferred: true });
  await moveTo(tx, ctx, app, "CREDIT_CORRECTION", chosen, reason);
  return "Returned to the first credit reviewer for correction.";
}

async function invalidateCreditApprovals(tx: Tx, ctx: Ctx, app: AppRow, why: string) {
  const r = await tx.query(
    `UPDATE decisions SET invalidated_at=$2, invalidated_reason=$3
      WHERE application_id=$1 AND invalidated_at IS NULL AND action IN ('APPROVE','PROCEED') AND stage = ANY($4::text[])`,
    [app.id, ctx.now, why, CREDIT_APPROVAL_STAGES],
  );
  await audit(tx, ctx, { action: "APPROVALS_INVALIDATED", applicationId: app.id, stage: app.stage, reason: why, details: { count: r.rowCount } });
}

async function resubmitByInitiator(tx: Tx, ctx: Ctx, app: AppRow, task: TaskRow): Promise<string> {
  const corr = await activeCorrection(tx, app, "INITIATOR_CORRECTION");
  const prevRoute = app.route;
  const { material } = await finaliseVersionForSubmission(tx, ctx, app);
  await recordDecision(tx, ctx, app, task, "RESUBMIT", null);
  await completeTask(tx, ctx, task, "RESUBMIT", { material });
  await audit(tx, ctx, { action: "REQUEST_RESUBMITTED", applicationId: app.id, stage: task.stage, details: { material, versionId: app.current_version_id } });

  if (corr.from_stage === "BUSINESS_ENDORSEMENT") {
    await resolveCorrection(tx, ctx, corr.id, "RESUBMITTED");
    app.active_correction_id = null;
    const chosen = await chooseAssignee(tx, app, "BUSINESS_ENDORSEMENT", {
      preferred: app.initiator_role === "RM" ? app.selected_rbe_id : corr.from_assignee_id,
      requirePreferred: app.initiator_role === "RM",
    });
    await moveTo(tx, ctx, app, "BUSINESS_ENDORSEMENT", chosen, "Resubmitted after correction");
    return "Resubmitted to business endorsement.";
  }
  if (material) {
    await invalidateCreditApprovals(tx, ctx, app, "Material underwriting fields changed on resubmission");
    await tx.query("UPDATE credit_assessments SET superseded_at=$2 WHERE application_id=$1 AND superseded_at IS NULL", [app.id, ctx.now]);
    await resolveAllCorrections(tx, ctx, app, "SUPERSEDED_BY_MATERIAL_CHANGE");
    const route = routeForAmount(Number(app.requested_amount_kobo));
    if (route.route !== prevRoute) {
      await audit(tx, ctx, { action: "ROUTE_RECALCULATED", applicationId: app.id, stage: "FIRST_CREDIT_REVIEW", details: { from: prevRoute, to: route.route } });
      app.route = route.route;
      app.first_reviewer_id = null;
      app.second_reviewer_id = null;
    }
    const chosen = await chooseAssignee(tx, app, "FIRST_CREDIT_REVIEW", { preferred: app.first_reviewer_id });
    app.first_reviewer_id = chosen.staffId;
    await moveTo(tx, ctx, app, "FIRST_CREDIT_REVIEW", chosen, "Fresh credit review: material change");
    return `Material change detected: fresh credit review required (Route ${route.route}).`;
  }
  await resolveCorrection(tx, ctx, corr.id, "RESUBMITTED");
  app.active_correction_id = corr.parent_id;
  const chosen = await chooseAssignee(tx, app, corr.from_stage, { preferred: corr.from_assignee_id, requirePreferred: true });
  await moveTo(tx, ctx, app, corr.from_stage, chosen, "Resubmitted after correction (non-material)");
  return `Resubmitted to ${STAGE_LABELS[corr.from_stage]}.`;
}

export function validateBooking(b: BookingInput | undefined, approvedKobo: number): BookingInput {
  const errors: Record<string, string> = {};
  if (!b) throw invalid("Enter the disbursement details.");
  if (!Number.isSafeInteger(b.amountKobo) || b.amountKobo <= 0) errors.amount = "Enter the disbursed amount.";
  else if (b.amountKobo > approvedKobo) errors.amount = `Disbursed amount cannot exceed the approved amount (${formatKobo(approvedKobo)}).`;
  if (!isValidDateString(b.disbursedOn)) errors.disbursedOn = "Enter the disbursement date.";
  const ref = (b.transactionRef ?? "").trim();
  if (!/^[A-Za-z0-9\-/_.]{4,64}$/.test(ref)) errors.transactionRef = "Enter the transaction reference (4–64 letters, digits or - / _ .).";
  if (!b.schedule?.length) errors.schedule = "Enter the repayment date or instalment schedule.";
  else {
    let prev = b.disbursedOn;
    b.schedule.forEach((s, i) => {
      if (!isValidDateString(s.dueDate)) errors[`schedule.${i}.dueDate`] = "Enter a valid due date.";
      else if (isValidDateString(prev) && s.dueDate <= prev) errors[`schedule.${i}.dueDate`] = "Due dates must be after the disbursement date and in order.";
      else prev = s.dueDate;
      if (!Number.isSafeInteger(s.amountKobo) || s.amountKobo <= 0) errors[`schedule.${i}.amount`] = "Enter the instalment amount.";
    });
  }
  if (Object.keys(errors).length) throw invalid("Check the disbursement details.", errors);
  return { ...b, transactionRef: ref };
}

async function book(tx: Tx, ctx: Ctx, app: AppRow, task: TaskRow, booking: BookingInput | undefined): Promise<string> {
  const existing = await tx.query("SELECT 1 FROM disbursements WHERE application_id = $1", [app.id]);
  if (existing.rowCount) throw conflict("This request has already been disbursed.");
  const approved = Number(app.requested_amount_kobo);
  const b = validateBooking(booking, approved);
  const dup = await tx.query("SELECT 1 FROM disbursements WHERE transaction_ref = $1", [b.transactionRef]);
  if (dup.rowCount) throw conflict("This transaction reference is already recorded against another booking.");
  await recordDecision(tx, ctx, app, task, "DISBURSED", null);
  await completeTask(tx, ctx, task, "DISBURSED", { transactionRef: b.transactionRef });
  const d = await tx.query<{ id: string }>(
    `INSERT INTO disbursements (application_id, amount_kobo, approved_amount_kobo, disbursed_on, transaction_ref, recorded_by, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [app.id, b.amountKobo, approved, b.disbursedOn, b.transactionRef, ctx.actor!.staffId, ctx.now],
  );
  for (const [i, s] of b.schedule.entries()) {
    await tx.query(`INSERT INTO repayment_instalments (application_id, disbursement_id, seq, due_date, amount_kobo) VALUES ($1,$2,$3,$4,$5)`, [app.id, d.rows[0].id, i + 1, s.dueDate, s.amountKobo]);
  }
  await tx.query("UPDATE applications SET disbursed_at = $2 WHERE id = $1", [app.id, ctx.now]);
  app.status = "BOOKED";
  await audit(tx, ctx, {
    action: "DISBURSEMENT_RECORDED",
    applicationId: app.id,
    stage: task.stage,
    details: { amountKobo: b.amountKobo, disbursedOn: b.disbursedOn, transactionRef: b.transactionRef, instalments: b.schedule.length, note: "Recorded attestation; no funds transfer is triggered by this system." },
  });
  const recipients = [await staffEmail(tx, app.pack_co3_id), await staffEmail(tx, app.initiator_id)].filter((x): x is string => !!x);
  await enqueueEmail(tx, ctx.now, {
    kind: "DISBURSED",
    dedupeKey: `disbursed:${app.id}`,
    applicationId: app.id,
    to: recipients,
    subject: `WakeelBoost ${app.ref}: disbursed`,
    text: simpleEmail([
      `Request ${app.ref} (${app.customer_name}) has been booked as disbursed.`,
      `Amount: ${formatKobo(b.amountKobo)}`,
      `Disbursement date: ${b.disbursedOn}`,
      `Transaction reference: ${b.transactionRef}`,
      `Repayments: ${b.schedule.map((s) => `${s.dueDate} ${formatKobo(s.amountKobo)}`).join("; ")}`,
      "",
      `Next: Credit Officer 3 completes the process. ${caseLink(app.id)}`,
    ]),
  });
  const chosen = await chooseAssignee(tx, app, "COMPLETION", { preferred: app.pack_co3_id });
  await moveTo(tx, ctx, app, "COMPLETION", chosen);
  return "Disbursement recorded. Credit Officer 3 and the initiator have been notified.";
}

async function completeProcess(tx: Tx, ctx: Ctx, app: AppRow, task: TaskRow): Promise<string> {
  const members = (await tx.query<{ group_code: string; email: string }>("SELECT group_code, email FROM recipient_group_members ORDER BY group_code, email")).rows;
  const legal = members.filter((m) => m.group_code === "LEGAL").map((m) => m.email);
  const shariah = members.filter((m) => m.group_code === "SHARIAH").map((m) => m.email);
  if (!legal.length || !shariah.length) throw gate("Legal and Shariah Compliance recipient groups must be configured by the Super Admin before completing the process.");
  const already = await tx.query("SELECT 1 FROM closure_events WHERE application_id = $1", [app.id]);
  if (already.rowCount) throw conflict("The process has already been completed for this request.");
  await recordDecision(tx, ctx, app, task, "COMPLETE_PROCESS", null);
  await completeTask(tx, ctx, task, "COMPLETE_PROCESS");
  await tx.query("UPDATE applications SET process_completed_at=$2, process_completed_by=$3 WHERE id=$1", [app.id, ctx.now, ctx.actor!.staffId]);

  const docs = await currentCleanDocuments(tx, app.id);
  const total = docs.reduce((s, d) => s + Number(d.size_bytes), 0);
  const mode = total <= config.closureMaxAttachmentBytes ? "ATTACHMENTS" : "SECURE_LINK";
  const disb = (await tx.query("SELECT * FROM disbursements WHERE application_id = $1", [app.id])).rows[0];
  const inst = (await tx.query("SELECT * FROM repayment_instalments WHERE application_id = $1 ORDER BY seq", [app.id])).rows;
  const assessment = await latestAssessment(tx, app.id);
  const ce = await tx.query<{ id: string }>(
    `INSERT INTO closure_events (application_id, completed_by, completed_at, delivery_mode, groups, document_ids) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [app.id, ctx.actor!.staffId, ctx.now, mode, ["LEGAL", "SHARIAH"], docs.map((d) => d.id)],
  );
  const initiatorEmail = await staffEmail(tx, app.initiator_id);
  const out = await enqueueEmail(tx, ctx.now, {
    kind: "CLOSURE_PACK",
    dedupeKey: `closure:${app.id}`,
    applicationId: app.id,
    to: [...legal, ...shariah],
    cc: initiatorEmail ? [initiatorEmail] : [],
    subject: `WakeelBoost ${app.ref}: closure pack and transaction summary`,
    text: simpleEmail([
      `Closure pack for request ${app.ref}.`,
      "",
      "Transaction summary",
      `Customer: ${app.customer_name}`,
      `Applicant type: ${app.applicant_type}`,
      `Approved amount: ${formatKobo(Number(app.requested_amount_kobo))}`,
      `Disbursed amount: ${formatKobo(Number(disb.amount_kobo))} on ${String(disb.disbursed_on instanceof Date ? lagosDate(disb.disbursed_on) : disb.disbursed_on).slice(0, 10)}`,
      `Transaction reference: ${disb.transaction_ref}`,
      `APR: ${assessment?.apr_percent ?? "—"}%   DSR: ${assessment?.dsr_percent ?? "—"}%`,
      `Repayment schedule: ${inst.map((i: { due_date: Date | string; amount_kobo: string }) => `${typeof i.due_date === "string" ? i.due_date : lagosDate(i.due_date)} ${formatKobo(Number(i.amount_kobo))}`).join("; ")}`,
      `Process completed: ${formatLagos(ctx.now)}`,
      "",
      `Document pack (${docs.length} files, ${(total / 1048576).toFixed(2)} MB): ${mode === "ATTACHMENTS" ? "attached" : "too large to attach - use the authenticated link"}`,
      ...docs.map((d) => `  - ${d.category} v${d.version_no}: ${d.filename}`),
      "",
      `Restricted authenticated access to the full pack: ${caseLink(app.id)}`,
    ]),
    attachmentDocumentIds: mode === "ATTACHMENTS" ? docs.map((d) => d.id) : [],
  });
  await tx.query("UPDATE closure_events SET outbox_id = $2 WHERE id = $1", [ce.rows[0].id, out.id]);
  await audit(tx, ctx, { action: "CLOSURE_PACK_QUEUED", applicationId: app.id, stage: task.stage, details: { mode, documents: docs.length, groups: ["LEGAL", "SHARIAH"], outboxId: out.id } });
  const chosen = await chooseAssignee(tx, app, "VENDOR_CONFIRMATION");
  await moveTo(tx, ctx, app, "VENDOR_CONFIRMATION", chosen);
  return "Process completed. Closure pack queued to Legal and Shariah Compliance (initiator copied).";
}

// ------------------------------------------------------------------ reminders

export const REMINDER_MIN_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Initiator reminder: only when the current assignment is older than six hours (rechecked here),
 * at most once per six hours per assignment, and deduplicated by idempotency key.
 */
export async function sendReminder(ctx: Ctx, appId: string, idempotencyKey: string): Promise<ActionResult> {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  try {
    return await withTx(async (tx) =>
      idempotent(tx, ctx, idempotencyKey, "REMINDER", appId, async () => {
        const app = await lockApp(tx, appId);
        if (app.initiator_id !== actor.staffId) throw forbidden("Only the initiator can send reminders.");
        const task = (await tx.query<TaskRow>("SELECT * FROM tasks WHERE application_id = $1 AND status = 'OPEN' FOR UPDATE", [appId])).rows[0];
        if (!task || !task.assignee_id || !task.assigned_at) throw conflict("There is no current assignee to remind.");
        if (task.assignee_id === actor.staffId) throw conflict("The request is currently with you.");
        const age = ctx.now.getTime() - new Date(task.assigned_at).getTime();
        if (age <= REMINDER_MIN_AGE_MS) throw gate("A reminder can be sent only when the current assignment is older than six hours.");
        const last = (await tx.query<{ sent_at: Date }>("SELECT sent_at FROM reminders WHERE task_id = $1 ORDER BY sent_at DESC LIMIT 1", [task.id])).rows[0];
        if (last && ctx.now.getTime() - new Date(last.sent_at).getTime() <= REMINDER_MIN_AGE_MS) {
          throw gate("A reminder for this assignment was already sent in the last six hours.");
        }
        const r = await tx.query<{ id: string }>("INSERT INTO reminders (application_id, task_id, sent_by, sent_at) VALUES ($1,$2,$3,$4) RETURNING id", [appId, task.id, actor.staffId, ctx.now]);
        const email = await staffEmail(tx, task.assignee_id);
        await enqueueEmail(tx, ctx.now, {
          kind: "REMINDER",
          dedupeKey: `reminder:${r.rows[0].id}`,
          applicationId: appId,
          to: [email!],
          subject: `Reminder: WakeelBoost ${app.ref} is awaiting your action`,
          text: simpleEmail([
            `${actor.name} sent a reminder about request ${app.ref} (${app.customer_name}).`,
            `Stage: ${STAGE_LABELS[task.stage]}`,
            `Assigned to you: ${formatLagos(task.assigned_at)} (${Math.floor(age / 3600000)} hours ago)`,
            "",
            `Open the case: ${caseLink(appId, task.id)}`,
          ]),
        });
        await audit(tx, ctx, { action: "REMINDER_SENT", actorRole: app.initiator_role, applicationId: appId, stage: task.stage, assignmentTo: task.assignee_id, details: { taskId: task.id, ageHours: Math.floor(age / 3600000) } });
        return { applicationId: appId, stage: app.stage, message: "Reminder sent." };
      }),
    );
  } catch (e) {
    if (e instanceof DomainError && (e.code === "FORBIDDEN" || e.code === "GATE")) {
      await auditOutsideTx(ctx, { action: "REMINDER_SENT", outcome: "DENIED", applicationId: appId, reason: e.message });
    }
    throw e;
  }
}

// ------------------------------------------------------------------ misc

export function defaultInitiatorRole(roles: string[]): InitiatorRole | null {
  return (roles.find((r) => isInitiatorRole(r)) as InitiatorRole | undefined) ?? null;
}

/** Equal instalments helper for the booking form (last instalment absorbs rounding). */
export function equalInstalments(totalKobo: number, count: number, firstDue: string, monthsApart = 1) {
  const base = Math.floor(totalKobo / count);
  const out: { dueDate: string; amountKobo: number }[] = [];
  for (let i = 0; i < count; i++) {
    const [y, m, d] = firstDue.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1 + i * monthsApart, Math.min(d, 28)));
    out.push({ dueDate: dt.toISOString().slice(0, 10), amountKobo: i === count - 1 ? totalKobo - base * (count - 1) : base });
  }
  return out;
}
export { addDaysToDateString, assetCostKobo, activeCalculator };
