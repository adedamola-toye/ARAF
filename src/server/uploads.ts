/**
 * Large document uploads in pieces.
 *
 * Hosting platforms cap a single request body (Vercel: about 4.5 MB), so a bank statement cannot be sent in one
 * request. The browser sends the file in pieces of CHUNK_BYTES, each stored as a private object; a dropped
 * connection resumes from the pieces already received. On completion the server reassembles the file and passes it
 * to the normal upload rules (permissions, stage, type sniffing, size limit, quarantine and malware scan,
 * versioning, audit), so nothing about document control changes.
 *
 * A permission pre-check runs before any data is accepted. Sessions belong to the person who started them and
 * expire after 24 hours; the worker removes leftover pieces.
 */
import { createHash } from "node:crypto";
import { db, withTx } from "./db";
import type { Ctx } from "./context";
import { config } from "./config";
import { DomainError, conflict, forbidden, invalid, notFound } from "./errors";
import { objectStore } from "./storage";
import { ALLOWED_EXTENSIONS } from "./storage/scanner";
import { sanitizeFilename, uploadDocument, uploadRights } from "./domain/documents";

/** Each piece stays well below the platform's request limit. */
export const CHUNK_BYTES = 3 * 1024 * 1024 + 512 * 1024; // 3.5 MB
const SESSION_HOURS = 24;

export type UploadTarget = "APPLICATION" | "STAFF_REQUEST";

export interface StartInput {
  target: UploadTarget;
  targetId: string;
  category: string;
  filename: string;
  size: number;
  fields?: Record<string, string>;
}

interface SessionRow {
  id: string;
  staff_id: string;
  target_kind: UploadTarget;
  target_id: string;
  category: string;
  filename: string;
  size_bytes: string;
  chunk_size: number;
  chunk_count: number;
  fields: Record<string, string>;
  status: string;
  result: Record<string, unknown> | null;
  expires_at: Date;
}

const uuidRe = /^[0-9a-f-]{36}$/i;
const chunkKey = (id: string, n: number) => `uploads/${id}/${n}`;

/** Fail before any bytes are sent if this person may not upload this document type here. */
async function preflight(ctx: Ctx, i: StartInput) {
  const actor = ctx.actor!;
  if (i.target === "APPLICATION") {
    const app = (await db.query("SELECT * FROM applications WHERE id = $1", [i.targetId])).rows[0];
    if (!app) throw notFound("Request not found.");
    if (app.suspended_at) throw forbidden("This request is suspended. Uploads are paused until it is resumed.");
    const { allowed } = await uploadRights(db, actor.staffId, app, i.category);
    if (!allowed.includes(i.category)) throw forbidden("You cannot upload this document type at the current stage.");
    return;
  }
  const { requireStaffFinancing } = await import("./staff/permission");
  const { uploadableCategories } = await import("./staff/documents");
  await requireStaffFinancing(ctx, "UPLOAD_STAFF_DOCUMENT", i.targetId);
  const req = (await db.query("SELECT * FROM staff_requests WHERE id = $1", [i.targetId])).rows[0];
  if (!req) throw notFound("Salary advance request not found.");
  const allowed = await uploadableCategories(db, req, actor.staffId, ctx.now);
  if (!allowed.categories.includes(i.category as never)) throw forbidden("You cannot upload this document type at the current stage of the request.");
}

