/**
 * Invoice confirmation. After final approval, the current supplier / vehicle invoice (or quotation) is sent
 * automatically to the Invoice Confirmation Officer, who confirms it with the issuer, uploads the issuer's
 * response and marks it Confirmation Completed, or returns it to the initiator with a reason. A replacement
 * invoice supersedes the open confirmation and is sent again. One queue for all products on the
 * application workflows (Staff Salary Advance and Altphones are not part of it).
 */
import { db, withTx, type Db, type Tx } from "../db";
import type { Ctx } from "../context";
import { systemCtx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { enqueueEmail } from "../notify/outbox";
import { config } from "../config";
import { notify } from "./notifications";
import { holdsRole } from "./access";
import { INVOICE_CATEGORIES, CATEGORY_LABEL } from "./documents";
import { CLOSING_STAGES } from "./closing-docs";

export const IC_STATUS_LABELS: Record<string, string> = {
  PENDING_DISPATCH: "Awaiting dispatch",
  PENDING: "Pending confirmation",
  RETURNED: "Returned to initiator",
  COMPLETED: "Confirmation Completed",
  DISPATCH_FAILED: "Not dispatched — no officer available",
  SUPERSEDED: "Superseded by a newer invoice",
};
const OPEN = ["PENDING_DISPATCH", "PENDING", "DISPATCH_FAILED"];
export const OFFICER_ROLE = "INVOICE_CONFIRMATION_OFFICER";

export async function icSettings(q: Db): Promise<{ officer_emails: string[] }> {
  return (await q.query("SELECT officer_emails FROM invoice_confirmation_settings WHERE id = 1")).rows[0] ?? { officer_emails: [] };
}

/** First configured officer (primary, then backups) who is active, holds the role and is not the initiator. */
async function chooseOfficer(tx: Tx, initiatorId: string): Promise<{ id: string; email: string; full_name: string } | null> {
  const { officer_emails } = await icSettings(tx);
  for (const email of officer_emails) {
    const s = (
      await tx.query<{ id: string; email: string; full_name: string }>(
        `SELECT s.id, s.email, s.full_name FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.role = $2 AND ra.active
          WHERE s.email = lower($1) AND s.status = 'ACTIVE'`,
        [email, OFFICER_ROLE],
      )
    ).rows[0];
    if (s && s.id !== initiatorId) return s;
  }
  return null;
}

const link = (id: string) => `${config.appUrl.replace(/\/$/, "")}/invoice-confirmation/${id}`;

/** Send the current invoice for confirmation if it has not been sent (idempotent; called after approval, uploads and by the worker). */
export async function dispatchForApplication(appId: string, now = new Date()): Promise<"SENT" | "FAILED" | "NONE"> {
  return withTx(async (tx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (await tx.query<Record<string, any>>("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [appId])).rows[0];
    if (!app || !CLOSING_STAGES.includes(app.stage)) return "NONE";
    const inv = (
      await tx.query<{ id: string; version_no: number; category: string; filename: string }>(
        `SELECT id, version_no, category, filename FROM documents WHERE application_id = $1 AND category = ANY($2) AND superseded_at IS NULL AND scan_status = 'CLEAN'
          ORDER BY uploaded_at DESC LIMIT 1`,
        [appId, INVOICE_CATEGORIES],
      )
    ).rows[0];
    if (!inv) return "NONE";
    const ctx = systemCtx(now);
    const already = (await tx.query("SELECT id, status FROM invoice_confirmations WHERE invoice_document_id = $1", [inv.id])).rows[0];
    if (already && already.status !== "DISPATCH_FAILED") return "NONE";
    // A newer invoice supersedes whatever is still open for an older one.
    const superseded = await tx.query(
      `UPDATE invoice_confirmations SET status = 'SUPERSEDED', lock_version = lock_version + 1 WHERE application_id = $1 AND status = ANY($2) AND invoice_document_id <> $3 RETURNING id, officer_id`,
      [appId, OPEN, inv.id],
    );
    for (const s of superseded.rows) await audit(tx, ctx, { action: "INVOICE_CONFIRMATION_SUPERSEDED", applicationId: appId, details: { confirmationId: s.id, newInvoiceDocumentId: inv.id } });
    const officer = await chooseOfficer(tx, app.initiator_id);
    let id: string;
    if (already) {
      id = already.id;
      if (!officer) return "FAILED";
      await tx.query("UPDATE invoice_confirmations SET status = 'PENDING', officer_id = $2, dispatched_at = $3, assigned_at = $3, lock_version = lock_version + 1 WHERE id = $1", [id, officer.id, now]);
    } else {
      id = (
        await tx.query<{ id: string }>(
          `INSERT INTO invoice_confirmations (application_id, invoice_document_id, invoice_version, status, officer_id, dispatched_at, assigned_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$6,$7) RETURNING id`,
          [appId, inv.id, inv.version_no, officer ? "PENDING" : "DISPATCH_FAILED", officer?.id ?? null, officer ? now : null, now],
        )
      ).rows[0].id;
    }
    if (!officer) {
      await audit(tx, ctx, { action: "INVOICE_CONFIRMATION_DISPATCH_FAILED", applicationId: appId, details: { confirmationId: id, reason: "No active Invoice Confirmation Officer is configured." } });
      const admins = (await tx.query<{ id: string; email: string }>("SELECT s.id, s.email FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.active AND ra.role = 'SUPER_ADMIN' AND s.status = 'ACTIVE'")).rows;
      for (const a of admins) {
        await notify(tx, now, { recipientId: a.id, kind: "INVOICE_CONFIRMATION_ALERT", title: `Invoice not sent for confirmation — ${app.ref}`, body: "No active Invoice Confirmation Officer is configured. Assign the role and set the officer in Invoice confirmation settings; ARAF sends it automatically.", applicationId: appId, link: "/admin/invoice-confirmation", dedupeKey: `ic-alert:${id}` });
      }
      return "FAILED";
    }
    const label = CATEGORY_LABEL[inv.category] ?? "Invoice";
    const customer = app.customer_name ?? app.ref;
    await enqueueEmail(tx, now, {
      kind: "INVOICE_CONFIRMATION",
      dedupeKey: `invoice-confirmation:${id}:${inv.id}`,
      applicationId: appId,
      to: [officer.email],
      subject: `Invoice Confirmation — ${customer} — ${app.ref}`,
      text: `Dear ${officer.full_name},\n\nThe following ${label.toLowerCase()} requires confirmation with the issuer before disbursement.\n\nCustomer: ${customer}\nFacility Reference: ${app.ref}\nProduct: ${app.product_label ?? "WakeelBoost"}\nDocument: ${inv.filename} (version ${inv.version_no})\n\nOpen the request in ARAF to view the invoice, upload the issuer's response and mark it Confirmation Completed, or return it with a reason.\n\n${link(id)}\n\nRegards,\nARAF — Retail Asset Factory\nThe Alternative Bank`,
    });
    await notify(tx, now, { recipientId: officer.id, kind: "INVOICE_CONFIRMATION_ASSIGNED", title: `Invoice confirmation — ${app.ref}`, body: `${label} for ${customer} is awaiting your confirmation.`, applicationId: appId, link: `/invoice-confirmation/${id}`, dedupeKey: `ic-assigned:${id}:${inv.id}` });
    await notify(tx, now, { recipientId: app.initiator_id, kind: "INVOICE_CONFIRMATION_SENT", title: `Invoice sent for confirmation — ${app.ref}`, body: `${label} (${inv.filename}) was sent to the Invoice Confirmation Officer.`, applicationId: appId, link: `/requests/${appId}`, dedupeKey: `ic-sent:${id}:${inv.id}` });
    await audit(tx, ctx, { action: "INVOICE_CONFIRMATION_DISPATCHED", applicationId: appId, documentId: inv.id, documentVersion: inv.version_no, details: { confirmationId: id, officerId: officer.id } });
    return "SENT";
  });
}

/** Worker: dispatch anything outstanding (new invoices after approval, retries when no officer was available). */
export async function runInvoiceDispatch(now = new Date()): Promise<number> {
  const apps = (
    await db.query<{ id: string }>(
      `SELECT DISTINCT a.id FROM applications a JOIN documents d ON d.application_id = a.id AND d.category = ANY($1) AND d.superseded_at IS NULL AND d.scan_status = 'CLEAN'
        WHERE a.stage = ANY($2)
          AND NOT EXISTS (SELECT 1 FROM invoice_confirmations ic WHERE ic.invoice_document_id = d.id AND ic.status <> 'DISPATCH_FAILED')
        LIMIT 50`,
      [INVOICE_CATEGORIES, CLOSING_STAGES],
    )
  ).rows;
  let n = 0;
  for (const a of apps) if ((await dispatchForApplication(a.id, now).catch(() => "NONE")) === "SENT") n++;
  return n;
}

export interface IcRow {
  id: string;
  application_id: string;
  ref: string;
  customer_name: string | null;
  product_label: string | null;
  status: string;
  officer_id: string | null;
  officer_name: string | null;
  invoice_document_id: string;
  invoice_version: number;
  invoice_filename: string;
  invoice_category: string;
  dispatched_at: Date | null;
  assigned_at: Date | null;
  returned_reason: string | null;
  returned_at: Date | null;
  remarks: string | null;
  completed_at: Date | null;
  completed_by_name: string | null;
  response_document_id: string | null;
  initiator_id: string;
  initiator_name: string | null;
  lock_version: number;
  created_at: Date;
}

const SELECT = `SELECT ic.*, a.ref, a.customer_name, a.product_label, a.initiator_id, d.filename AS invoice_filename, d.category AS invoice_category,
    o.full_name AS officer_name, cb.full_name AS completed_by_name, i.full_name AS initiator_name
  FROM invoice_confirmations ic JOIN applications a ON a.id = ic.application_id JOIN documents d ON d.id = ic.invoice_document_id
  LEFT JOIN staff o ON o.id = ic.officer_id LEFT JOIN staff cb ON cb.id = ic.completed_by LEFT JOIN staff i ON i.id = a.initiator_id`;

export async function icQueue(q: Db, staffId: string, all: boolean, status: string[]): Promise<IcRow[]> {
  return (await q.query<IcRow>(`${SELECT} WHERE ic.status = ANY($2) AND ($3 OR ic.officer_id = $1) ORDER BY ic.assigned_at NULLS LAST, ic.created_at`, [staffId, status, all])).rows;
}

export async function icDetail(q: Db, id: string): Promise<IcRow | null> {
  return (await q.query<IcRow>(`${SELECT} WHERE ic.id = $1`, [id])).rows[0] ?? null;
}

export async function icForApplication(q: Db, appId: string): Promise<IcRow[]> {
  return (await q.query<IcRow>(`${SELECT} WHERE ic.application_id = $1 ORDER BY ic.created_at DESC`, [appId])).rows;
}

/** Responses the officer uploaded for this confirmation (after it was assigned). */
export async function icResponses(q: Db, row: Pick<IcRow, "application_id" | "assigned_at" | "officer_id">) {
  return (
    await q.query<{ id: string; filename: string; scan_status: string; uploaded_at: Date }>(
      `SELECT id, filename, scan_status, uploaded_at FROM documents WHERE application_id = $1 AND category = 'INVOICE_CONFIRMATION_RESPONSE'
         AND uploaded_by = $2 AND uploaded_at >= $3 AND superseded_at IS NULL ORDER BY uploaded_at DESC`,
      [row.application_id, row.officer_id, row.assigned_at ?? new Date(0)],
    )
  ).rows;
}

async function lockForOfficer(tx: Tx, ctx: Ctx, id: string, lockVersion: number | null) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const r = (await tx.query("SELECT ic.*, a.initiator_id, a.ref, a.customer_name FROM invoice_confirmations ic JOIN applications a ON a.id = ic.application_id WHERE ic.id = $1 FOR UPDATE OF ic", [id])).rows[0];
  if (!r) throw notFound();
  if (r.officer_id !== actor.staffId || !(await holdsRole(tx, actor.staffId, OFFICER_ROLE))) throw forbidden("This confirmation is not assigned to you.");
  if (r.initiator_id === actor.staffId) throw forbidden("You cannot confirm the invoice on a request you initiated.");
  if (r.status !== "PENDING") throw conflict(`This confirmation is ${IC_STATUS_LABELS[r.status]?.toLowerCase() ?? r.status}.`);
  if (lockVersion !== null && r.lock_version !== lockVersion) throw conflict("This confirmation changed since you opened it. Reload to see the latest version.");
  return r;
}

export async function completeConfirmation(ctx: Ctx, id: string, remarks: string, lockVersion: number | null) {
  return withTx(async (tx) => {
    const r = await lockForOfficer(tx, ctx, id, lockVersion);
    const resp = await icResponses(tx, r);
    const clean = resp.find((d) => d.scan_status === "CLEAN");
    if (!clean) throw invalid("Upload the issuer's confirmation response before marking it Confirmation Completed.", { response: "Upload the response." });
    await tx.query(
      "UPDATE invoice_confirmations SET status = 'COMPLETED', response_document_id = $2, remarks = $3, completed_by = $4, completed_at = $5, lock_version = lock_version + 1 WHERE id = $1",
      [id, clean.id, remarks.trim() || null, ctx.actor!.staffId, ctx.now],
    );
    await audit(tx, ctx, { action: "INVOICE_CONFIRMATION_COMPLETED", actorRole: OFFICER_ROLE, applicationId: r.application_id, documentId: clean.id, details: { confirmationId: id, invoiceDocumentId: r.invoice_document_id, remarks } });
    await notify(tx, ctx.now, { recipientId: r.initiator_id, kind: "INVOICE_CONFIRMATION_COMPLETED", title: `Invoice confirmed — ${r.ref}`, body: `The invoice for ${r.customer_name ?? r.ref} has been confirmed with the issuer.`, applicationId: r.application_id, link: `/requests/${r.application_id}`, dedupeKey: `ic-done:${id}` });
  });
}

export async function returnConfirmation(ctx: Ctx, id: string, reason: string, lockVersion: number | null) {
  if (reason.trim().length < 20) throw invalid("Explain why the invoice is being returned (at least 20 characters).", { reason: "Give a reason of at least 20 characters." });
  return withTx(async (tx) => {
    const r = await lockForOfficer(tx, ctx, id, lockVersion);
    await tx.query("UPDATE invoice_confirmations SET status = 'RETURNED', returned_reason = $2, returned_at = $3, lock_version = lock_version + 1 WHERE id = $1", [id, reason.trim(), ctx.now]);
    await audit(tx, ctx, { action: "INVOICE_CONFIRMATION_RETURNED", actorRole: OFFICER_ROLE, applicationId: r.application_id, reason: reason.trim(), details: { confirmationId: id } });
    await notify(tx, ctx.now, {
      recipientId: r.initiator_id,
      kind: "INVOICE_CONFIRMATION_RETURNED",
      title: `Invoice returned — ${r.ref}`,
      body: `The Invoice Confirmation Officer returned the invoice: “${reason.trim()}”. Upload a corrected invoice; it is sent for confirmation automatically.`,
      applicationId: r.application_id,
      link: `/requests/${r.application_id}?tab=documents`,
      dedupeKey: `ic-returned:${id}`,
    });
  });
}

// ─────────────────────────── administration ───────────────────────────

export async function saveOfficerEmails(ctx: Ctx, emails: string[], reason: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const bad = clean.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (!clean.length) throw invalid("Enter at least one officer email.", { emails: "Enter at least one email." });
  if (bad.length) throw invalid(`Not a valid email: ${bad.join(", ")}.`, { emails: "Check the emails." });
  if (reason.trim().length < 20) throw invalid("Give a reason of at least 20 characters.", { reason: "Give a reason of at least 20 characters." });
  await withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden();
    const before = (await icSettings(tx)).officer_emails;
    await tx.query("UPDATE invoice_confirmation_settings SET officer_emails = $1, updated_by = $2, updated_at = $3 WHERE id = 1", [clean, actor.staffId, ctx.now]);
    await audit(tx, ctx, { action: "INVOICE_CONFIRMATION_SETTINGS_CHANGED", actorRole: "SUPER_ADMIN", reason: reason.trim(), details: { previous: before, next: clean } });
  });
}

