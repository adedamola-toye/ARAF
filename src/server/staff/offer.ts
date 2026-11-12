/**
 * Staff Personal Financing offer letters.
 *  - Generated only from the ACTIVE staff template that the bank has approved for production
 *    (Legal and Shariah wording is the bank's; this code fills placeholders and never adds terms).
 *  - Generated only from the approved terms, after checking their fingerprint.
 *  - The signed copy must be returned within 24 hours of issue. The deadline is stored on the
 *    request and enforced by the server at upload, at submission and by the background job.
 */
import type { Db, Tx } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { systemCtx } from "../context";
import { audit } from "../audit";
import { conflict, DomainError, forbidden, gate, invalid, notFound } from "../errors";
import { formatDateOnly, formatLagos, lagosDate } from "../time";
import { holdsRole } from "../domain/access";
import { escapeHtml } from "../domain/offer";
import { PLATFORM_NAME } from "../brand";
import { bpsLabel, formatNairaKobo, OFFER_ACCEPTANCE_HOURS, OFFER_REMINDER_HOURS } from "@/lib/staff-financing";
import { alertOperations, auditDenied, checkLock, expectStatus, lockRequest, notifyStaff, recordEvent, transition, type StaffRequestRow } from "./core";
import { storeGeneratedStaffDocument } from "./documents";
import { assignDisbursementOfficer } from "./disbursement";
import { termsIntact } from "./requests";

/** Placeholders the staff offer template may use. */
export const STAFF_OFFER_PLACEHOLDERS = [
  "ref", "offer_date", "approval_date", "acceptance_deadline", "staff_name", "staff_id", "department", "unit",
  "approved_amount", "deduction_rate", "deduction_amount", "net_amount", "tenor", "salary_account", "salary_account_name",
] as const;
/** Placeholders every staff template must contain. */
export const REQUIRED_STAFF_OFFER_PLACEHOLDERS = ["ref", "staff_name", "staff_id", "approved_amount", "deduction_amount", "net_amount", "acceptance_deadline"];

export function validateStaffTemplate(html: string): string[] {
  const errors: string[] = [];
  if (/<script\b|\son\w+\s*=|javascript:/i.test(html)) errors.push("Templates must not contain scripts or event handlers.");
  const found = new Set([...html.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]));
  for (const f of found) if (!(STAFF_OFFER_PLACEHOLDERS as readonly string[]).includes(f)) errors.push(`Unknown placeholder {{${f}}}.`);
  for (const r of REQUIRED_STAFF_OFFER_PLACEHOLDERS) if (!found.has(r)) errors.push(`Missing placeholder {{${r}}}.`);
  return errors;
}

export async function activeStaffTemplate(q: Db) {
  return (await q.query("SELECT * FROM offer_templates WHERE status = 'ACTIVE' AND applicant_type = 'STAFF' ORDER BY activated_at DESC NULLS LAST LIMIT 1")).rows[0] ?? null;
}

/** Super Admin loads a new version of the bank's staff offer wording (inactive until activated and approved). */
export async function createStaffTemplateVersion(ctx: Ctx, p: { bodyHtml: string; notes?: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can load offer templates.");
    const errors = validateStaffTemplate(p.bodyHtml);
    if (errors.length) throw invalid(errors.join(" "));
    const name = "Staff personal financing offer";
    const v = (await tx.query<{ max: number | null }>("SELECT max(version) AS max FROM offer_templates WHERE name = $1", [name])).rows[0].max ?? 0;
    const r = await tx.query<{ id: string }>(
      `INSERT INTO offer_templates (name, version, format, applicant_type, body_html, status, production_approved, notes, created_by, created_at)
       VALUES ($1,$2,'HTML','STAFF',$3,'DRAFT',false,$4,$5,$6) RETURNING id`,
      [name, v + 1, p.bodyHtml, p.notes ?? null, actor.staffId, ctx.now],
    );
    await audit(tx, ctx, { action: "TEMPLATE_CREATED", actorRole: "SUPER_ADMIN", details: { templateId: r.rows[0].id, name, version: v + 1, applicantType: "STAFF" } });
    return r.rows[0].id;
  });
}

