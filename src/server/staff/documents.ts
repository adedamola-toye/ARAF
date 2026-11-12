/**
 * Staff Personal Financing documents: private object storage (no personal data in object keys),
 * type sniffing, quarantine and malware scan, versioned rows, and access checks on every read.
 */
import { randomUUID } from "node:crypto";
import type { Db, Tx } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { systemCtx } from "../context";
import { config } from "../config";
import { DomainError, forbidden, gate, invalid, notFound } from "../errors";
import { sha256Hex } from "../crypto";
import { objectStore } from "../storage";
import { documentScanner, sniffAllowedType, ALLOWED_EXTENSIONS } from "../storage/scanner";
import { sanitizeFilename } from "../domain/documents";
import { holdsRole } from "../domain/access";
import { APPLICANT_SUPPORTING_CATEGORIES, STAFF_DOC_CATEGORIES, type StaffDocCategory } from "@/lib/staff-financing";
import { auditDenied, lockRequest, recordEvent, requestAccess, DISBURSEMENT_ROLES, type StaffRequestRow } from "./core";

export interface StaffDocumentRow {
  id: string;
  request_id: string;
  seq: number;
  category: StaffDocCategory;
  filename: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  storage_key: string;
  scan_status: "QUARANTINED" | "CLEAN" | "REJECTED";
  scan_detail: string | null;
  generated: boolean;
  uploaded_by: string | null;
  uploaded_role: string | null;
  uploaded_at: Date;
  status_at_upload: string;
  removed_at: Date | null;
}

export async function listStaffDocuments(q: Db, requestId: string, opts: { includeRemoved?: boolean } = {}): Promise<(StaffDocumentRow & { uploaded_by_name: string | null })[]> {
  return (
    await q.query(
      `SELECT d.*, s.full_name AS uploaded_by_name FROM staff_request_documents d LEFT JOIN staff s ON s.id = d.uploaded_by
        WHERE d.request_id = $1 ${opts.includeRemoved ? "" : "AND d.removed_at IS NULL"} ORDER BY d.seq`,
      [requestId],
    )
  ).rows;
}

async function nextSeq(tx: Tx, requestId: string) {
  return Number((await tx.query("SELECT coalesce(max(seq), 0) + 1 AS n FROM staff_request_documents WHERE request_id = $1", [requestId])).rows[0].n);
}

/** Which categories the actor may upload now, and in which capacity. */
export async function uploadableCategories(q: Db, req: StaffRequestRow, staffId: string, now: Date): Promise<{ role: string; categories: StaffDocCategory[] }> {
  if (req.applicant_id === staffId) {
    if (req.status === "DRAFT" || req.status === "RETURNED_FOR_CORRECTION") return { role: "APPLICANT", categories: APPLICANT_SUPPORTING_CATEGORIES };
    if (req.status === "AWAITING_SIGNED_OFFER" && !req.signed_offer_received_at && req.offer_deadline_at && new Date(req.offer_deadline_at) > now) {
      return { role: "APPLICANT", categories: ["SIGNED_OFFER"] };
    }
    return { role: "APPLICANT", categories: [] };
  }
  if (req.disbursement_officer_id === staffId && (req.status === "ASSIGNED_FOR_DISBURSEMENT" || req.status === "DISBURSEMENT_IN_PROGRESS")) {
    for (const r of DISBURSEMENT_ROLES) if (await holdsRole(q, staffId, r)) return { role: r, categories: ["DISBURSEMENT_EVIDENCE"] };
  }
  return { role: "", categories: [] };
}

export interface StaffUploadInput {
  requestId: string;
  category: string;
  filename: string;
  data: Buffer;
}

export async function uploadStaffDocument(ctx: Ctx, input: StaffUploadInput): Promise<{ id: string; scanStatus: string }> {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const filename = sanitizeFilename(input.filename);
  if (!(input.category in STAFF_DOC_CATEGORIES)) throw invalid("Choose a document type.");
  if (input.data.length === 0) throw invalid("The file is empty.");
  if (input.data.length > config.maxUploadBytes) throw invalid(`The file exceeds the ${Math.round(config.maxUploadBytes / 1048576)} MB limit.`);
  const mime = sniffAllowedType(filename, input.data);
  if (!mime) throw invalid(`Unsupported or mismatched file type. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.`);
  const docId = randomUUID();
  const quarantineKey = `quarantine/staff-requests/${docId}`;
  try {
    await objectStore().put(quarantineKey, input.data, mime);
  } catch (e) {
    console.error("[staff-docs] object storage write failed", e);
    throw new DomainError("CONFIG", "Document storage is not available. An administrator must check the object storage configuration.");
  }
  try {
    await withTx(async (tx) => {
      const req = await lockRequest(tx, input.requestId);
      const allowed = await uploadableCategories(tx, req, actor.staffId, ctx.now);
      if (!allowed.categories.includes(input.category as StaffDocCategory)) {
        throw forbidden("You cannot upload this document type at the current stage of the request.");
      }
      const seq = await nextSeq(tx, req.id);
      await tx.query(
        `INSERT INTO staff_request_documents (id, request_id, seq, category, filename, mime_type, size_bytes, sha256, storage_key, scan_status, uploaded_by, uploaded_role, uploaded_at, status_at_upload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'QUARANTINED',$10,$11,$12,$13)`,
        [docId, req.id, seq, input.category, filename, mime, input.data.length, sha256Hex(input.data), quarantineKey, actor.staffId, allowed.role, ctx.now, req.status],
      );
      await recordEvent(tx, ctx, req, {
        action: "DOCUMENT_UPLOADED",
        role: allowed.role,
        documentIds: [docId],
        details: { category: input.category, filename, size: input.data.length },
      });
    });
  } catch (e) {
    await objectStore().delete(quarantineKey);
    if (e instanceof DomainError && e.code === "FORBIDDEN") await auditDenied(ctx, input.requestId, "DOCUMENT_UPLOAD", e.message);
    throw e;
  }
  const scanStatus = await scanStaffDocument(ctx, docId).catch((err) => {
    console.error("[staff-docs] scan deferred to worker", err);
    return "QUARANTINED";
  });
  return { id: docId, scanStatus };
}

