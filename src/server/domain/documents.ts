import { randomUUID } from "node:crypto";
import type { Db, Tx } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { config } from "../config";
import { sha256Hex, hmac, safeEqualHex } from "../crypto";
import { DomainError, forbidden, invalid, notFound } from "../errors";
import { objectStore } from "../storage";
import { documentScanner, sniffAllowedType, ALLOWED_EXTENSIONS } from "../storage/scanner";
import { caseAccess } from "./access";
import type { Stage } from "./stages";

export interface DocCategory {
  code: string;
  label: string;
  multiple: boolean;
}
export const DOC_CATEGORIES: DocCategory[] = [
  { code: "BANK_STATEMENT", label: "Bank statements (last 12 months)", multiple: true },
  { code: "CAC_CERTIFICATE", label: "CAC certificate", multiple: false },
  { code: "SUPPLIER_INVOICE", label: "Supplier invoice", multiple: false },
  { code: "APPLICATION_FORM", label: "Completed Wakeel application form", multiple: false },
  { code: "CONSENT_FORM", label: "Consent form", multiple: false },
  { code: "RENT_RECEIPT", label: "Recent rent receipt", multiple: false },
  { code: "CREDIT_REPORT", label: "Credit report", multiple: true },
  { code: "GENERATED_OFFER", label: "Generated offer letter (editable Word)", multiple: false },
  { code: "GENERATED_OFFER_PDF", label: "Generated offer letter (PDF copy)", multiple: false },
  { code: "SIGNED_OFFER", label: "Signed offer letter", multiple: false },
  { code: "KYC", label: "KYC documents", multiple: true },
  { code: "PRE_DISBURSEMENT", label: "Pre-disbursement document", multiple: false },
  { code: "GSI_FORM", label: "GSI form", multiple: false },
  { code: "INSURANCE_SIGNED", label: "Customer-signed insurance document", multiple: false },
  { code: "INSURANCE_EVIDENCE", label: "Evidence of insurance (Credit Officer 3)", multiple: false },
  { code: "SUPPORTING", label: "Other supporting document", multiple: true },
];
export const CATEGORY_LABEL = Object.fromEntries(DOC_CATEGORIES.map((c) => [c.code, c.label])) as Record<string, string>;

const INITIAL = ["BANK_STATEMENT", "CAC_CERTIFICATE", "SUPPLIER_INVOICE", "APPLICATION_FORM", "CONSENT_FORM", "RENT_RECEIPT", "SUPPORTING"];
export const PACK = ["SIGNED_OFFER", "KYC", "PRE_DISBURSEMENT", "GSI_FORM", "INSURANCE_SIGNED"];

/** Which categories the current task holder may upload at each stage. */
export const UPLOADABLE_BY_STAGE: Partial<Record<Stage, string[]>> = {
  DRAFT: INITIAL,
  INITIATOR_CORRECTION: INITIAL,
  FIRST_CREDIT_REVIEW: ["CREDIT_REPORT", "SUPPORTING"],
  CREDIT_CORRECTION: ["CREDIT_REPORT", "SUPPORTING"],
  OFFER_PREPARATION: [...PACK, "SUPPORTING"],
  CO3_PACK_REVIEW: ["INSURANCE_EVIDENCE", "SUPPORTING"],
  DISBURSEMENT_CORRECTION: ["INSURANCE_EVIDENCE", ...PACK, "SUPPORTING"],
};

export interface DocumentRow {
  id: string;
  application_id: string;
  category: string;
  slot: string;
  version_no: number;
  filename: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  storage_key: string;
  scan_status: "QUARANTINED" | "CLEAN" | "REJECTED";
  scan_detail: string | null;
  generated: boolean;
  template_id: string | null;
  template_version: number | null;
  uploaded_by: string;
  uploaded_role: string | null;
  uploader_name?: string;
  uploaded_at: Date;
  stage: string | null;
  superseded_at: Date | null;
  superseded_by: string | null;
  purged_at: Date | null;
}

