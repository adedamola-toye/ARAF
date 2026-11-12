/**
 * Synthetic drivers for the Staff Personal Financing workflow (tests and demo data only).
 * They call the same domain functions the screens call; nothing bypasses a rule.
 */
import { createHash } from "node:crypto";
import { db } from "../db";
import { ctxFor, makePdf } from "./scenario";
import { computeStaffFinancing } from "@/lib/staff-financing";
import { createStaffDraft, saveStaffDraft, submitStaffRequest, claimPmReview, pmDecision, unitHeadDecision, divisionalHeadDecision } from "../staff/requests";
import { uploadStaffDocument } from "../staff/documents";
import { submitSignedOffer } from "../staff/offer";
import { reviewDisbursementDocumentation, startDisbursement, completeDisbursement } from "../staff/disbursement";
import { approveTemplate } from "../domain/admin";
import type { DocumentLibrary } from "../staff/sharepoint";
import type { StaffRequestRow } from "../staff/core";

export const STAFF = {
  applicant: "staff.okoro@altbank.ng",
  pm: "pm.staff@altbank.ng",
  unitHead: "unit.head@altbank.ng",
  divHead: "div.head@altbank.ng",
  admin: "superadmin@altbank.ng",
  legal: "legal.officer@altbank.ng",
  shariah: "shariah.officer@altbank.ng",
};

