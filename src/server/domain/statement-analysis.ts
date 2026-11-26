/**
 * Automatic Statement Analysis (Periculum Insights) — Phase 2: one analyst action runs the whole vendor pipeline.
 *
 *  startStatementAnalysis   the authorised credit reviewer's single action. Takes every current, clean bank
 *                           statement on the application; detects duplicate files (SHA-256); reuses a statement
 *                           already processed for this application; returns the existing result when the
 *                           statement set is unchanged (a re-run of an unchanged set needs a reason); one
 *                           analysis in flight per application (repeated clicks return it).
 *  processStatementAnalysis the worker: submits (bounded concurrency), polls, stores results encrypted, rolls the
 *                           analysis status up. Ambiguous submissions are reconciled, never blindly re-sent.
 *  handlePericulumWebhook   verifies and records a delivery; only brings the next status check forward.
 *
 * Uploading a statement never calls Periculum. Viewing results never calls Periculum.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { db, withTx, type Db, type Tx } from "../db";
import type { Ctx } from "../context";
import { systemCtx } from "../context";
import { config } from "../config";
import { audit, auditOutsideTx } from "../audit";
import { decryptField, encryptField } from "../crypto";
import { forbidden, gate, invalid, notFound } from "../errors";
import { objectStore } from "../storage";
import { holdsRole } from "./access";
import { lockApp } from "./workflow";
import { notify } from "./notifications";
import { scheduleBureauChecks } from "./bureau-check";
import { getStatement, getTransactions, periculumReadiness, periculumSource, submitStatement, type VendorStatement } from "../integrations/periculum/client";

export const CREDIT_ANALYSIS_STAGES = ["FIRST_CREDIT_REVIEW", "CREDIT_CORRECTION", "CX_CREDIT_REVIEW"] as const;

export type AnalysisStatus = "QUEUED" | "PROCESSING" | "PARTIALLY_COMPLETED" | "COMPLETED" | "FAILED" | "REQUIRES_VERIFICATION" | "SUPERSEDED";
export type StatementStatus = "PENDING" | "SUBMITTING" | "SUBMISSION_UNCERTAIN" | "UPLOADED" | "PROCESSING" | "PROCESSED" | "FAILED" | "REQUIRES_VERIFICATION" | "DUPLICATE" | "REUSED";

const IN_FLIGHT: StatementStatus[] = ["PENDING", "SUBMITTING", "SUBMISSION_UNCERTAIN", "UPLOADED", "PROCESSING"];

export interface AnalysisRow {
  id: string;
  application_id: string;
  version: number;
  status: AnalysisStatus;
  source: "PERICULUM" | "FIXTURE";
  vendor_environment: string;
  initiated_by: string;
  initiated_role: string;
  reason: string | null;
  statement_set_sha256: string;
  result: unknown;
  created_at: Date;
  completed_at: Date | null;
  superseded_at: Date | null;
  superseded_by: string | null;
}

export interface StatementRow {
  id: string;
  analysis_id: string;
  document_id: string;
  document_sha256: string;
  filename: string;
  status: StatementStatus;
  statement_type: "CONSUMER" | "BUSINESS";
  vendor_statement_key: string | null;
  vendor_status: string | null;
  submission_name: string | null;
  password_enc: string | null;
  duplicate_of: string | null;
  reused_from: string | null;
  attempts: number;
  next_action_at: Date | null;
  error_category: string | null;
  error_message: string | null;
  submitted_at: Date | null;
  processed_at: Date | null;
  created_at: Date;
}

const setHash = (hashes: string[]) =>
  createHash("sha256")
    .update([...new Set(hashes)].sort().join("\n"))
    .digest("hex");

/** The analysis currently in force for an application (latest version not superseded), or null. */
export async function currentAnalysis(q: Db, appId: string): Promise<AnalysisRow | null> {
  return (await q.query<AnalysisRow>("SELECT * FROM fi_analyses WHERE application_id = $1 AND superseded_at IS NULL ORDER BY version DESC LIMIT 1", [appId])).rows[0] ?? null;
}

export async function analysisStatements(q: Db, analysisId: string): Promise<StatementRow[]> {
  return (await q.query<StatementRow>("SELECT * FROM fi_statements WHERE analysis_id = $1 ORDER BY created_at, filename", [analysisId])).rows;
}

