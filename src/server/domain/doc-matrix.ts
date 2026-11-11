/**
 * Document matrix: requirements keyed by product (configuration), customer profile, financing structure,
 * amount band and workflow stage, evaluated against the documents on the case.
 *
 * Status per requirement: RECEIVED, MISSING, REJECTED (failed scan or rejected by a reviewer),
 * EXPIRED (coverage too old or too short), EXCEPTION_APPROVED (an approved exception stands in),
 * NOT_APPLICABLE (conditional requirement whose condition is not met).
 */
import { CATEGORY_LABEL, PHOTO_CATEGORIES, type DocumentRow } from "./documents";
import type { DocRequirement, DocStage, ProfileRules } from "./products";
import { addDaysToDateString } from "../time";

export type MatrixStatus = "RECEIVED" | "MISSING" | "REJECTED" | "EXPIRED" | "EXCEPTION_APPROVED" | "NOT_APPLICABLE";

export interface MatrixItem {
  code: string;
  label: string;
  requirement: DocRequirement["requirement"];
  stage: DocStage;
  applies: boolean;
  status: MatrixStatus;
  satisfied: boolean;
  detail: string;
  documentIds: string[];
  note: string | null;
}

export interface MatrixInput {
  rules: ProfileRules;
  structure: string | null;
  amountKobo: number | null;
  documents: DocumentRow[];
  /** Document codes covered by an APPROVED exception (e.g. "AFS"). */
  approvedExceptions: string[];
  /** Lagos business date the evaluation is made on (YYYY-MM-DD). */
  asOf: string;
  stages?: DocStage[];
}

/** Number of whole months covered by [from, to] (inclusive), conservative. */
export function monthsCovered(from: string, to: string): number {
  // Inclusive end date: 2026-01-01 .. 2026-06-30 is 6 months; 2026-01-15 .. 2026-07-13 is 5.
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ey, em, ed] = addDaysToDateString(to, 1).split("-").map(Number);
  return Math.max(0, (ey - fy) * 12 + (em - fm) - (ed < fd ? 1 : 0));
}

/** Merge coverage periods of several statements into the longest continuous span ending at the latest date. */
export function coverage(docs: DocumentRow[]): { from: string; to: string } | null {
  const spans = docs
    .map((d) => d.meta ?? {})
    .filter((m) => m.coverageFrom && m.coverageTo)
    .map((m) => ({ from: m.coverageFrom!, to: m.coverageTo! }))
    .sort((a, b) => (a.to < b.to ? 1 : -1));
  if (!spans.length) return null;
  const to = spans[0].to;
  let from = spans[0].from;
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of spans) {
      if (s.from < from && s.to >= addDaysToDateString(from, -1)) {
        from = s.from;
        changed = true;
      }
    }
  }
  return { from, to };
}

function usable(d: DocumentRow) {
  return !d.superseded_at && d.scan_status === "CLEAN" && !d.purged_at && d.review_status !== "REJECTED";
}

export function evaluateMatrix(i: MatrixInput): MatrixItem[] {
  const out: MatrixItem[] = [];
  for (const req of i.rules.documents) {
    if (i.stages && !i.stages.includes(req.stage)) continue;
    let applies = req.requirement !== "OPTIONAL";
    if (req.amountAboveKobo !== null) applies = applies && i.amountKobo !== null && i.amountKobo > req.amountAboveKobo;
    if (req.structures && req.structures.length) applies = applies && !!i.structure && req.structures.includes(i.structure as never);
    const all = i.documents.filter((d) => d.category === req.code && !d.superseded_at);
    const good = all.filter(usable);
    const rejected = all.filter((d) => d.scan_status === "REJECTED" || d.review_status === "REJECTED");
    let status: MatrixStatus = good.length >= req.minCount ? "RECEIVED" : rejected.length ? "REJECTED" : "MISSING";
    let detail = good.length ? `${good.length} received` : rejected.length ? `Rejected: ${rejected.map((d) => d.review_reason ?? d.scan_detail ?? "failed check").join("; ")}` : "Not uploaded";
    if (req.minCount > 1) detail = `${good.length} of ${req.minCount} received`;

    if (status === "RECEIVED" && req.coverageFrom) {
      const months = req.coverageFrom === "statementMonths" ? i.rules.statementMonths : i.rules.payslipMonths;
      const cov = coverage(good);
      if (months === null) {
        status = "MISSING";
        detail = "Required period is not configured";
      } else if (!cov) {
        status = "MISSING";
        detail = "Coverage dates not recorded";
      } else {
        const m = monthsCovered(cov.from, cov.to);
        detail = `Covers ${cov.from} to ${cov.to} (${m} of ${months} months)`;
        if (m < months) status = "EXPIRED";
        else if (cov.to > i.asOf) {
          status = "EXPIRED";
          detail += "; end date is in the future";
        } else if (i.rules.statementMaxAgeDays !== null && addDaysToDateString(cov.to, i.rules.statementMaxAgeDays) < i.asOf) {
          status = "EXPIRED";
          detail += `; older than ${i.rules.statementMaxAgeDays} days`;
        }
      }
    }
    if (status !== "RECEIVED" && req.exceptionType && i.approvedExceptions.includes(req.code)) {
      status = "EXCEPTION_APPROVED";
      detail = "Approved exception on file";
    }
    if (!applies && status !== "RECEIVED") status = "NOT_APPLICABLE";
    out.push({
      code: req.code,
      label: CATEGORY_LABEL[req.code] ?? req.code,
      requirement: req.requirement,
      stage: req.stage,
      applies,
      status,
      satisfied: !applies || status === "RECEIVED" || status === "EXCEPTION_APPROVED",
      detail,
      documentIds: good.map((d) => d.id),
      note: req.note,
    });
  }
  return out;
}

export interface PhotoCheck {
  distinctAngles: number;
  required: number;
  rmPhotoPresent: boolean;
  rmPhotoRequired: boolean;
  ok: boolean;
  messages: string[];
}

/**
 * Business photographs: at least N distinct angles (distinct files and categories) and, when required,
 * a photograph categorised as the RM with the business uploaded by the responsible RM. The platform only
 * checks metadata; a reviewer confirms the visual content.
 */
export function checkPhotos(docs: DocumentRow[], rules: ProfileRules, responsibleRmId: string | null): PhotoCheck {
  const photos = docs.filter((d) => d.category === "BUSINESS_PHOTO" && usable(d));
  const seenHash = new Set<string>();
  const angles = new Set<string>();
  for (const p of photos) {
    if (seenHash.has(p.sha256)) continue;
    seenHash.add(p.sha256);
    const c = p.meta?.photoCategory;
    if (c && (PHOTO_CATEGORIES as readonly string[]).includes(c)) angles.add(c);
  }
  const rmPhotoPresent = photos.some((p) => p.meta?.photoCategory === "RM_WITH_BUSINESS" && (!responsibleRmId || p.uploaded_by === responsibleRmId));
  const required = rules.businessPhotos.minDistinct;
  const messages: string[] = [];
  if (angles.size < required) messages.push(`Upload at least ${required} business photographs from different angles (${angles.size} distinct so far).`);
  if (rules.businessPhotos.rmPhotoRequired && !rmPhotoPresent) messages.push("Upload a photograph showing the responsible Relationship Manager with the business (uploaded by that RM).");
  return { distinctAngles: angles.size, required, rmPhotoPresent, rmPhotoRequired: rules.businessPhotos.rmPhotoRequired, ok: messages.length === 0, messages };
}
