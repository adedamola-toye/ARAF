import { randomUUID } from "node:crypto";
import type { Db, Tx } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { config } from "../config";
import { sha256Hex, hmac, safeEqualHex } from "../crypto";
import { DomainError, forbidden, invalid, notFound } from "../errors";
import { objectStore } from "../storage";
import { documentScanner, sniffAllowedType, ALLOWED_EXTENSIONS, type ScanResult } from "../storage/scanner";
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
  { code: "APPLICATION_FORM", label: "Completed WakeelBoost application form", multiple: false },
  { code: "CONSENT_FORM", label: "Consent form", multiple: false },
  { code: "RENT_RECEIPT", label: "Recent rent receipt", multiple: false },
  { code: "CREDIT_REPORT", label: "Credit report", multiple: true },
  { code: "DSR_EXCEPTION_EVIDENCE", label: "DSR exception evidence (e.g. second bank statement)", multiple: true },
  { code: "GENERATED_OFFER", label: "Generated offer letter (editable Word)", multiple: false },
  { code: "GENERATED_OFFER_PDF", label: "Generated offer letter (PDF copy)", multiple: false },
  { code: "SIGNED_OFFER", label: "Signed offer letter", multiple: false },
  { code: "KYC", label: "KYC documents", multiple: true },
  { code: "PRE_DISBURSEMENT", label: "Pre-disbursement document", multiple: false },
  { code: "GSI_FORM", label: "GSI form", multiple: false },
  { code: "INSURANCE_SIGNED", label: "Customer-signed insurance document", multiple: false },
  { code: "INSURANCE_EVIDENCE", label: "Evidence of insurance (Credit Officer 3)", multiple: false },
  { code: "SUPPORTING", label: "Other supporting document", multiple: true },
  // Retail Asset Factory
  { code: "EMPLOYMENT_CONFIRMATION", label: "Employment and salary confirmation", multiple: false },
  { code: "PAYSLIP", label: "Payslip", multiple: true },
  { code: "VEHICLE_INVOICE", label: "Vehicle invoice", multiple: false },
  { code: "SUPPLIER_QUOTATION", label: "Supplier quotation or invoice (power solution)", multiple: false },
  { code: "VENDOR_CONFIRMATION_EMAIL", label: "Vendor confirmation email", multiple: false },
  { code: "CUSTOMER_REQUEST_LETTER", label: "Formal customer request letter", multiple: false },
  { code: "BUSINESS_PHOTO", label: "Business photograph", multiple: true },
  { code: "AFS", label: "Audited financial statements (AFS)", multiple: true },
  { code: "BUSINESS_OPERATIONS_EVIDENCE", label: "Evidence of business operations and financial capacity", multiple: true },
  { code: "VISIT_EVIDENCE", label: "Business / management visit evidence", multiple: true },
  { code: "DATA_ACCESS_CONSENT", label: "Data-access permission (configured purpose)", multiple: true },
  { code: "EXCEPTION_EVIDENCE", label: "Exception supporting evidence", multiple: true },
  { code: "CONTRACT_EVIDENCE", label: "Structure-specific contracting / acquisition evidence", multiple: true },
  { code: "CRMS_EVIDENCE", label: "CRMS evidence", multiple: true },
  { code: "PAYMENT_EVIDENCE", label: "Payment / disbursement evidence", multiple: true },
  { code: "FULFILMENT_EVIDENCE", label: "Delivery, installation, handover or POS deployment evidence", multiple: true },
  { code: "REPAYMENT_EVIDENCE", label: "Repayment evidence", multiple: true },
];

/** Photo categories (angles) captured with every business photograph. Visual content is confirmed by a reviewer, not automatically. */
export const PHOTO_CATEGORIES = ["FRONT", "SIGNAGE", "INTERIOR", "STOCK", "SURROUNDINGS", "RM_WITH_BUSINESS"] as const;
export type PhotoCategory = (typeof PHOTO_CATEGORIES)[number];
export const PHOTO_LABELS: Record<PhotoCategory, string> = {
  FRONT: "Shop front",
  SIGNAGE: "Signage / name board",
  INTERIOR: "Interior",
  STOCK: "Stock / goods",
  SURROUNDINGS: "Street / surroundings",
  RM_WITH_BUSINESS: "Relationship Manager with the business",
};
/** Categories that need statement / payslip coverage dates. */
export const COVERAGE_CATEGORIES = ["BANK_STATEMENT", "PAYSLIP"];
export const CATEGORY_LABEL = Object.fromEntries(DOC_CATEGORIES.map((c) => [c.code, c.label])) as Record<string, string>;