/** The authorised credit reviewer: holds the open credit-review task on this application. */
async function requireAnalyst(tx: Tx, ctx: Ctx, appId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const task = (
    await tx.query<{ stage: string; assignee_id: string | null; assignee_role: string }>(
      `SELECT stage, assignee_id, assignee_role FROM tasks WHERE application_id = $1 AND status = 'OPEN' AND stage = ANY($2::text[]) ORDER BY seq DESC LIMIT 1`,
      [appId, CREDIT_ANALYSIS_STAGES],
    )
  ).rows[0];
  if (!task || task.assignee_id !== actor.staffId || !(await holdsRole(tx, actor.staffId, task.assignee_role)))
    throw forbidden("Only the credit reviewer assigned to this application can run Automatic Statement Analysis.");
  return { staffId: actor.staffId, role: task.assignee_role, stage: task.stage };
}

export interface StartInput {
  /** Required to re-run an analysis whose statements have not changed. */
  reason?: string | null;
  /** PDF passwords keyed by document id (encrypted until submitted, then cleared). */
  passwords?: Record<string, string>;
}

export async function startStatementAnalysis(ctx: Ctx, appId: string, input: StartInput = {}) {
  const ready = await periculumReadiness();
  if (!ready.ready) throw gate(ready.problem!);
  const res = await withTx(async (tx) => {
    const app = await lockApp(tx, appId);
    const who = await requireAnalyst(tx, ctx, appId);
    const docs = (
      await tx.query<{ id: string; filename: string; sha256: string; size_bytes: string; mime_type: string }>(
        `SELECT id, filename, sha256, size_bytes::text, mime_type FROM documents
          WHERE application_id = $1 AND category = 'BANK_STATEMENT' AND superseded_at IS NULL AND scan_status = 'CLEAN' AND purged_at IS NULL
          ORDER BY uploaded_at`,
        [appId],
      )
    ).rows;
    if (!docs.length) throw gate("No bank statement is available on this application. Return the request for the statement before analysis.");

    // A second click while running returns the running analysis.
    const active = (await tx.query<AnalysisRow>("SELECT * FROM fi_analyses WHERE application_id = $1 AND status IN ('QUEUED','PROCESSING')", [appId])).rows[0];
    if (active) return { id: active.id, version: active.version, status: active.status, reused: true, alreadyRunning: true };

    const hash = setHash(docs.map((d) => d.sha256));
    const current = await currentAnalysis(tx, appId);
    const reason = (input.reason ?? "").trim();
    if (current && current.statement_set_sha256 === hash && current.status === "COMPLETED") {
      if (!reason) return { id: current.id, version: current.version, status: current.status, reused: true, alreadyRunning: false };
      if (reason.length < 10) throw invalid("Give the reason for re-analysing unchanged statements.", { reason: "At least 10 characters." });
    }

    const version = Number((await tx.query("SELECT coalesce(max(version), 0) + 1 AS v FROM fi_analyses WHERE application_id = $1", [appId])).rows[0].v);
    const source = periculumSource();
    const analysis = (
      await tx.query<AnalysisRow>(
        `INSERT INTO fi_analyses (application_id, version, status, source, vendor_environment, initiated_by, initiated_role, reason, statement_set_sha256, created_at)
         VALUES ($1,$2,'QUEUED',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [appId, version, source, config.periculum.environment, who.staffId, who.role, reason || null, hash, ctx.now],
      )
    ).rows[0];
    if (current) await tx.query("UPDATE fi_analyses SET superseded_at = $2, superseded_by = $3 WHERE id = $1", [current.id, ctx.now, analysis.id]);

    const statementType = app.applicant_type === "INDIVIDUAL" ? "CONSUMER" : "BUSINESS";
    const seen = new Map<string, string>();
    const counts = { submitted: 0, duplicates: 0, reused: 0, flagged: 0 };
    for (const d of docs) {
      let status: StatementStatus = "PENDING";
      let duplicateOf: string | null = null;
      let reusedFrom: { id: string; vendor_statement_key: string; vendor_status: string } | null = null;
      let category: string | null = null;
      let message: string | null = null;
      if (seen.has(d.sha256)) {
        status = "DUPLICATE";
        duplicateOf = seen.get(d.sha256)!;
        message = "The same file is attached more than once; it is analysed once.";
        counts.duplicates++;
      } else {
        reusedFrom =
          (
            await tx.query(
              `SELECT s.id, s.vendor_statement_key, s.vendor_status FROM fi_statements s JOIN fi_analyses a ON a.id = s.analysis_id
                WHERE a.application_id = $1 AND a.source = $3 AND s.document_sha256 = $2 AND s.status = 'PROCESSED' ORDER BY s.processed_at DESC LIMIT 1`,
              [appId, d.sha256, source],
            )
          ).rows[0] ?? null;
        if (reusedFrom) {
          status = "REUSED";
          counts.reused++;
        } else if (Number(d.size_bytes) > config.periculum.maxFileBytes) {
          status = "REQUIRES_VERIFICATION";
          category = "FILE_LIMIT";
          message = `The file is larger than Periculum's ${Math.round(config.periculum.maxFileBytes / 1024 / 1024)} MB processing limit. The original is kept; it was not truncated or split.`;
          counts.flagged++;
        } else if (!/pdf/i.test(d.mime_type) && !/\.pdf$/i.test(d.filename)) {
          status = "REQUIRES_VERIFICATION";
          category = "UNSUPPORTED_FILE";
          message = "Periculum analyses PDF statements only.";
          counts.flagged++;
        } else counts.submitted++;
      }
      const pw = input.passwords?.[d.id]?.trim();
      const row = (
        await tx.query<{ id: string }>(
          `INSERT INTO fi_statements (analysis_id, document_id, document_sha256, filename, status, statement_type, vendor_statement_key, vendor_status, password_enc,
                                      duplicate_of, reused_from, next_action_at, error_category, error_message, processed_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING id`,
          [
            analysis.id,
            d.id,
            d.sha256,
            d.filename,
            status,
            statementType,
            reusedFrom?.vendor_statement_key ?? null,
            reusedFrom?.vendor_status ?? null,
            status === "PENDING" && pw ? encryptField(pw) : null,
            duplicateOf,
            reusedFrom?.id ?? null,
            status === "PENDING" ? ctx.now : null,
            category,
            message,
            status === "REUSED" ? ctx.now : null,
            ctx.now,
          ],
        )
      ).rows[0];
      if (!seen.has(d.sha256)) seen.set(d.sha256, row.id);
    }
    await audit(tx, ctx, {
      action: "STATEMENT_ANALYSIS_INITIATED",
      actorRole: who.role,
      applicationId: appId,
      stage: who.stage,
      reason: reason || null,
      details: { analysisId: analysis.id, version, source, statements: docs.length, ...counts, supersedes: current?.id ?? null },
    });
    const status = await rollUp(tx, analysis.id, ctx.now);
    return { id: analysis.id, version, status, reused: false, alreadyRunning: false };
  });
  return res;
}