function offerValues(req: StaffRequestRow, now: Date, deadline: Date): Record<string, string> {
  const t = req.approved_terms as Record<string, unknown>;
  return {
    ref: req.ref,
    offer_date: formatDateOnly(lagosDate(now)),
    approval_date: formatDateOnly(lagosDate(new Date(req.approved_at))),
    acceptance_deadline: `${formatLagos(deadline)} (Lagos time)`,
    staff_name: String(t.staffName ?? ""),
    staff_id: String(t.staffNumber ?? ""),
    department: req.department ?? "",
    unit: req.unit ?? "",
    approved_amount: formatNairaKobo(Number(t.grossKobo)),
    deduction_rate: bpsLabel(Number(t.deductionRateBps)),
    deduction_amount: formatNairaKobo(Number(t.deductionKobo)),
    net_amount: formatNairaKobo(Number(t.netKobo)),
    tenor: t.tenorMonths ? `${t.tenorMonths} months` : "As stated in the bank's terms",
    salary_account: String(t.salaryAccountNumber ?? ""),
    salary_account_name: String(t.salaryAccountName ?? ""),
  };
}

/**
 * Generate and issue the offer for an APPROVED request. When generation is not possible (no active
 * staff template, or the template is not bank-approved) the request stays APPROVED, the reason is
 * recorded and operations are alerted; nothing is issued and no deadline starts.
 */