const INITIAL = ["BANK_STATEMENT", "CAC_CERTIFICATE", "SUPPLIER_INVOICE", "APPLICATION_FORM", "CONSENT_FORM", "RENT_RECEIPT", "SUPPORTING"];
export const PACK = ["SIGNED_OFFER", "KYC", "PRE_DISBURSEMENT", "GSI_FORM", "INSURANCE_SIGNED"];

const RETAIL_INITIAL = [
  "BANK_STATEMENT", "CAC_CERTIFICATE", "EMPLOYMENT_CONFIRMATION", "PAYSLIP", "CREDIT_REPORT", "VEHICLE_INVOICE", "SUPPLIER_QUOTATION",
  "SUPPLIER_INVOICE", "VENDOR_CONFIRMATION_EMAIL", "CUSTOMER_REQUEST_LETTER", "BUSINESS_PHOTO", "AFS", "BUSINESS_OPERATIONS_EVIDENCE",
  "VISIT_EVIDENCE", "DATA_ACCESS_CONSENT", "EXCEPTION_EVIDENCE", "SUPPORTING",
];
/** Evidence an explicitly assigned RM supplies for a Delight Officer case (proposal visit + RM photograph). */
export const ASSIGNED_RM_UPLOADS = ["BUSINESS_PHOTO", "VISIT_EVIDENCE", "SUPPORTING"];
export const RETAIL_UPLOADABLE_BY_STAGE: Partial<Record<Stage, string[]>> = {
  DRAFT: RETAIL_INITIAL,
  INITIATOR_CORRECTION: RETAIL_INITIAL,
  OSS_REVIEW: ["SUPPORTING"],
  TEAM_LEAD_REVIEW: ["VISIT_EVIDENCE", "SUPPORTING"],
  HRS_REVIEW: ["SUPPORTING"],
  HEAD_OF_UNIT_APPROVAL: ["SUPPORTING"],
  FIRST_CREDIT_REVIEW: ["CREDIT_REPORT", "EXCEPTION_EVIDENCE", "SUPPORTING"],
  CREDIT_CORRECTION: ["CREDIT_REPORT", "EXCEPTION_EVIDENCE", "SUPPORTING"],
  OFFER_PREPARATION: [...PACK_LIST(), "CONTRACT_EVIDENCE", "SUPPORTING"],
  CO3_PACK_REVIEW: ["INSURANCE_EVIDENCE", "SUPPORTING"],
  DISBURSEMENT_CHECK: ["CRMS_EVIDENCE", "SUPPORTING"],
  DISBURSEMENT_CORRECTION: ["INSURANCE_EVIDENCE", ...PACK_LIST(), "CONTRACT_EVIDENCE", "SUPPORTING"],
  DISBURSEMENT_BOOKING: ["SUPPORTING"],
  PAYMENT_RECONCILIATION: ["PAYMENT_EVIDENCE", "SUPPORTING"],
  FULFILMENT: ["FULFILMENT_EVIDENCE", "SUPPORTING"],
};
function PACK_LIST() {
  return ["SIGNED_OFFER", "KYC", "PRE_DISBURSEMENT", "GSI_FORM", "INSURANCE_SIGNED"];
}

/** Which categories the current task holder may upload at each stage. */
export const UPLOADABLE_BY_STAGE: Partial<Record<Stage, string[]>> = {
  DRAFT: INITIAL,
  INITIATOR_CORRECTION: INITIAL,
  FIRST_CREDIT_REVIEW: ["CREDIT_REPORT", "DSR_EXCEPTION_EVIDENCE", "SUPPORTING"],
  CREDIT_CORRECTION: ["CREDIT_REPORT", "DSR_EXCEPTION_EVIDENCE", "SUPPORTING"],
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
  meta?: Record<string, string>;
  review_status?: "ACCEPTED" | "REJECTED" | null;
  review_reason?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: Date | null;
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
  /** Retail metadata: photoCategory for business photos, coverageFrom/coverageTo for statements and payslips. */
  meta?: Record<string, string> | null;
}