/** Scan a quarantined file; clean files leave quarantine, infected files are rejected and never served. */
export async function scanStaffDocument(ctx: Ctx, docId: string): Promise<string> {
  const doc = (await db.query<StaffDocumentRow>("SELECT * FROM staff_request_documents WHERE id = $1", [docId])).rows[0];
  if (!doc || doc.scan_status !== "QUARANTINED") return doc?.scan_status ?? "MISSING";
  const data = await objectStore().get(doc.storage_key);
  const res = await documentScanner().scan(data);
  if (res.deferred) return "QUARANTINED";
  if (res.clean) {
    const key = `staff-requests/${doc.request_id}/${doc.id}`;
    await objectStore().move(doc.storage_key, key);
    await db.query("UPDATE staff_request_documents SET scan_status = 'CLEAN', scan_detail = $2, storage_key = $3 WHERE id = $1", [doc.id, res.detail, key]);
    return "CLEAN";
  }
  await db.query("UPDATE staff_request_documents SET scan_status = 'REJECTED', scan_detail = $2 WHERE id = $1", [doc.id, res.detail]);
  const req = (await db.query<StaffRequestRow>("SELECT * FROM staff_requests WHERE id = $1", [doc.request_id])).rows[0];
  await recordEvent(db, ctx, req, { action: "DOCUMENT_REJECTED_BY_SCAN", documentIds: [doc.id], comments: res.detail });
  return "REJECTED";
}

export async function rescanStaffDocuments(now = new Date()) {
  const rows = (await db.query<{ id: string }>("SELECT id FROM staff_request_documents WHERE scan_status = 'QUARANTINED' AND uploaded_at < $1 LIMIT 20", [new Date(now.getTime() - 60_000)])).rows;
  for (const r of rows) await scanStaffDocument(systemCtx(now), r.id).catch((e) => console.error("[staff-docs] scan failed", r.id, e));
}

/** System-generated files (offer letters). Generated content is trusted and stored directly as clean. */
export async function storeGeneratedStaffDocument(tx: Tx, req: StaffRequestRow, p: { category: StaffDocCategory; filename: string; mime: string; data: Buffer; role: string; now: Date; actorId: string | null }) {
  const id = randomUUID();
  const key = `staff-requests/${req.id}/${id}`;
  await objectStore().put(key, p.data, p.mime);
  const seq = await nextSeq(tx, req.id);
  await tx.query(
    `INSERT INTO staff_request_documents (id, request_id, seq, category, filename, mime_type, size_bytes, sha256, storage_key, scan_status, scan_detail, generated, uploaded_by, uploaded_role, uploaded_at, status_at_upload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CLEAN','system generated',true,$10,$11,$12,$13)`,
    [id, req.id, seq, p.category, p.filename, p.mime, p.data.length, sha256Hex(p.data), key, p.actorId, p.role, p.now, req.status],
  );
  return id;
}

export async function removeStaffDocument(ctx: Ctx, docId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  await withTx(async (tx) => {
    const doc = (await tx.query<StaffDocumentRow>("SELECT * FROM staff_request_documents WHERE id = $1", [docId])).rows[0];
    if (!doc || doc.removed_at) throw notFound("Document not found.");
    const req = await lockRequest(tx, doc.request_id);
    if (req.applicant_id !== actor.staffId || !["DRAFT", "RETURNED_FOR_CORRECTION"].includes(req.status) || !APPLICANT_SUPPORTING_CATEGORIES.includes(doc.category)) {
      throw forbidden("Only your own supporting documents can be removed, and only while the request is a draft or returned for correction.");
    }
    await tx.query("UPDATE staff_request_documents SET removed_at = $2, removed_by = $3 WHERE id = $1", [doc.id, ctx.now, actor.staffId]);
    await recordEvent(tx, ctx, req, { action: "DOCUMENT_REMOVED", role: "APPLICANT", documentIds: [doc.id], details: { category: doc.category, filename: doc.filename } });
  });
}

/** Authorised read: request-level access, clean files only, every read audited. */
export async function readStaffDocument(ctx: Ctx, docId: string, mode: "view" | "download") {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!/^[0-9a-f-]{36}$/i.test(docId)) throw notFound("Document not found.");
  const doc = (await db.query<StaffDocumentRow>("SELECT * FROM staff_request_documents WHERE id = $1", [docId])).rows[0];
  if (!doc) throw notFound("Document not found.");
  const req = (await db.query<StaffRequestRow>("SELECT * FROM staff_requests WHERE id = $1", [doc.request_id])).rows[0];
  const as = await requestAccess(db, actor.staffId, req);
  if (!as.size) {
    await auditDenied(ctx, req.id, "DOCUMENT_READ", "No access to this staff financing request");
    throw forbidden("You do not have access to this document.");
  }
  if (doc.scan_status === "QUARANTINED") throw gate("This file is still being scanned. Try again shortly.");
  if (doc.scan_status === "REJECTED") throw forbidden("This file failed the malware scan and cannot be opened.");
  const data = await objectStore().get(doc.storage_key);
  await recordEvent(db, ctx, req, { action: mode === "download" ? "DOCUMENT_DOWNLOADED" : "DOCUMENT_VIEWED", role: [...as].join(","), documentIds: [doc.id] });
  return { doc, data };
}