/** Retry the statements that failed or need verification (e.g. after a password is supplied). */
export async function retryStatements(ctx: Ctx, analysisId: string, input: { reason: string; passwords?: Record<string, string> }) {
  const ready = await periculumReadiness();
  if (!ready.ready) throw gate(ready.problem!);
  return withTx(async (tx) => {
    const a = (await tx.query<AnalysisRow>("SELECT * FROM fi_analyses WHERE id = $1 FOR UPDATE", [analysisId])).rows[0];
    if (!a) throw notFound("Analysis not found.");
    await lockApp(tx, a.application_id);
    const who = await requireAnalyst(tx, ctx, a.application_id);
    if (a.superseded_at) throw gate("This analysis has been superseded by a newer version.");
    if ((input.reason ?? "").trim().length < 5) throw invalid("Give the reason for the retry.", { reason: "Required." });
    const rows = (
      await tx.query<StatementRow>(
        "SELECT * FROM fi_statements WHERE analysis_id = $1 AND status IN ('FAILED','REQUIRES_VERIFICATION') AND coalesce(error_category,'') NOT IN ('ALTERED','FILE_LIMIT','UNSUPPORTED_FILE','SUBMITTED_KEY_UNKNOWN') FOR UPDATE",
        [analysisId],
      )
    ).rows;
    if (!rows.length) throw gate("There is no statement that can be retried.");
    for (const s of rows) {
      const pw = input.passwords?.[s.document_id]?.trim();
      // A statement that never reached Periculum keeps its submission name; one that did is resubmitted under a new name.
      const resubmit = s.vendor_statement_key !== null;
      await tx.query(
        `UPDATE fi_statements SET status = 'PENDING', next_action_at = $2, error_category = NULL, error_message = NULL, attempts = 0,
                password_enc = coalesce($3, password_enc), submission_name = CASE WHEN $4 THEN NULL ELSE submission_name END,
                vendor_statement_key = CASE WHEN $4 THEN NULL ELSE vendor_statement_key END, updated_at = $2 WHERE id = $1`,
        [s.id, ctx.now, pw ? encryptField(pw) : null, resubmit],
      );
    }
    await tx.query("UPDATE fi_analyses SET status = 'PROCESSING', completed_at = NULL WHERE id = $1", [analysisId]);
    await audit(tx, ctx, { action: "STATEMENT_ANALYSIS_RETRIED", actorRole: who.role, applicationId: a.application_id, reason: input.reason.trim(), details: { analysisId, statements: rows.length } });
    return { retried: rows.length };
  });
}