export async function reassignConfirmation(ctx: Ctx, id: string, officerId: string, reason: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (reason.trim().length < 20) throw invalid("Give a reason of at least 20 characters.", { reason: "Give a reason of at least 20 characters." });
  await withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden();
    const r = (await tx.query("SELECT ic.*, a.initiator_id, a.ref, a.customer_name FROM invoice_confirmations ic JOIN applications a ON a.id = ic.application_id WHERE ic.id = $1 FOR UPDATE OF ic", [id])).rows[0];
    if (!r) throw notFound();
    if (!["PENDING", "DISPATCH_FAILED"].includes(r.status)) throw conflict("Only a pending confirmation can be reassigned.");
    if (officerId === r.initiator_id) throw invalid("The initiator cannot confirm their own request's invoice.");
    const ok = await tx.query("SELECT 1 FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.role = $2 AND ra.active WHERE s.id = $1 AND s.status = 'ACTIVE'", [officerId, OFFICER_ROLE]);
    if (!ok.rowCount) throw invalid("Choose an active Invoice Confirmation Officer.");
    await tx.query("UPDATE invoice_confirmations SET status = 'PENDING', officer_id = $2, assigned_at = $3, dispatched_at = COALESCE(dispatched_at, $3), lock_version = lock_version + 1 WHERE id = $1", [id, officerId, ctx.now]);
    await audit(tx, ctx, { action: "INVOICE_CONFIRMATION_REASSIGNED", actorRole: "SUPER_ADMIN", applicationId: r.application_id, reason: reason.trim(), details: { confirmationId: id, from: r.officer_id, to: officerId } });
    await notify(tx, ctx.now, { recipientId: officerId, kind: "INVOICE_CONFIRMATION_ASSIGNED", title: `Invoice confirmation — ${r.ref}`, body: `An invoice for ${r.customer_name ?? r.ref} was assigned to you.`, applicationId: r.application_id, link: `/invoice-confirmation/${id}`, dedupeKey: `ic-assigned:${id}:${officerId}:${ctx.now.getTime()}` });
  });
}

/** Disbursement readiness: the latest invoice (when the request has one) must be confirmed. */
export async function invoiceConfirmationBlocker(q: Db, appId: string): Promise<string | null> {
  const inv = (await q.query<{ id: string }>("SELECT id FROM documents WHERE application_id = $1 AND category = ANY($2) AND superseded_at IS NULL AND scan_status <> 'REJECTED' ORDER BY uploaded_at DESC LIMIT 1", [appId, INVOICE_CATEGORIES])).rows[0];
  if (!inv) return null;
  const c = (await q.query<{ status: string }>("SELECT status FROM invoice_confirmations WHERE invoice_document_id = $1", [inv.id])).rows[0];
  if (c?.status === "COMPLETED") return null;
  if (c?.status === "RETURNED") return "The Invoice Confirmation Officer returned the invoice. Upload a corrected invoice.";
  return "Invoice confirmation is not yet completed by the Invoice Confirmation Officer.";
}