export const sid = async (email: string) => (await db.query<{ id: string }>("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id;
export const reqRow = async (id: string) => (await db.query<StaffRequestRow>("SELECT * FROM staff_requests WHERE id = $1", [id])).rows[0];
const lv = async (id: string) => (await reqRow(id)).lock_version;

export const PROFILE = {
  staffNumber: "ALT-04217",
  department: "Finance",
  unit: "Finance",
  phone: "08031234567",
  salaryAccountNumber: "0123456789",
  salaryAccountName: "ADAEZE OKORO",
  purpose: "Household equipment",
};

/** Configure the route's Unit Head (keeps the other settings in force). */
export async function configureRouteUnitHead(email = STAFF.unitHead, now = new Date()) {
  const { proposeStaffSettings } = await import("../staff/settings");
  const cur = (await db.query("SELECT * FROM staff_financing_settings ORDER BY version DESC LIMIT 1")).rows[0];
  await proposeStaffSettings(await ctxFor(STAFF.admin, now), {
    deductionPercent: String(cur.deduction_rate_bps / 100),
    tenorOptions: cur.tenor_options_months.join(","),
    requiredDocuments: cur.required_document_types,
    unitHeadId: await sid(email),
    reason: "Synthetic: Unit Head for the staff route",
  });
}

export async function approveStaffTemplate(now = new Date()) {
  const t = (await db.query("SELECT id, production_approved FROM offer_templates WHERE applicant_type = 'STAFF' AND status = 'ACTIVE'")).rows[0];
  if (t && !t.production_approved) await approveTemplate(await ctxFor(STAFF.admin, now), t.id);
}

/** Draft + supporting document + submission. Amount in naira as typed by the applicant. */
export async function submittedStaffRequest(opts: { amount?: string; email?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const ctx = await ctxFor(opts.email ?? STAFF.applicant, now);
  const { id } = await createStaffDraft(ctx);
  const amount = opts.amount ?? "1,000,000";
  const gross = Number(amount.replace(/,/g, "")) * 100;
  const settings = (await db.query("SELECT deduction_rate_bps FROM staff_financing_settings ORDER BY version DESC LIMIT 1")).rows[0];
  const net = computeStaffFinancing(gross, settings.deduction_rate_bps).netKobo;
  await saveStaffDraft(ctx, id, { ...PROFILE, amount, acknowledgedNetKobo: String(net), acceptDeclaration: true, lockVersion: await lv(id) });
  await uploadStaffDocument(ctx, { requestId: id, category: "PAYSLIP", filename: "payslip-sep.pdf", data: makePdf("Synthetic payslip") });
  await submitStaffRequest(ctx, id, { lockVersion: await lv(id), acknowledgedNetKobo: String(net) });
  return id;
}

export const ALL_CHECKS = { accountVerified: true, salaryHistoryReviewed: true, repaymentWithinLimit: true };

export async function pmForward(id: string, now = new Date()) {
  const configured = (await db.query("SELECT unit_head_staff_id FROM staff_financing_settings ORDER BY version DESC LIMIT 1")).rows[0].unit_head_staff_id;
  if (!configured) await configureRouteUnitHead();
  const ctx = await ctxFor(STAFF.pm, now);
  await claimPmReview(ctx, id);
  await pmDecision(ctx, id, { action: "FORWARD", checklist: ALL_CHECKS, recommendation: "Recommend approval; checks completed manually.", confirmed: true, lockVersion: await lv(id) });
}
export async function unitHeadApprove(id: string, now = new Date()) {
  await unitHeadDecision(await ctxFor(STAFF.unitHead, now), id, { action: "APPROVE", comments: "Supported.", confirmed: true, lockVersion: await lv(id) });
}
export async function divisionalApprove(id: string, now = new Date()) {
  await divisionalHeadDecision(await ctxFor(STAFF.divHead, now), id, { action: "APPROVE", comments: "Final approval.", confirmed: true, lockVersion: await lv(id) });
}

export async function returnSignedOffer(id: string, now = new Date(), email = STAFF.applicant) {
  const ctx = await ctxFor(email, now);
  const { id: docId } = await uploadStaffDocument(ctx, { requestId: id, category: "SIGNED_OFFER", filename: "signed-offer.pdf", data: makePdf("Signed offer") });
  return submitSignedOffer(ctx, id, { documentId: docId, confirmed: true, lockVersion: await lv(id) });
}

export async function officerEmail(id: string) {
  const r = await reqRow(id);
  return (await db.query<{ email: string }>("SELECT email FROM staff WHERE id = $1", [r.disbursement_officer_id])).rows[0].email;
}

export async function disburse(id: string, now = new Date(), txnRef = `FT${Date.now()}${Math.floor(Math.random() * 1000)}`) {
  const email = await officerEmail(id);
  const ctx = await ctxFor(email, now);
  await reviewDisbursementDocumentation(ctx, id, { lockVersion: await lv(id) });
  await startDisbursement(ctx, id, { instructionRef: "INSTR-1", lockVersion: await lv(id) });
  const { id: ev } = await uploadStaffDocument(ctx, { requestId: id, category: "DISBURSEMENT_EVIDENCE", filename: "transfer-receipt.pdf", data: makePdf("Transfer receipt") });
  const r = await reqRow(id);
  await completeDisbursement(ctx, id, { transactionRef: txnRef, valueDate: now.toISOString().slice(0, 10), amount: String(Number(r.net_kobo) / 100), evidenceDocumentId: ev, confirmed: true, lockVersion: await lv(id) });
  return txnRef;
}

/** In-memory document library that behaves like Graph for tests and demos (upload, conflict, download). */
export class MemoryLibrary implements DocumentLibrary {
  readonly name = "in-memory test double";
  files = new Map<string, { id: string; data: Buffer }>();
  failNext = 0;
  corrupt = false;
  missingSettings() {
    return [];
  }
  async upload(path: string, data: Buffer) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("SharePoint unavailable (HTTP 503)");
    }
    const ex = this.files.get(path);
    if (ex) return { itemId: ex.id, webUrl: null };
    const id = createHash("sha1").update(path).digest("hex").slice(0, 16);
    this.files.set(path, { id, data: this.corrupt ? Buffer.concat([data, Buffer.from("x")]) : data });
    return { itemId: id, webUrl: `https://sharepoint.example/${id}` };
  }
  async verify(itemId: string, sha256: string, size: number) {
    const f = [...this.files.values()].find((x) => x.id === itemId);
    return !!f && f.data.length === size && createHash("sha256").update(f.data).digest("hex") === sha256;
  }
}