// ------------------------------------------------------------------ status roll-up

async function rollUp(tx: Tx, analysisId: string, now: Date): Promise<AnalysisStatus> {
  const a = (await tx.query<AnalysisRow>("SELECT * FROM fi_analyses WHERE id = $1 FOR UPDATE", [analysisId])).rows[0];
  const st = (await tx.query<{ status: StatementStatus; submitted_at: Date | null }>("SELECT status, submitted_at FROM fi_statements WHERE analysis_id = $1 AND status <> 'DUPLICATE'", [analysisId])).rows;
  let next: AnalysisStatus;
  const n = (s: StatementStatus[]) => st.filter((x) => s.includes(x.status)).length;
  if (n(IN_FLIGHT)) next = st.some((x) => x.submitted_at) || n(["UPLOADED", "PROCESSING", "PROCESSED", "REUSED"]) ? "PROCESSING" : "QUEUED";
  else if (n(["PROCESSED", "REUSED"]) === st.length) next = "COMPLETED";
  else if (n(["REQUIRES_VERIFICATION"])) next = "REQUIRES_VERIFICATION";
  else if (n(["PROCESSED", "REUSED"])) next = "PARTIALLY_COMPLETED";
  else next = "FAILED";
  if (next === a.status) return next;
  const terminal = !["QUEUED", "PROCESSING"].includes(next);
  await tx.query("UPDATE fi_analyses SET status = $2, completed_at = $3 WHERE id = $1", [analysisId, next, terminal ? now : null]);
  if (terminal) {
    const ctx = systemCtx(now);
    const counts = { processed: n(["PROCESSED", "REUSED"]), failed: n(["FAILED"]), requiresVerification: n(["REQUIRES_VERIFICATION"]), total: st.length };
    await audit(tx, ctx, { action: `STATEMENT_ANALYSIS_${next}`, actorRole: "SYSTEM", applicationId: a.application_id, details: { analysisId, version: a.version, source: a.source, ...counts } });
    // Optional Blacklist Search (off unless enabled): scheduled once the analysis has an analysed statement.
    if (counts.processed > 0) await scheduleBureauChecks(tx, analysisId, now);
    const ref = (await tx.query<{ ref: string }>("SELECT ref FROM applications WHERE id = $1", [a.application_id])).rows[0]?.ref ?? "";
    const words: Record<string, string> = {
      COMPLETED: `All ${counts.total} statement(s) were analysed.`,
      PARTIALLY_COMPLETED: `${counts.processed} of ${counts.total} statement(s) were analysed; the assessment is incomplete until the rest are resolved.`,
      REQUIRES_VERIFICATION: `${counts.requiresVerification} statement(s) need your attention before the assessment can be relied on.`,
      FAILED: "No statement could be analysed.",
    };
    await notify(tx, now, {
      recipientId: a.initiated_by,
      kind: "STATEMENT_ANALYSIS",
      title: `Statement analysis ${next === "COMPLETED" ? "completed" : next === "FAILED" ? "failed" : "needs attention"} · ${ref}`,
      body: words[next] ?? "",
      applicationId: a.application_id,
      link: `/requests/${a.application_id}#financial-intelligence`,
      dedupeKey: `fi:${analysisId}:${next}:${now.getTime()}`,
    });
  }
  return next;
}

// ------------------------------------------------------------------ worker

const backoff = (attempts: number) => Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