export async function issueOffer(tx: Tx, ctx: Ctx, req: StaffRequestRow): Promise<StaffRequestRow> {
  if (req.status !== "APPROVED") return req;
  if (!termsIntact(req)) throw gate("The approved terms fingerprint does not match the request. Offer generation stopped.");
  const tpl = await activeStaffTemplate(tx);
  let blocked: string | null = null;
  if (!tpl) blocked = "No active staff personal financing offer template exists. A Super Admin must load the bank-approved Legal and Shariah wording.";
  else if (!tpl.production_approved) blocked = `The staff offer template (v${tpl.version}) has not been approved by the bank for production use.`;
  if (blocked) {
    if (req.offer_blocked_reason === blocked) return req;
    const fresh = await transition(tx, ctx, req, { action: "OFFER_GENERATION_BLOCKED", role: "SYSTEM", comments: blocked, set: { offer_blocked_reason: blocked } });
    await alertOperations(tx, ctx, fresh, "OFFER_BLOCKED", "Staff offer letter cannot be generated", [`The offer letter for ${req.ref} cannot be generated: ${blocked}`]);
    return fresh;
  }
  const deadline = new Date(ctx.now.getTime() + OFFER_ACCEPTANCE_HOURS * 3600_000);
  const values = offerValues(req, ctx.now, deadline);
  const body = String(tpl.body_html).replace(/\{\{([a-z_]+)\}\}/g, (m: string, k: string) => (k in values ? escapeHtml(values[k]) : m));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Offer ${escapeHtml(req.ref)}</title>
<style>body{font-family:Georgia,serif;max-width:800px;margin:24px auto;padding:0 16px;color:#111;line-height:1.5}table{border-collapse:collapse}th,td{text-align:left;padding:4px 12px 4px 0;vertical-align:top}</style></head>
<body><p style="font:600 12px sans-serif;color:#555">${escapeHtml(PLATFORM_NAME)} · ${escapeHtml(req.ref)}</p>${body}</body></html>`;
  const docId = await storeGeneratedStaffDocument(tx, req, {
    category: "GENERATED_OFFER",
    filename: `Offer-${req.ref}-t${tpl.version}.html`,
    mime: "text/html",
    data: Buffer.from(html, "utf8"),
    role: "SYSTEM",
    now: ctx.now,
    actorId: ctx.actor?.staffId ?? null,
  });
  const fresh = await transition(tx, ctx, req, {
    action: "OFFER_ISSUED",
    to: "AWAITING_SIGNED_OFFER",
    role: "SYSTEM",
    outcome: "OFFER_ISSUED",
    documentIds: [docId],
    set: { offer_template_id: tpl.id, offer_template_version: tpl.version, offer_issued_at: ctx.now, offer_deadline_at: deadline, offer_document_id: docId, offer_blocked_reason: null },
    details: { templateVersion: tpl.version, deadline: deadline.toISOString(), termsSha256: req.approved_terms_sha256 },
  });
  await notifyStaff(tx, ctx, fresh, "OFFER_ISSUED", [fresh.applicant_id], "Your offer letter is ready", [
    `The offer letter for your staff financing request ${req.ref} is ready.`,
    `Sign it and upload the signed copy by ${formatLagos(deadline)} (Lagos time). After that the offer expires and cannot be disbursed.`,
  ]);
  return fresh;
}

/** Retry generation for approved requests whose offer was blocked (run by the worker and by admins). */
export async function retryBlockedOffers(now = new Date()) {
  const tpl = await activeStaffTemplate(db);
  if (!tpl || !tpl.production_approved) return 0;
  const ids = (await db.query<{ id: string }>("SELECT id FROM staff_requests WHERE status = 'APPROVED' AND offer_issued_at IS NULL LIMIT 20")).rows;
  let n = 0;
  for (const { id } of ids) {
    await withTx(async (tx) => {
      const req = await lockRequest(tx, id);
      const fresh = await issueOffer(tx, systemCtx(now), req);
      if (fresh.status === "AWAITING_SIGNED_OFFER") n++;
    });
  }
  return n;
}

async function expireOne(tx: Tx, ctx: Ctx, req: StaffRequestRow) {
  const fresh = await transition(tx, ctx, req, {
    action: "OFFER_EXPIRED",
    to: "OFFER_EXPIRED",
    role: "SYSTEM",
    outcome: "EXPIRED_OFFER_NOT_ACCEPTED",
    comments: `The signed offer was not returned by ${formatLagos(req.offer_deadline_at)} (Lagos time).`,
    set: { expired_at: ctx.now },
  });
  await notifyStaff(tx, ctx, fresh, "OFFER_EXPIRED", [fresh.applicant_id], "Your offer has expired", [
    `The offer for staff financing request ${req.ref} expired because the signed copy was not returned within ${OFFER_ACCEPTANCE_HOURS} hours.`,
    "The request cannot be disbursed. Its records are kept.",
  ]);
  return fresh;
}

/** Background job: expire offers whose deadline passed without a signed copy. */
export async function expireStaffOffers(now = new Date()) {
  const ids = (
    await db.query<{ id: string }>(
      "SELECT id FROM staff_requests WHERE status = 'AWAITING_SIGNED_OFFER' AND signed_offer_received_at IS NULL AND offer_deadline_at <= $1 LIMIT 50",
      [now],
    )
  ).rows;
  let n = 0;
  for (const { id } of ids) {
    await withTx(async (tx) => {
      const req = await lockRequest(tx, id);
      if (req.status !== "AWAITING_SIGNED_OFFER" || req.signed_offer_received_at || new Date(req.offer_deadline_at) > now) return;
      await expireOne(tx, systemCtx(now), req);
      n++;
    });
  }
  return n;
}

/** Background job: one reminder when the deadline is close. */
export async function remindStaffOffers(now = new Date()) {
  const ids = (
    await db.query<{ id: string }>(
      `SELECT id FROM staff_requests WHERE status = 'AWAITING_SIGNED_OFFER' AND signed_offer_received_at IS NULL AND offer_reminder_sent_at IS NULL
          AND offer_deadline_at > $1 AND offer_deadline_at <= $2 LIMIT 50`,
      [now, new Date(now.getTime() + OFFER_REMINDER_HOURS * 3600_000)],
    )
  ).rows;
  for (const { id } of ids) {
    await withTx(async (tx) => {
      const req = await lockRequest(tx, id);
      if (req.offer_reminder_sent_at) return;
      const ctx = systemCtx(now);
      const fresh = await transition(tx, ctx, req, { action: "OFFER_DEADLINE_REMINDER", role: "SYSTEM", set: { offer_reminder_sent_at: now } });
      await notifyStaff(tx, ctx, fresh, "OFFER_REMINDER", [fresh.applicant_id], "Offer deadline approaching", [
        `Your signed offer for ${req.ref} must be uploaded by ${formatLagos(req.offer_deadline_at)} (Lagos time).`,
      ]);
    });
  }
  return ids.length;
}

/**
 * Applicant submits the signed offer. Checked on the server: deadline (the request expires on the
 * spot if it has passed), the file is the applicant's own clean SIGNED_OFFER upload made after the
 * offer was issued, and the approved terms are intact. A Disbursement Officer is then assigned.
 */
export async function submitSignedOffer(ctx: Ctx, id: string, input: { documentId: string; confirmed?: boolean; lockVersion?: number | null }) {
  let expired = false;
  try {
    const res = await withTx(async (tx) => {
      const actor = ctx.actor;
      if (!actor) throw forbidden();
      const req = await lockRequest(tx, id);
      if (req.applicant_id !== actor.staffId) throw forbidden("Only the applicant can submit the signed offer.");
      if (req.signed_offer_received_at && req.signed_offer_document_id === input.documentId) return req;
      expectStatus(req, ["AWAITING_SIGNED_OFFER"], "Submitting the signed offer");
      checkLock(req, input.lockVersion);
      if (req.signed_offer_received_at) throw conflict("A signed offer has already been received for this request.");
      if (new Date(req.offer_deadline_at) <= ctx.now) {
        await expireOne(tx, ctx, req);
        expired = true;
        return null;
      }
      if (!input.confirmed) throw invalid("Confirm that the uploaded file is your signed offer letter.", { confirmed: "Confirmation required." });
      const doc = (await tx.query("SELECT * FROM staff_request_documents WHERE id = $1 AND request_id = $2 AND removed_at IS NULL", [input.documentId, req.id])).rows[0];
      if (!doc || doc.category !== "SIGNED_OFFER" || doc.uploaded_by !== actor.staffId) throw invalid("Upload your signed offer letter first.");
      if (new Date(doc.uploaded_at) < new Date(req.offer_issued_at)) throw invalid("The signed offer must be uploaded after the offer was issued.");
      if (doc.scan_status === "QUARANTINED") throw gate("The signed offer is still being scanned. Try again in a moment.");
      if (doc.scan_status === "REJECTED") throw gate("The signed offer failed the malware scan. Upload a clean copy.");
      if (!termsIntact(req)) throw gate("The approved terms fingerprint does not match the request. Contact the Product Manager.");
      let fresh = await transition(tx, ctx, req, {
        action: "SIGNED_OFFER_RECEIVED",
        role: "APPLICANT",
        outcome: "OFFER_ACCEPTED",
        documentIds: [doc.id],
        set: { signed_offer_document_id: doc.id, signed_offer_received_at: ctx.now },
      });
      await notifyStaff(tx, ctx, fresh, "SIGNED_OFFER_RECEIVED", [fresh.applicant_id], "Signed offer received", [`We received your signed offer for ${req.ref}. It now goes to a Disbursement Officer.`]);
      fresh = await assignDisbursementOfficer(tx, ctx, fresh);
      return fresh;
    });
    if (expired) throw gate("The offer deadline has passed. The offer has expired and the request cannot be disbursed.");
    return res!;
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") await auditDenied(ctx, id, "SIGNED_OFFER", e.message);
    throw e;
  }
}

/** Super Admin: retry offer generation for one request (after the template is approved). */
export async function retryOfferFor(ctx: Ctx, id: string) {
  return withTx(async (tx) => {
    if (!ctx.actor || !(await holdsRole(tx, ctx.actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can retry offer generation.");
    const req = await lockRequest(tx, id);
    if (req.status !== "APPROVED") throw notFound("This request is not waiting for an offer letter.");
    const fresh = await issueOffer(tx, ctx, req);
    if (fresh.status !== "AWAITING_SIGNED_OFFER") throw gate(fresh.offer_blocked_reason ?? "The offer could not be generated.");
    await recordEvent(tx, ctx, fresh, { action: "OFFER_RETRY_BY_ADMIN", role: "SUPER_ADMIN" });
    return fresh;
  });
}