/** Validate and normalise document metadata for retail uploads. */
export function validateDocumentMeta(category: string, raw: Record<string, string> | null | undefined, retail: boolean): Record<string, string> {
  const meta: Record<string, string> = {};
  if (!retail) return meta;
  if (category === "BUSINESS_PHOTO") {
    const pc = (raw?.photoCategory ?? "").trim();
    if (!(PHOTO_CATEGORIES as readonly string[]).includes(pc)) throw invalid("Choose the photograph category (angle).", { photoCategory: "Choose the photograph category." });
    meta.photoCategory = pc;
  }
  if (COVERAGE_CATEGORIES.includes(category)) {
    const from = (raw?.coverageFrom ?? "").trim();
    const to = (raw?.coverageTo ?? "").trim();
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!re.test(from) || !re.test(to)) throw invalid("Enter the coverage period (from and to dates) for this statement or payslip.", { coverageFrom: "Enter the period start date.", coverageTo: "Enter the period end date." });
    if (to < from) throw invalid("The coverage end date must be on or after the start date.", { coverageTo: "End is before start." });
    meta.coverageFrom = from;
    meta.coverageTo = to;
  }
  return meta;
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
    meta?: Record<string, string>;
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
       scan_status, generated, template_id, template_version, uploaded_by, uploaded_role, uploaded_at, stage, app_version_id, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [
      p.appId, p.category, slot, version, p.filename, p.mime, p.data.length, sha256Hex(p.data), p.storageKey, p.status,
      p.generated ?? false, p.templateId ?? null, p.templateVersion ?? null, ctx.actor!.staffId, p.role, ctx.now, p.stage, p.versionId,
      JSON.stringify(p.meta ?? {}),
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
  try {
    await objectStore().put(quarantineKey, input.data, mime);
  } catch (e) {
    console.error("[upload] object storage write failed", e);
    await auditOutsideTx(ctx, {
      action: "DOCUMENT_UPLOAD_FAILED",
      outcome: "FAILURE",
      applicationId: input.applicationId,
      details: { category: input.category, filename, reason: e instanceof Error ? e.message : String(e) },
    }).catch(() => undefined);
    throw new DomainError(
      "CONFIG",
      "Document storage is not available. An administrator must check the object storage configuration (STORAGE_DRIVER / S3 settings).",
    );
  }
  let rec: { id: string; version: number };
  try {
    rec = await withTx(async (tx) => {
      const app = (await tx.query("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [input.applicationId])).rows[0];
      if (!app) throw notFound();
      const task = (await tx.query("SELECT * FROM tasks WHERE application_id = $1 AND status = 'OPEN'", [app.id])).rows[0];
      let role: string | null = null;
      let allowed: string[] = [];
      const retail = app.workflow === "RETAIL";
      const byStage = retail ? RETAIL_UPLOADABLE_BY_STAGE : UPLOADABLE_BY_STAGE;
      if (app.suspended_at) throw forbidden("This request is suspended. Uploads are paused until it is resumed.");
      if (app.stage === "DRAFT" && app.initiator_id === actor.staffId) {
        allowed = byStage.DRAFT!;
        role = app.initiator_role;
      } else if (task && task.assignee_id === actor.staffId) {
        allowed = byStage[task.stage as Stage] ?? [];
        role = task.assignee_role;
        const held = await tx.query("SELECT 1 FROM role_assignments WHERE staff_id = $1 AND role = $2 AND active", [actor.staffId, role]);
        if (!held.rowCount) allowed = [];
      } else if (retail && app.assigned_rm_id === actor.staffId && (app.stage === "DRAFT" || app.stage === "INITIATOR_CORRECTION")) {
        // Explicitly assigned RM on a Delight Officer case supplies RM-specific evidence.
        const held = await tx.query("SELECT 1 FROM role_assignments WHERE staff_id = $1 AND role = 'RM' AND active", [actor.staffId]);
        if (held.rowCount) {
          allowed = ASSIGNED_RM_UPLOADS;
          role = "RM";
        }
      } else if (retail && input.category === "REPAYMENT_EVIDENCE") {
        const held = await tx.query("SELECT 1 FROM role_assignments WHERE staff_id = $1 AND role = 'COLLECTIONS_OFFICER' AND active", [actor.staffId]);
        const fac = await tx.query("SELECT 1 FROM facilities WHERE application_id = $1 AND status IN ('ACTIVE','IN_ARREARS','RESTRUCTURED')", [app.id]);
        if (held.rowCount && fac.rowCount) {
          allowed = ["REPAYMENT_EVIDENCE"];
          role = "COLLECTIONS_OFFICER";
        }
      }
      if (!allowed.includes(input.category)) {
        throw forbidden("You cannot upload this document type at the current stage.");
      }
      const meta = validateDocumentMeta(input.category, input.meta, retail);
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
        meta,
      });
      await audit(tx, ctx, {
        action: "DOCUMENT_UPLOADED",
        actorRole: role,
        applicationId: app.id,
        stage: app.stage,
        documentId: r.id,
        documentVersion: r.version,
        details: { category: input.category, filename, size: input.data.length, replaces: input.replacesDocumentId ?? null, meta },
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

  let res: ScanResult;
  try {
    const data = await objectStore().get(doc.storage_key);
    res = await documentScanner().scan(data);
  } catch (e) {
    // Keep the row quarantined so the worker can retry, but record why it is stuck.
    const detail = `Scan pending: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
    console.error("[scan] failed, leaving in quarantine", doc.id, e);
    await db.query("UPDATE documents SET scan_detail = $2 WHERE id = $1 AND scan_status = 'QUARANTINED'", [doc.id, detail]).catch(() => undefined);
    await auditOutsideTx(ctx, {
      action: "DOCUMENT_SCAN_FAILED",
      outcome: "FAILURE",
      applicationId: doc.application_id,
      documentId: doc.id,
      documentVersion: doc.version_no,
      details: { detail },
    }).catch(() => undefined);
    throw e;
  }

  if (res.deferred) {
    await db.query("UPDATE documents SET scan_detail = $2 WHERE id = $1 AND scan_status = 'QUARANTINED'", [doc.id, res.detail]).catch(() => undefined);
    return "QUARANTINED";
  }

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

/**
 * A reviewer (the current task holder at a review stage) marks a document as rejected (e.g. illegible,
 * wrong period) or accepted. Rejected documents no longer satisfy the document matrix.
 */
export async function reviewDocument(ctx: Ctx, docId: string, decision: "ACCEPTED" | "REJECTED", reason: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    const doc = (await tx.query<DocumentRow>("SELECT * FROM documents WHERE id = $1 FOR UPDATE", [docId])).rows[0];
    if (!doc) throw notFound();
    const task = (await tx.query("SELECT * FROM tasks WHERE application_id = $1 AND status = 'OPEN'", [doc.application_id])).rows[0];
    const reviewStages = ["OSS_REVIEW", "TEAM_LEAD_REVIEW", "HRS_REVIEW", "HEAD_OF_UNIT_APPROVAL", "FIRST_CREDIT_REVIEW", "SECOND_CREDIT_REVIEW", "CO3_PACK_REVIEW", "DISBURSEMENT_CHECK"];
    if (!task || task.assignee_id !== actor.staffId || !reviewStages.includes(task.stage)) throw forbidden("Only the reviewer currently assigned to this request can review documents.");
    const held = await tx.query("SELECT 1 FROM role_assignments WHERE staff_id = $1 AND role = $2 AND active", [actor.staffId, task.assignee_role]);
    if (!held.rowCount) throw forbidden();
    if (decision === "REJECTED" && reason.trim().length < 3) throw invalid("Give the reason the document is rejected.", { reason: "Reason required." });
    await tx.query("UPDATE documents SET review_status = $2, review_reason = $3, reviewed_by = $4, reviewed_at = $5 WHERE id = $1", [docId, decision, reason.trim() || null, actor.staffId, ctx.now]);
    await audit(tx, ctx, {
      action: decision === "REJECTED" ? "DOCUMENT_REJECTED_BY_REVIEWER" : "DOCUMENT_ACCEPTED_BY_REVIEWER",
      actorRole: task.assignee_role,
      applicationId: doc.application_id,
      stage: task.stage,
      documentId: doc.id,
      documentVersion: doc.version_no,
      reason: reason.trim() || null,
      details: { category: doc.category },
    });
  });
}