async function claim(status: StatementStatus[], now: Date, limit: number): Promise<StatementRow[]> {
  if (limit <= 0) return [];
  return withTx(async (tx) => {
    const rows = (
      await tx.query<StatementRow>(
        `SELECT s.* FROM fi_statements s JOIN fi_analyses a ON a.id = s.analysis_id
          WHERE s.status = ANY($1::text[]) AND s.next_action_at <= $2 AND a.superseded_at IS NULL
          ORDER BY s.next_action_at LIMIT $3 FOR UPDATE OF s SKIP LOCKED`,
        [status, now, limit],
      )
    ).rows;
    // Push the next action out so a parallel worker does not pick the same rows while this one works.
    if (rows.length) await tx.query("UPDATE fi_statements SET next_action_at = $2 WHERE id = ANY($1::uuid[])", [rows.map((r) => r.id), new Date(now.getTime() + 10 * 60_000)]);
    return rows;
  });
}

async function update(s: StatementRow, now: Date, set: Partial<Record<string, unknown>>) {
  await withTx(async (tx) => {
    const cols = Object.keys(set);
    await tx.query(`UPDATE fi_statements SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = $${cols.length + 2} WHERE id = $1`, [s.id, ...cols.map((c) => set[c]), now]);
    await rollUp(tx, s.analysis_id, now);
  });
}

async function storeResult(statementId: string, kind: "ANALYTICS" | "TRANSACTIONS", payload: unknown, now: Date) {
  const text = JSON.stringify(payload);
  await db.query("INSERT INTO fi_vendor_results (statement_id, kind, source, payload_enc, payload_sha256, received_at) VALUES ($1,$2,$3,$4,$5,$6)", [
    statementId,
    kind,
    periculumSource(),
    encryptField(text),
    createHash("sha256").update(text).digest("hex"),
    now,
  ]);
}

/** The newest stored vendor payload of a kind for a statement (follows a reused statement to its source). */
export async function statementPayload<T = unknown>(q: Db, statementId: string, kind: "ANALYTICS" | "TRANSACTIONS"): Promise<T | null> {
  const s = (await q.query<{ reused_from: string | null }>("SELECT reused_from FROM fi_statements WHERE id = $1", [statementId])).rows[0];
  const id = s?.reused_from ?? statementId;
  const r = (await q.query<{ payload_enc: string }>("SELECT payload_enc FROM fi_vendor_results WHERE statement_id = $1 AND kind = $2 ORDER BY id DESC LIMIT 1", [id, kind])).rows[0];
  return r ? (JSON.parse(decryptField(r.payload_enc)) as T) : null;
}