export async function listDocuments(q: Db, appId: string): Promise<DocumentRow[]> {
  const r = await q.query<DocumentRow>(
    `SELECT d.*, s.full_name AS uploader_name FROM documents d JOIN staff s ON s.id = d.uploaded_by
      WHERE d.application_id = $1 ORDER BY d.category, d.slot, d.version_no DESC`,
    [appId],
  );
  return r.rows;
}

/** Current (not superseded), clean documents - what gates and decisions are evaluated against. */
export async function currentCleanDocuments(q: Db, appId: string): Promise<DocumentRow[]> {
  const r = await q.query<DocumentRow>(
    `SELECT * FROM documents WHERE application_id = $1 AND superseded_at IS NULL AND scan_status = 'CLEAN' AND purged_at IS NULL
      ORDER BY category, uploaded_at`,
    [appId],
  );
  return r.rows;
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^\w.\- ()]/g, "_").slice(0, 150) || "file";
}

export interface UploadInput {
  applicationId: string;
  category: string;
  filename: string;
  data: Buffer;
  replacesDocumentId?: string | null;
}

async function insertDocumentRow(
  tx: Tx,
  ctx: Ctx,
  p: {
    appId: string;
    category: string;
    filename: string;
    mime: string;
    data: Buffer;
    storageKey: string;
    status: "QUARANTINED" | "CLEAN";
    replacesDocumentId?: string | null;
    generated?: boolean;
    templateId?: string | null;
    templateVersion?: number | null;
    role: string | null;
    stage: string;
    versionId: string | null;
  },
): Promise<{ id: string; version: number; slot: string }> {
  const cat = DOC_CATEGORIES.find((c) => c.code === p.category);
  if (!cat) throw invalid("Unknown document category.");
  let slot = cat.multiple ? `${p.category}:${randomUUID()}` : p.category;
  if (p.replacesDocumentId) {
    const prev = (await tx.query<DocumentRow>("SELECT * FROM documents WHERE id = $1 AND application_id = $2", [p.replacesDocumentId, p.appId])).rows[0];
    if (!prev || prev.category !== p.category) throw invalid("The document being replaced was not found in this category.");
    slot = prev.slot;
  }
  const v = await tx.query<{ max: number | null }>("SELECT max(version_no) AS max FROM documents WHERE application_id = $1 AND slot = $2", [p.appId, slot]);
  const version = (v.rows[0].max ?? 0) + 1;
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO documents (application_id, category, slot, version_no, filename, mime_type, size_bytes, sha256, storage_key,
       scan_status, generated, template_id, template_version, uploaded_by, uploaded_role, uploaded_at, stage, app_version_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [
      p.appId, p.category, slot, version, p.filename, p.mime, p.data.length, sha256Hex(p.data), p.storageKey, p.status,
      p.generated ?? false, p.templateId ?? null, p.templateVersion ?? null, ctx.actor!.staffId, p.role, ctx.now, p.stage, p.versionId,
    ],
  );
  const id = ins.rows[0].id;
  // Preserve prior versions: mark them superseded, never delete.
  await tx.query(
    `UPDATE documents SET superseded_at = $3, superseded_by = $4 WHERE application_id = $1 AND slot = $2 AND id <> $4 AND superseded_at IS NULL`,
    [p.appId, slot, ctx.now, id],
  );
  return { id, version, slot };
}

