/**
 * Vendor Financing — Team Lead business photograph verification.
 *
 * Applies only to RM-originated Vendor Financing at Team Lead review, when the Super Admin switch
 * "Vendor Financing Business Photograph Review" is ON at the moment the request enters that stage (the
 * value is snapshotted, so changing the switch never alters a review in progress).
 *
 * The Team Lead either uploads an existing photograph of the business (gallery or files; never the camera)
 * and confirms it relates to the business the RM presented, or skips with a meaningful reason. Either
 * choice lets the existing approval continue; until one is recorded the Team Lead's decision (recommend,
 * return or reject) is refused by the server. A skip notifies every active Unit Head (in-app and email).
 * Existing KYC, BVN and Seedfi controls are untouched.
 */
import type { Db, Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { forbidden, gate, invalid, notFound, conflict } from "../errors";
import { isEnabled } from "./switches";
import { notify } from "./notifications";
import { enqueueEmail } from "../notify/outbox";
import { formatLagos } from "../time";
import type { AppRow } from "./assignment";

export const PHOTO_REVIEW_PRODUCT = "VENDOR_FINANCING";
export const TL_PHOTO_CATEGORY = "TL_BUSINESS_PHOTO";
export const MIN_SKIP_REASON = 10;
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

export interface PhotoReview {
  id: string;
  application_id: string;
  required: boolean;
  entered_at: Date;
  decision: "UPLOADED" | "SKIPPED" | null;
  document_id: string | null;
  skip_reason: string | null;
  decided_by: string | null;
  decided_by_name?: string | null;
  decided_at: Date | null;
}

const applies = (app: Pick<AppRow, "product_code" | "initiator_role">) => app.product_code === PHOTO_REVIEW_PRODUCT && app.initiator_role === "RM";

/** Called whenever a request enters Team Lead review: opens a new review cycle with the switch snapshot. */
export async function enterTeamLeadReview(tx: Tx, app: AppRow, now: Date) {
  if (!applies(app)) return;
  await tx.query("UPDATE vf_photo_reviews SET superseded_at = $2 WHERE application_id = $1 AND superseded_at IS NULL", [app.id, now]);
  await tx.query("INSERT INTO vf_photo_reviews (application_id, required, entered_at) VALUES ($1,$2,$3)", [app.id, await isEnabled(tx, "VF_TL_PHOTO_REVIEW"), now]);
}

export async function currentPhotoReview(q: Db, appId: string): Promise<PhotoReview | null> {
  return (
    (
      await q.query<PhotoReview>(
        "SELECT r.*, s.full_name AS decided_by_name FROM vf_photo_reviews r LEFT JOIN staff s ON s.id = r.decided_by WHERE r.application_id = $1 ORDER BY r.entered_at DESC LIMIT 1",
        [appId],
      )
    ).rows[0] ?? null
  );
}

/** Every skipped photograph on a request (all review cycles), for the Unit Head and the audit view. */
export async function photoSkips(q: Db, appId: string) {
  return (
    await q.query<{ skip_reason: string; decided_at: Date; team_lead: string }>(
      "SELECT r.skip_reason, r.decided_at, s.full_name AS team_lead FROM vf_photo_reviews r JOIN staff s ON s.id = r.decided_by WHERE r.application_id = $1 AND r.decision = 'SKIPPED' ORDER BY r.decided_at DESC",
      [appId],
    )
  ).rows;
}

/** Server-side gate on the Team Lead's decision. */
export async function assertPhotoReviewDone(tx: Tx, appId: string) {
  const r = (await tx.query<PhotoReview>("SELECT * FROM vf_photo_reviews WHERE application_id = $1 AND superseded_at IS NULL", [appId])).rows[0];
  if (r && r.required && !r.decision) throw gate("Complete Business Photograph Verification first: upload an existing photograph of the business, or skip it and give the reason.");
}

function isImage(data: Buffer): string | null {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.subarray(0, 4).toString("binary") === "RIFF" && data.subarray(8, 12).toString("binary") === "WEBP") return "image/webp";
  if (data.subarray(4, 12).toString("binary").startsWith("ftyphei") || data.subarray(4, 12).toString("binary").startsWith("ftypmif")) return "image/heic";
  return null;
}
/** Images only (JPEG, PNG, WebP, HEIC), checked from the file content. */
export function checkPhotoFile(data: Buffer) {
  if (!data.length) throw invalid("Choose the photograph.", { photo: "Choose a photograph." });
  if (!isImage(data)) throw invalid("Upload a photograph (JPEG, PNG, WebP or HEIC).", { photo: "Only photographs can be uploaded here." });
}