async function submitOne(s: StatementRow, now: Date) {
  const a = (await db.query<{ ref: string }>("SELECT ap.ref FROM fi_analyses f JOIN applications ap ON ap.id = f.application_id WHERE f.id = $1", [s.analysis_id])).rows[0];
  const name = s.submission_name ?? `ARAF-${a.ref}-${s.id.slice(0, 8)}.pdf`.replace(/[^\w.-]/g, "-");
  const doc = (await db.query<{ storage_key: string }>("SELECT storage_key FROM documents WHERE id = $1", [s.document_id])).rows[0];
  let data: Buffer;
  try {
    data = await objectStore().get(doc.storage_key);
  } catch {
    return update(s, now, { status: "FAILED", error_category: "DOCUMENT_UNAVAILABLE", error_message: "The stored statement could not be read.", next_action_at: null });
  }
  const wasUncertain = s.status === "SUBMISSION_UNCERTAIN";
  await db.query("UPDATE fi_statements SET status = 'SUBMITTING', submission_name = $2, attempts = attempts + 1, updated_at = $3 WHERE id = $1", [s.id, name, now]);
  const r = await submitStatement({ analysisId: s.analysis_id, statementId: s.id }, { data, submissionName: name, password: s.password_enc ? decryptField(s.password_enc) : null, statementType: s.statement_type });
  const attempts = s.attempts + 1;
  if (r.ok) {
    return update(s, now, {
      status: "UPLOADED",
      vendor_statement_key: r.data.key,
      vendor_status: r.data.processingStatus ?? "UPLOADED",
      submitted_at: now,
      password_enc: null,
      error_category: null,
      error_message: null,
      next_action_at: new Date(now.getTime() + config.periculum.pollIntervalMs),
    });
  }
  if (r.outcome === "RATE_LIMITED")
    return update(s, now, { status: wasUncertain ? "SUBMISSION_UNCERTAIN" : "PENDING", next_action_at: new Date(now.getTime() + backoff(attempts)), error_category: "RATE_LIMITED", error_message: r.message });
  if (r.outcome === "AMBIGUOUS") {
    // The statement may have been accepted (and charged). Reconcile by resubmitting under the SAME name: Periculum
    // refuses a name it has already analysed, which tells us the first attempt landed.
    if (attempts >= config.periculum.maxAttempts)
      return update(s, now, {
        status: "REQUIRES_VERIFICATION",
        error_category: "SUBMISSION_UNCERTAIN",
        error_message: `Periculum's response to the submission was not received after ${attempts} attempts. Check the Insights dashboard for "${name}" before retrying.`,
        next_action_at: null,
      });
    return update(s, now, { status: "SUBMISSION_UNCERTAIN", next_action_at: new Date(now.getTime() + backoff(attempts)), error_category: r.category, error_message: r.message });
  }
  if (r.outcome === "REJECTED" && r.category === "ALREADY_SUBMITTED") {
    return update(s, now, {
      status: "REQUIRES_VERIFICATION",
      error_category: wasUncertain ? "SUBMITTED_KEY_UNKNOWN" : "ALREADY_SUBMITTED",
      next_action_at: null,
      error_message: wasUncertain
        ? `An earlier submission of "${name}" reached Periculum but its reference was not received. Operations must link the statement key from the Insights dashboard; it was not submitted again.`
        : r.message,
    });
  }
  if (r.outcome === "REJECTED" && r.category === "UNAUTHORISED")
    return update(s, now, { status: "FAILED", error_category: "UNAUTHORISED", error_message: "Periculum refused ARAF's credentials.", password_enc: null, next_action_at: null });
  const verify = ["PASSWORD_REQUIRED", "FILE_LIMIT", "UNSUPPORTED_FILE"].includes(r.category);
  return update(s, now, { status: verify ? "REQUIRES_VERIFICATION" : "FAILED", error_category: r.category, error_message: r.message, next_action_at: null, ...(verify ? {} : { password_enc: null }) });
}

const TERMINAL_FAILURES: Record<string, string> = {
  FAILED: "Periculum could not process this statement.",
  "NO TRANSACTIONS": "Periculum found no transactions in this statement.",
  "NOT ENOUGH TRANSACTIONS": "The statement does not contain enough transactions for analysis.",
  "NO BALANCE": "Periculum could not read balances from this statement.",
  "INSUFFIENT BALANCE": "The bank's Periculum account has insufficient credit.",
  "INSUFFICIENT BALANCE": "The bank's Periculum account has insufficient credit.",
};

async function pollOne(s: StatementRow, now: Date) {
  const key = Number(s.vendor_statement_key);
  const ids = { analysisId: s.analysis_id, statementId: s.id };
  if (s.submitted_at && now.getTime() - new Date(s.submitted_at).getTime() > config.periculum.processingExpiryMs)
    return update(s, now, { status: "FAILED", error_category: "EXPIRED", error_message: "Periculum did not finish processing in time. Retry the statement.", next_action_at: null });
  const r = await getStatement(ids, key);
  if (!r.ok) return update(s, now, { next_action_at: new Date(now.getTime() + Math.max(config.periculum.pollIntervalMs, backoff(s.attempts + 1))), error_category: r.category, error_message: r.message });
  const vs = String(r.data.processingStatus ?? "").toUpperCase();
  if (vs === "UPLOADED" || vs === "PROCESSING")
    return update(s, now, { status: "PROCESSING", vendor_status: vs, error_category: null, error_message: null, next_action_at: new Date(now.getTime() + config.periculum.pollIntervalMs) });
  if (vs === "PROCESSED" || vs === "ALTERED") {
    const t = await getTransactions(ids, key);
    if (!t.ok)
      return update(s, now, {
        vendor_status: vs,
        next_action_at: new Date(now.getTime() + config.periculum.pollIntervalMs),
        error_category: t.category,
        error_message: `Analytics ready; transactions not yet retrieved: ${t.message}`,
      });
    await storeResult(s.id, "ANALYTICS", r.data satisfies VendorStatement, now);
    await storeResult(s.id, "TRANSACTIONS", t.data, now);
    if (vs === "ALTERED")
      return update(s, now, {
        status: "REQUIRES_VERIFICATION",
        vendor_status: vs,
        processed_at: now,
        error_category: "ALTERED",
        error_message: "Periculum flagged this statement as possibly altered. It is excluded from the assessment until verified.",
        next_action_at: null,
      });
    return update(s, now, { status: "PROCESSED", vendor_status: vs, processed_at: now, error_category: null, error_message: null, next_action_at: null });
  }
  if (TERMINAL_FAILURES[vs]) return update(s, now, { status: "FAILED", vendor_status: vs, error_category: vs.replace(/\s+/g, "_"), error_message: TERMINAL_FAILURES[vs], next_action_at: null });
  return update(s, now, { status: "REQUIRES_VERIFICATION", vendor_status: vs || null, error_category: "UNKNOWN_STATUS", error_message: `Periculum returned an unrecognised status "${vs}".`, next_action_at: null });
}