export async function startUpload(ctx: Ctx, i: StartInput): Promise<{ id: string; chunkSize: number; chunkCount: number }> {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (i.target !== "APPLICATION" && i.target !== "STAFF_REQUEST") throw invalid("Unknown upload target.");
  if (!uuidRe.test(i.targetId ?? "")) throw notFound();
  const filename = sanitizeFilename(String(i.filename ?? ""));
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (!ALLOWED_EXTENSIONS.includes(ext)) throw invalid(`This file type is not accepted. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.`);
  const size = Number(i.size);
  if (!Number.isInteger(size) || size <= 0) throw invalid("The file is empty.");
  if (size > config.maxDocumentBytes) throw invalid(`The file is ${(size / 1048576).toFixed(1)} MB; the limit is ${Math.round(config.maxDocumentBytes / 1048576)} MB.`);
  await preflight(ctx, i);
  const fields = Object.fromEntries(Object.entries(i.fields ?? {}).filter(([k, v]) => /^[a-zA-Z]{1,40}$/.test(k) && typeof v === "string" && v.length <= 200)) as Record<string, string>;
  const chunkCount = Math.ceil(size / CHUNK_BYTES);
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO upload_sessions (staff_id, target_kind, target_id, category, filename, size_bytes, chunk_size, chunk_count, fields, created_at, updated_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11) RETURNING id`,
      [actor.staffId, i.target, i.targetId, i.category, filename, size, CHUNK_BYTES, chunkCount, JSON.stringify(fields), ctx.now, new Date(ctx.now.getTime() + SESSION_HOURS * 3600_000)],
    )
  ).rows[0].id;
  return { id, chunkSize: CHUNK_BYTES, chunkCount };
}

async function ownSession(ctx: Ctx, id: string): Promise<SessionRow> {
  if (!ctx.actor) throw forbidden();
  if (!uuidRe.test(id)) throw notFound("Upload not found.");
  const s = (await db.query<SessionRow>("SELECT * FROM upload_sessions WHERE id = $1", [id])).rows[0];
  if (!s || s.staff_id !== ctx.actor.staffId) throw notFound("Upload not found.");
  return s;
}

export async function uploadStatus(ctx: Ctx, id: string) {
  const s = await ownSession(ctx, id);
  const received = (await db.query<{ n: number }>("SELECT n FROM upload_chunks WHERE session_id = $1 ORDER BY n", [id])).rows.map((r) => r.n);
  return { id: s.id, status: s.status, chunkSize: s.chunk_size, chunkCount: s.chunk_count, received, result: s.result };
}

export async function putChunk(ctx: Ctx, id: string, n: number, data: Buffer) {
  const s = await ownSession(ctx, id);
  if (s.status !== "OPEN") throw conflict(s.status === "COMPLETED" ? "This upload is already complete." : "This upload is no longer open. Start the upload again.");
  if (new Date(s.expires_at) < ctx.now) throw conflict("This upload has expired. Start it again.");
  if (!Number.isInteger(n) || n < 0 || n >= s.chunk_count) throw invalid("Unexpected piece number.");
  const size = Number(s.size_bytes);
  const expected = n === s.chunk_count - 1 ? size - s.chunk_size * (s.chunk_count - 1) : s.chunk_size;
  if (data.length !== expected) throw invalid(`Piece ${n + 1} has the wrong size. Retry the upload.`);
  try {
    await objectStore().put(chunkKey(id, n), data, "application/octet-stream");
  } catch (e) {
    console.error("[uploads] storage write failed", e);
    throw new DomainError("CONFIG", "Document storage is not available. An administrator must check the object storage configuration.");
  }
  await db.query(
    `INSERT INTO upload_chunks (session_id, n, size_bytes, sha256, received_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (session_id, n) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256, received_at = EXCLUDED.received_at`,
    [id, n, data.length, createHash("sha256").update(data).digest("hex"), ctx.now],
  );
  await db.query("UPDATE upload_sessions SET updated_at = $2 WHERE id = $1", [id, ctx.now]);
}

async function removeChunks(id: string, count: number) {
  for (let n = 0; n < count; n++) await objectStore().delete(chunkKey(id, n)).catch(() => undefined);
}

/** Reassemble and hand over to the normal upload rules. Idempotent: a repeated call returns the first result. */
export async function completeUpload(ctx: Ctx, id: string): Promise<Record<string, unknown>> {
  const s = await ownSession(ctx, id);
  if (s.status === "COMPLETED" && s.result) return s.result;
  // Only one completion at a time.
  // (A completion interrupted for more than two minutes can be retried.)
  const claimed = await db.query(
    "UPDATE upload_sessions SET status = 'COMPLETING', updated_at = $2 WHERE id = $1 AND (status = 'OPEN' OR (status = 'COMPLETING' AND updated_at < $2::timestamptz - interval '2 minutes')) RETURNING id",
    [id, ctx.now],
  );
  if (!claimed.rowCount) throw conflict("This upload is already being completed. Wait a moment and refresh.");
  try {
    const chunks = (await db.query<{ n: number; size_bytes: number }>("SELECT n, size_bytes FROM upload_chunks WHERE session_id = $1 ORDER BY n", [id])).rows;
    if (chunks.length !== s.chunk_count || chunks.some((c, i) => c.n !== i)) {
      await db.query("UPDATE upload_sessions SET status = 'OPEN' WHERE id = $1", [id]);
      throw conflict("Some pieces of the file have not arrived yet. Retry to send them.");
    }
    const parts: Buffer[] = [];
    for (const c of chunks) parts.push(await objectStore().get(chunkKey(id, c.n)));
    const data = Buffer.concat(parts);
    if (data.length !== Number(s.size_bytes)) throw invalid("The reassembled file is not the expected size. Start the upload again.");
    let result: Record<string, unknown>;
    if (s.target_kind === "APPLICATION") {
      const f = s.fields ?? {};
      const r = await uploadDocument(ctx, {
        applicationId: s.target_id,
        category: s.category,
        filename: s.filename,
        data,
        replacesDocumentId: f.replacesDocumentId || null,
        meta: { photoCategory: f.photoCategory ?? "", coverageFrom: f.coverageFrom ?? "", coverageTo: f.coverageTo ?? "" },
      });
      result = { documentId: r.id, version: r.version, scanStatus: r.scanStatus };
    } else {
      const { uploadStaffDocument } = await import("./staff/documents");
      const r = await uploadStaffDocument(ctx, { requestId: s.target_id, category: s.category, filename: s.filename, data });
      result = { documentId: r.id, scanStatus: r.scanStatus };
    }
    await withTx(async (tx) => {
      await tx.query("UPDATE upload_sessions SET status = 'COMPLETED', result = $2, updated_at = $3 WHERE id = $1", [id, JSON.stringify(result), ctx.now]);
    });
    await removeChunks(id, s.chunk_count);
    return result;
  } catch (e) {
    // A rule failure (wrong type, not allowed, malware) ends the session; technical errors leave it open to retry.
    if (e instanceof DomainError && e.code !== "CONFIG" && e.code !== "CONFLICT") {
      await db.query("UPDATE upload_sessions SET status = 'FAILED', error = $2, updated_at = $3 WHERE id = $1", [id, e.message.slice(0, 500), ctx.now]);
      await removeChunks(id, s.chunk_count);
    } else if (!(e instanceof DomainError && e.code === "CONFLICT")) {
      await db.query("UPDATE upload_sessions SET status = 'OPEN' WHERE id = $1 AND status = 'COMPLETING'", [id]);
    }
    throw e;
  }
}

export async function abortUpload(ctx: Ctx, id: string) {
  const s = await ownSession(ctx, id);
  if (s.status === "COMPLETED") return;
  await db.query("UPDATE upload_sessions SET status = 'ABORTED', updated_at = $2 WHERE id = $1 AND status IN ('OPEN','FAILED')", [id, ctx.now]);
  await removeChunks(id, s.chunk_count);
}

/** Worker: expire abandoned uploads and delete their pieces. */
export async function purgeExpiredUploads(now = new Date()): Promise<number> {
  const rows = (await db.query<{ id: string; chunk_count: number }>("UPDATE upload_sessions SET status = 'EXPIRED', updated_at = $1 WHERE status IN ('OPEN','COMPLETING') AND expires_at < $1 RETURNING id, chunk_count", [now])).rows;
  for (const r of rows) await removeChunks(r.id, r.chunk_count);
  return rows.length;
}