/** Upload a document: validate, store in quarantine, record, then scan. */
export async function uploadDocument(ctx: Ctx, input: UploadInput): Promise<{ id: string; version: number; scanStatus: string }> {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const filename = sanitizeFilename(input.filename);
  if (input.data.length === 0) throw invalid("The file is empty.");
  if (input.data.length > config.maxUploadBytes) throw invalid(`The file exceeds the ${Math.round(config.maxUploadBytes / 1048576)} MB limit.`);
  const mime = sniffAllowedType(filename, input.data);
  if (!mime) throw invalid(`Unsupported or mismatched file type. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.`);
  if (input.category === "GENERATED_OFFER" || input.category === "GENERATED_OFFER_PDF") throw forbidden("Generated offers are produced by the system.");

  const quarantineKey = `quarantine/${input.applicationId}/${randomUUID()}`;
  await objectStore().put(quarantineKey, input.data, mime);
  let rec: { id: string; version: number };
  try {
    rec = await withTx(async (tx) => {
      const app = (await tx.query("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [input.applicationId])).rows[0];
      if (!app) throw notFound();
      const task = (await tx.query("SELECT * FROM tasks WHERE application_id = $1 AND status = 'OPEN'", [app.id])).rows[0];
      let role: string | null = null;
      let allowed: string[] = [];
      if (app.stage === "DRAFT" && app.initiator_id === actor.staffId) {
        allowed = UPLOADABLE_BY_STAGE.DRAFT!;
        role = app.initiator_role;
      } else if (task && task.assignee_id === actor.staffId) {
        allowed = UPLOADABLE_BY_STAGE[task.stage as Stage] ?? [];
        role = task.assignee_role;
        const held = await tx.query("SELECT 1 FROM role_assignments WHERE staff_id = $1 AND role = $2 AND active", [actor.staffId, role]);
        if (!held.rowCount) allowed = [];
      }
      if (!allowed.includes(input.category)) {
        throw forbidden("You cannot upload this document type at the current stage.");
      }
      const draftVersion = (await tx.query("SELECT id FROM application_versions WHERE application_id = $1 AND submitted_at IS NULL", [app.id])).rows[0];
      const r = await insertDocumentRow(tx, ctx, {
        appId: app.id,
        category: input.category,
        filename,
        mime,
        data: input.data,
        storageKey: quarantineKey,
        status: "QUARANTINED",
        replacesDocumentId: input.replacesDocumentId,
        role,
        stage: app.stage,
        versionId: draftVersion?.id ?? app.current_version_id,
      });
      await audit(tx, ctx, {
        action: "DOCUMENT_UPLOADED",
        actorRole: role,
        applicationId: app.id,
        stage: app.stage,
        documentId: r.id,
        documentVersion: r.version,
        details: { category: input.category, filename, size: input.data.length, replaces: input.replacesDocumentId ?? null },
      });
      return r;
    });
  } catch (e) {
    await objectStore().delete(quarantineKey);
    if (e instanceof DomainError && e.code === "FORBIDDEN") {
      await auditOutsideTx(ctx, { action: "DOCUMENT_UPLOAD_DENIED", outcome: "DENIED", applicationId: input.applicationId, details: { category: input.category } });
    }
    throw e;
  }
  const scanStatus = await scanDocument(ctx, rec.id).catch((err) => {
    console.error("[scan] deferred to worker", err);
    return "QUARANTINED";
  });
  return { ...rec, scanStatus };
}

/** Store a system-generated document (offer letters). Generated content is trusted; stored directly as clean. */
export async function storeGeneratedDocument(
  tx: Tx,
  ctx: Ctx,
  p: { appId: string; category: string; filename: string; mime: string; data: Buffer; templateId: string; templateVersion: number; role: string; stage: string; versionId: string | null },
) {
  const key = `documents/${p.appId}/${randomUUID()}`;
  await objectStore().put(key, p.data, p.mime);
  return insertDocumentRow(tx, ctx, { ...p, storageKey: key, status: "CLEAN", generated: true });
}

/** Scan a quarantined document; clean files move out of quarantine, infected ones are rejected. */
export async function scanDocument(ctx: Ctx, docId: string): Promise<string> {
  const doc = (await db.query<DocumentRow>("SELECT * FROM documents WHERE id = $1", [docId])).rows[0];
  if (!doc || doc.scan_status !== "QUARANTINED") return doc?.scan_status ?? "MISSING";
  const data = await objectStore().get(doc.storage_key);
  const res = await documentScanner().scan(data);
  if (res.clean) {
    const key = `documents/${doc.application_id}/${doc.id}`;
    await objectStore().move(doc.storage_key, key);
    await db.query("UPDATE documents SET scan_status = 'CLEAN', scan_detail = $2, storage_key = $3 WHERE id = $1", [doc.id, res.detail, key]);
  } else {
    await objectStore().delete(doc.storage_key);
    await withTx(async (tx) => {
      await tx.query("UPDATE documents SET scan_status = 'REJECTED', scan_detail = $2 WHERE id = $1", [doc.id, res.detail]);
      // A rejected upload must not supersede the previous good version.
      await tx.query(
        `UPDATE documents SET superseded_at = NULL, superseded_by = NULL WHERE superseded_by = $1`,
        [doc.id],
      );
      await tx.query("UPDATE documents SET superseded_at = $2 WHERE id = $1", [doc.id, ctx.now]);
    });
  }
  await auditOutsideTx(ctx, {
    action: res.clean ? "DOCUMENT_SCAN_CLEAN" : "DOCUMENT_SCAN_REJECTED",
    outcome: res.clean ? "SUCCESS" : "FAILURE",
    applicationId: doc.application_id,
    documentId: doc.id,
    documentVersion: doc.version_no,
    details: { detail: res.detail },
  });
  return res.clean ? "CLEAN" : "REJECTED";
}

// ------------------------------------------------------------------ expiring access URLs
const LINK_TTL_SECONDS = 300;

export function signDocumentLink(docId: string, staffId: string, sessionId: string, mode: "view" | "download", now = new Date()) {
  const exp = Math.floor(now.getTime() / 1000) + LINK_TTL_SECONDS;
  const sig = hmac(`${docId}|${staffId}|${sessionId}|${mode}|${exp}`);
  return `/api/documents/${docId}?mode=${mode}&exp=${exp}&sig=${sig}`;
}
export function verifyDocumentLink(docId: string, staffId: string, sessionId: string, mode: string, exp: string, sig: string, now = new Date()): boolean {
  if (!/^\d+$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Number(exp) < Math.floor(now.getTime() / 1000)) return false;
  return safeEqualHex(sig, hmac(`${docId}|${staffId}|${sessionId}|${mode}|${exp}`));
}

/**
 * Authorise and read a document for preview/download. Re-checks case-scoped access on every
 * request and records VIEW / DOWNLOAD in the audit trail.
 */
export async function readDocumentForActor(ctx: Ctx, docId: string, mode: "view" | "download") {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const doc = (await db.query<DocumentRow>("SELECT * FROM documents WHERE id = $1", [docId])).rows[0];
  if (!doc) throw notFound();
  const access = await caseAccess(db, actor.staffId, doc.application_id);
  if (!access.canView) {
    await auditOutsideTx(ctx, { action: mode === "view" ? "DOCUMENT_VIEW" : "DOCUMENT_DOWNLOAD", outcome: "DENIED", applicationId: doc.application_id, documentId: doc.id, documentVersion: doc.version_no });
    throw forbidden("You do not have access to documents on this request.");
  }
  if (doc.scan_status !== "CLEAN") throw forbidden("This file is quarantined or failed the malware scan and cannot be opened.");
  if (doc.purged_at) throw notFound("This document was purged under the retention policy.");
  const data = await objectStore().get(doc.storage_key);
  await auditOutsideTx(ctx, {
    action: mode === "view" ? "DOCUMENT_VIEW" : "DOCUMENT_DOWNLOAD",
    applicationId: doc.application_id,
    documentId: doc.id,
    documentVersion: doc.version_no,
    details: { category: doc.category, capacities: access.capacities },
  });
  return { doc, data };
}