/** Worker step: submit within the concurrency limit, then poll what is due. */
export async function processStatementAnalysis(now = new Date()) {
  if (!(await periculumReadiness()).ready) return { submitted: 0, polled: 0 };
  const inFlight = Number((await db.query("SELECT count(*) AS n FROM fi_statements WHERE status IN ('SUBMITTING','UPLOADED','PROCESSING')")).rows[0].n);
  const toSubmit = await claim(["PENDING", "SUBMISSION_UNCERTAIN"], now, config.periculum.maxConcurrent - inFlight);
  for (const s of toSubmit) await submitOne(s, now).catch((e) => console.error("[periculum] submission step failed", s.id, (e as Error).message));
  const toPoll = await claim(["UPLOADED", "PROCESSING"], now, 20);
  for (const s of toPoll) await pollOne(s, now).catch((e) => console.error("[periculum] status step failed", s.id, (e as Error).message));
  return { submitted: toSubmit.length, polled: toPoll.length };
}

// ------------------------------------------------------------------ webhook

/**
 * Periculum webhook (documented: HTTPS POST without authentication; metadata.hmacMessage = HMAC-SHA512 of the
 * response object with the shared secret). It is a hint only: the statement is re-read from the API before any
 * result is stored. Duplicate deliveries are ignored.
 */
export async function handlePericulumWebhook(raw: string, now = new Date()) {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return { accepted: false as const, reason: "malformed" };
  }
  const meta = (body.metadata ?? {}) as Record<string, unknown>;
  const type = typeof meta.responseType === "string" ? meta.responseType : null;
  const key = Number(body.statementKey);
  const secret = config.periculum.webhookSecret;
  let hmacValid: boolean | null = null;
  if (secret && typeof meta.hmacMessage === "string") {
    const obj = type === "AFFORDABILITY" ? body.affordabilityResponse : type === "CREDITSCORE" ? body.creditScoreResponse : body.insightsResponse;
    const expected = createHmac("sha512", secret)
      .update(JSON.stringify(obj ?? null))
      .digest("hex");
    const got = meta.hmacMessage.toLowerCase();
    hmacValid = got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  }
  const bodySha = createHash("sha256").update(raw).digest("hex");
  const ins = await db.query("INSERT INTO fi_webhook_events (body_sha256, response_type, statement_key, hmac_valid, received_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (body_sha256) DO NOTHING RETURNING id", [
    bodySha,
    type,
    Number.isFinite(key) ? key : null,
    hmacValid,
    now,
  ]);
  if (!ins.rowCount) return { accepted: true as const, duplicate: true };
  if (!Number.isFinite(key) || type !== "INSIGHTS") return { accepted: true as const, duplicate: false, matched: false };
  const m = await db.query("UPDATE fi_statements SET next_action_at = $2 WHERE vendor_statement_key = $1 AND status IN ('UPLOADED','PROCESSING') RETURNING id", [key, now]);
  if (m.rowCount) await db.query("UPDATE fi_webhook_events SET matched = true WHERE id = $1", [ins.rows[0].id]);
  if (hmacValid === false) await auditOutsideTx(systemCtx(now), { action: "PERICULUM_WEBHOOK_SIGNATURE_MISMATCH", outcome: "DENIED", details: { statementKey: key } });
  return { accepted: true as const, duplicate: false, matched: !!m.rowCount };
}