async function lockReview(tx: Tx, ctx: Ctx, appId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!/^[0-9a-f-]{36}$/i.test(appId)) throw notFound();
  const app = (await tx.query<AppRow>("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [appId])).rows[0];
  if (!app) throw notFound();
  const task = (await tx.query<{ id: string; stage: string; assignee_id: string | null }>("SELECT id, stage, assignee_id FROM tasks WHERE application_id = $1 AND status = 'OPEN'", [appId])).rows[0];
  if (!task || task.stage !== "TEAM_LEAD_REVIEW" || task.assignee_id !== actor.staffId) throw forbidden("Only the Team Lead reviewing this request can record the business photograph verification.");
  const r = (await tx.query<PhotoReview>("SELECT * FROM vf_photo_reviews WHERE application_id = $1 AND superseded_at IS NULL FOR UPDATE", [appId])).rows[0];
  if (!r || !r.required) throw conflict("Business photograph verification is not required for this review.");
  if (r.decision) throw conflict("The business photograph verification has already been recorded for this review.");
  return { app, review: r, actor };
}

export async function recordPhotoUpload(ctx: Ctx, appId: string, p: { documentId: string; confirmed: boolean }) {
  return withTx(async (tx) => {
    const { app, review, actor } = await lockReview(tx, ctx, appId);
    if (!p.confirmed) throw invalid("Confirm that the photograph shows the business the Relationship Manager presented.", { confirmed: "Confirm the photograph relates to this business." });
    const doc = (await tx.query<{ id: string; category: string; mime_type: string; uploaded_by: string }>("SELECT id, category, mime_type, uploaded_by FROM documents WHERE id = $1 AND application_id = $2", [p.documentId, appId])).rows[0];
    if (!doc || doc.category !== TL_PHOTO_CATEGORY || doc.uploaded_by !== actor.staffId) throw invalid("The photograph was not found on this request.", { photo: "Upload the photograph again." });
    if (!IMAGE_MIMES.includes(doc.mime_type)) throw invalid("Only photographs can be recorded here.", { photo: "Not a photograph." });
    await tx.query("UPDATE vf_photo_reviews SET decision = 'UPLOADED', document_id = $2, confirmed = true, decided_by = $3, decided_at = $4 WHERE id = $1", [review.id, doc.id, actor.staffId, ctx.now]);
    await audit(tx, ctx, { action: "VF_BUSINESS_PHOTO_UPLOADED", actorRole: "TEAM_LEAD", applicationId: app.id, stage: "TEAM_LEAD_REVIEW", documentId: doc.id, details: { reviewId: review.id, confirmedRelatesToBusiness: true } });
    return { ok: true };
  });
}

export async function recordPhotoSkip(ctx: Ctx, appId: string, reason: string) {
  return withTx(async (tx) => {
    const { app, review, actor } = await lockReview(tx, ctx, appId);
    const why = (reason ?? "").replace(/\s+/g, " ").trim();
    if (why.length < MIN_SKIP_REASON) throw invalid(`Give the reason for not uploading the business photograph (at least ${MIN_SKIP_REASON} characters).`, { skipReason: "Enter the reason for not uploading the business photograph." });
    await tx.query("UPDATE vf_photo_reviews SET decision = 'SKIPPED', skip_reason = $2, decided_by = $3, decided_at = $4 WHERE id = $1", [review.id, why, actor.staffId, ctx.now]);
    await audit(tx, ctx, { action: "VF_BUSINESS_PHOTO_SKIPPED", actorRole: "TEAM_LEAD", applicationId: app.id, stage: "TEAM_LEAD_REVIEW", reason: why, details: { reviewId: review.id } });
    // Notify every active Unit Head (in-app and email).
    const info = (
      await tx.query<{ ref: string; customer_name: string | null; rm: string | null; tl: string }>(
        `SELECT a.ref, a.customer_name, rm.full_name AS rm, tl.full_name AS tl FROM applications a LEFT JOIN staff rm ON rm.id = a.initiator_id JOIN staff tl ON tl.id = $2 WHERE a.id = $1`,
        [app.id, actor.staffId],
      )
    ).rows[0];
    const uhs = (await tx.query<{ id: string; email: string }>("SELECT DISTINCT s.id, s.email FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.role = 'UNIT_HEAD' AND ra.active AND s.status = 'ACTIVE'")).rows;
    const when = formatLagos(ctx.now);
    const body = [
      `Application: ${info.ref}`,
      `Customer / business: ${info.customer_name ?? "—"}`,
      `Originating Relationship Manager: ${info.rm ?? "—"}`,
      `Reviewing Team Lead: ${info.tl}`,
      `Reason given: ${why}`,
      `Date and time: ${when}`,
      "",
      "This is not a rejection. Review the reason before you approve, return or reject the facility.",
    ].join("\n");
    for (const u of uhs) {
      await notify(tx, ctx.now, { recipientId: u.id, kind: "VF_PHOTO_SKIPPED", title: `Business Photograph Not Uploaded — ${info.ref}`, body, applicationId: app.id, link: `/requests/${app.id}`, dedupeKey: `vf-photo-skip:${review.id}` });
    }
    if (uhs.length) await enqueueEmail(tx, ctx.now, { kind: "VF_PHOTO_SKIPPED", dedupeKey: `vf-photo-skip:${review.id}`, applicationId: app.id, to: uhs.map((u) => u.email), subject: `Business Photograph Not Uploaded — ${info.ref}`, text: body });
    await audit(tx, ctx, { action: "UNIT_HEAD_NOTIFIED", applicationId: app.id, details: { kind: "VF_PHOTO_SKIPPED", reviewId: review.id, recipients: uhs.length } });
    return { ok: true, notified: uhs.length, when };
  });
}
