/* eslint-disable @typescript-eslint/no-explicit-any -- rows read straight from the database */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { db } from "@/server/db";
import { audits, resetDb } from "./helpers";
import { act, confirmInvoiceIfNeeded, ctxFor, DEMO_INVOICE_OFFICER, makePdf, openTaskOf } from "@/server/demo/scenario";
import { CREDIT_PERSON, TestBureau } from "@/server/demo/altphones-scenario";
import { applyConfig, approveRetailTemplates, completeAll, createRetailCase, driveBusinessReview, driveCredit, driveToBooking, passRetailCreditChecks, payAndReconcile, syntheticConfig } from "@/server/demo/retail-scenario";
import { setCreditBureauForTests } from "@/server/altphones/integrations";
import { currentLowScores, runRetailCreditCheck } from "@/server/domain/retail-credit";
import { submitApplication } from "@/server/domain/workflow";
import { retailReadiness } from "@/server/domain/retail";
import { acknowledgeCreditException, creditExceptionFor, meaningfulReason, proceedWithReason } from "@/server/domain/credit-exception";
import { runSlaReminders, slaDeadline, slaPolicy } from "@/server/domain/sla-reminders";
import { closingStatus, generateClosingDocuments, remitaValues, saveRepaymentAccount, splitName } from "@/server/domain/closing-docs";
import { buildGsiPdf, GSI_DECLARATIONS } from "@/server/domain/closing-pdfs";
import { completeConfirmation, dispatchForApplication, invoiceConfirmationBlocker, returnConfirmation } from "@/server/domain/invoice-confirmation";
import { uploadDocument } from "@/server/domain/documents";
import { checklistStatus, saveChecklist, STANDARD_CHECKLIST } from "@/server/domain/closing-checklist";
import { archiveOne, runFacilityArchives, updateHandover } from "@/server/domain/facility-archive";
import { explainAccess } from "@/app/(app)/requests/new/catalogue";
import { DomainError } from "@/server/errors";
import { objectStore } from "@/server/storage";

const N = (n: number) => n * 100;
const RM = "rm.bola@altbank.ng";
const HOUR = 3_600_000;
let bureau: TestBureau;

beforeEach(async () => {
  await resetDb();
  bureau = new TestBureau(700);
  setCreditBureauForTests(bureau);
  await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING"));
});
afterEach(() => setCreditBureauForTests(undefined));

const app = async (id: string) => (await db.query("SELECT * FROM applications WHERE id = $1", [id])).rows[0];
const vf = (o: Partial<Parameters<typeof createRetailCase>[0]> = {}) =>
  createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(10_000_000), tenorMonths: 12, incomeBasisKobo: N(10_000_000), proposedMonthlyKobo: N(1_000_000), ...o });
async function fails(p: Promise<unknown>, code?: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    if (code) expect((e as DomainError).code).toBe(code);
    return e as DomainError;
  }
  throw new Error("expected the call to fail");
}
/** Credit approvals through to offer preparation (closing documents are prepared after commit). */
async function toOfferPreparation(id: string) {
  await approveRetailTemplates();
  await driveBusinessReview(id);
  await driveCredit(id);
  expect((await app(id)).stage).toBe("OFFER_PREPARATION");
  await generateClosingDocuments(id);
}

describe("1. WakeelBoost is offered to Relationship Managers", () => {
  it("is open, permits RMs and the access check explains it", async () => {
    const p = (await db.query("SELECT active, origination_roles, description FROM products WHERE code = 'WAKEELBOOST'")).rows[0];
    expect(p.active).toBe(true);
    expect(p.origination_roles === null || p.origination_roles.includes("RM")).toBe(true);
    expect(p.description).not.toMatch(/legacy/i);
    const r = await explainAccess(db, RM, new Date());
    const wb = r!.lines.find((l) => /wakeel/i.test(l.product));
    expect(wb?.ok).toBe(true);
  });
});

describe("2–5. SeedFi low score: Proceed with Reason", () => {
  it("a low score keeps the draft open; submission needs a meaningful reason", async () => {
    const id = await vf({ submit: false });
    const rm = await ctxFor(RM);
    bureau.score = 500;
    expect((await runRetailCreditCheck(rm, id, "APPLICANT", CREDIT_PERSON)).outcome).toBe("FAIL");
    expect((await app(id)).stage).toBe("DRAFT");
    expect((await audits("CREDIT_CHECK_LOW_SCORE")).length).toBe(1);
    await expect(submitApplication(rm, id, randomUUID())).rejects.toThrow(/not ready/);
    expect((await retailReadiness(db, id, new Date())).blockers.join(" ")).toMatch(/Proceed with Reason/);
    expect(meaningfulReason("ok ok ok ok ok ok ok ok")).toBeTruthy();
    expect(meaningfulReason("aaaaaaaaaaaaaaaaaaaaaaaaa")).toBeTruthy();
    await fails(proceedWithReason(rm, id, "please approve", (q) => currentLowScores(q, id, rm.now)), "VALIDATION");
    await fails(proceedWithReason(await ctxFor("tl.lagos@altbank.ng"), id, "Customer settled the reported arrears last month; statements confirm steady inflows.", (q) => currentLowScores(q, id, rm.now)));
    await proceedWithReason(rm, id, "Customer settled the reported arrears last month; statements confirm steady inflows.", (q) => currentLowScores(q, id, rm.now));
    await submitApplication(rm, id, randomUUID());
    expect((await app(id)).stage).not.toBe("DRAFT");
    const e = await creditExceptionFor(db, id);
    expect(e?.status).toBe("PENDING_REVIEW");
    // the original SeedFi result is unchanged
    expect((await db.query("SELECT outcome FROM credit_checks WHERE application_id = $1", [id])).rows[0].outcome).toBe("FAIL");
  });

  it("the Team Lead must acknowledge before deciding; the RM cannot acknowledge; approval settles it", async () => {
    const id = await vf({ submit: false });
    const rm = await ctxFor(RM);
    bureau.score = 500;
    await runRetailCreditCheck(rm, id, "APPLICANT", CREDIT_PERSON);
    await proceedWithReason(rm, id, "Customer settled the reported arrears last month; statements confirm steady inflows.", (q) => currentLowScores(q, id, rm.now));
    await submitApplication(rm, id, randomUUID());
    const t = await openTaskOf(id);
    expect(t.stage).toBe("TEAM_LEAD_REVIEW");
    await expect(act(id, "RECOMMEND", { reason: "Viable proposal; DSR within threshold.", visitComments: "Management visit completed; business operating as described.", rmPhotoConfirmed: true })).rejects.toThrow(/acknowledge/i);
    await fails(acknowledgeCreditException(rm, id, { acknowledged: true, recommendation: "PROCEED", remarks: "I vouch for this customer." }), "FORBIDDEN");
    const n = (await db.query("SELECT count(*)::int AS n FROM notifications WHERE application_id = $1 AND title ILIKE '%exception%'", [id])).rows[0].n;
    expect(n).toBeGreaterThan(0);
    await acknowledgeCreditException(await ctxFor(t.email!), id, { acknowledged: true, recommendation: "PROCEED", remarks: "Reviewed statements; arrears were settled." });
    await driveBusinessReview(id);
    for (let i = 0; i < 6; i++) {
      const s = await openTaskOf(id);
      if (s?.stage === "UNIT_HEAD_REVIEW") {
        await acknowledgeCreditException(await ctxFor(s.email!), id, { acknowledged: true, recommendation: "PROCEED", remarks: "Acceptable as an exception." });
        break;
      }
      if (!s || s.stage === "OFFER_PREPARATION") break;
      if (s.stage === "FIRST_CREDIT_REVIEW") {
        const { recordFinal } = await import("@/server/demo/retail-scenario");
        await recordFinal(id);
      }
      await act(id, s.stage === "SECOND_CREDIT_REVIEW" ? ((await app(id)).route === 1 ? "APPROVE" : "PROCEED") : "APPROVE");
    }
    expect((await creditExceptionFor(db, id))?.uh_ack_at).toBeTruthy();
  });
});

describe("6–8. SLA reminders", () => {
  it("emails the assigned officer once after three hours, never before; reassignment restarts the clock", async () => {
    const t0 = new Date();
    const id = await vf({ now: t0 });
    const t = await openTaskOf(id);
    expect(await runSlaReminders(new Date(t0.getTime() + 2 * HOUR))).toBe(0);
    const sent = await runSlaReminders(new Date(t0.getTime() + 3 * HOUR + 60_000));
    expect(sent).toBeGreaterThan(0);
    expect(await runSlaReminders(new Date(t0.getTime() + 4 * HOUR))).toBe(0);
    const mail = (await db.query("SELECT subject, body_text, to_addresses FROM notification_outbox WHERE kind = 'SLA_REMINDER' AND application_id = $1", [id])).rows;
    expect(mail.length).toBe(1);
    expect(mail[0].subject).toMatch(/Pending Action for 3 Hours/);
    expect(JSON.stringify(mail[0])).toContain(t.email);
    // reassignment: new assigned_at, new clock
    const later = new Date(t0.getTime() + 5 * HOUR);
    await db.query("UPDATE tasks SET assigned_at = $2 WHERE id = $1", [t.id, later]);
    expect(await runSlaReminders(new Date(later.getTime() + HOUR))).toBe(0);
    expect(await runSlaReminders(new Date(later.getTime() + 3 * HOUR + 60_000))).toBeGreaterThan(0);
  });

  it("working hours skip nights, weekends and holidays", async () => {
    const p = { ...(await slaPolicy(db)), hour_mode: "WORKING" as const, holidays: ["2026-11-23"] };
    // Friday 16:00 Lagos (15:00Z) + 3 working hours → Tuesday 10:00 Lagos (Monday is a holiday)
    const d = slaDeadline(new Date("2026-11-20T15:00:00Z"), 3, p);
    expect(d.toISOString()).toBe("2026-11-24T09:00:00.000Z");
  });
});

describe("9–13. Closing documents on final approval", () => {
  it("prepares the offer; GSI and Remita wait for the repayment account, then are prepared", async () => {
    const id = await vf();
    await toOfferPreparation(id);
    let st = (await closingStatus(db, id))!;
    expect(st.items.find((i) => i.kind === "OFFER")?.state).toBe("READY");
    expect(st.items.find((i) => i.kind === "GSI")?.state).toBe("NEEDS_ACCOUNT");
    expect(JSON.stringify(st)).not.toMatch(/template/i);
    const rm = await ctxFor(RM);
    await fails(saveRepaymentAccount(rm, id, { bankName: "Access Bank Plc", accountNumber: "123", accountName: "Amina Bello", branch: "", townCity: "" }), "VALIDATION");
    await fails(saveRepaymentAccount(await ctxFor("tl.lagos@altbank.ng"), id, { bankName: "Access Bank Plc", accountNumber: "0123456789", accountName: "Amina Bello", branch: "", townCity: "" }), "FORBIDDEN");
    await saveRepaymentAccount(rm, id, { bankName: "Access Bank Plc", accountNumber: "0123456789", accountName: "Amina Bello", branch: "Yaba", townCity: "Lagos" });
    st = (await closingStatus(db, id))!;
    expect(st.items.every((i) => i.state === "READY")).toBe(true);
    const docs = (await db.query("SELECT category, uploaded_by, generated FROM documents WHERE application_id = $1 AND category IN ('GENERATED_GSI','GENERATED_REMITA')", [id])).rows;
    expect(docs.map((d: any) => d.category).sort()).toEqual(["GENERATED_GSI", "GENERATED_REMITA"]);
    expect(docs.every((d: any) => d.uploaded_by === null && d.generated)).toBe(true);
    // idempotent: running again prepares nothing new
    expect(await generateClosingDocuments(id)).toBe(0);
  });

  it("without an approved template the offer waits silently and the Super Admin is alerted", async () => {
    const id = await vf();
    await driveBusinessReview(id);
    await db.query("UPDATE offer_templates SET production_approved = false WHERE product_code IS NOT NULL");
    await driveCredit(id);
    await generateClosingDocuments(id);
    const st = (await closingStatus(db, id))!;
    const offer = st.items.find((i) => i.kind === "OFFER")!;
    expect(offer.state).toBe("PREPARING");
    expect(offer.note).not.toMatch(/template|missing/i);
    expect((await db.query("SELECT 1 FROM notifications n JOIN role_assignments ra ON ra.staff_id = n.recipient_id AND ra.role = 'SUPER_ADMIN' WHERE n.kind = 'CLOSING_DOCUMENT_ALERT' AND n.application_id = $1", [id])).rowCount).toBeGreaterThan(0);
    // once approved, the worker prepares it
    await approveRetailTemplates();
    await generateClosingDocuments(id);
    expect((await closingStatus(db, id))!.items.find((i) => i.kind === "OFFER")?.state).toBe("READY");
  });

  it("the GSI form carries the bank's six declarations verbatim and the prefilled details", async () => {
    const pdf = await buildGsiPdf({ surname: "Bello", firstName: "Amina", middleName: "", mobile: "08031234567", email: "a@example.com", address: "Lagos", bankName: "Access Bank Plc", branch: "", accountName: "Amina Bello", townCity: "", accountNumber: "0123456789", bvn: "01234567890", signatoryName: "Amina Bello", reference: "REF-1" });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(GSI_DECLARATIONS).toHaveLength(6);
    expect(GSI_DECLARATIONS[1]).toMatch(/^Authorize my Bank to debit any or all Bank account\/Bank accounts linked to my Bank Verification Number \(BVN\)/);
    expect(splitName("Amina Zainab Bello")).toEqual({ firstName: "Amina", middleName: "Zainab", surname: "Bello" });
  });

  it("the Remita sheet totals the instalment, charges and VAT on charges", () => {
    const v = remitaValues(
      { ref: "R", product: "Alt Drive", applicantType: "INDIVIDUAL", customerName: "Amina Bello", personName: "Amina Bello", phone: "", email: "", address: "", bvn: "", account: { bankName: "Access", accountNumber: "0123456789", accountName: "A", branch: "", townCity: "" }, instalmentKobo: N(512_500), frequency: "Month", firstDue: "2026-12-21", lastDue: "2027-11-21" },
      { remita_charge_kobo: N(1000), remita_vat_percent: "7.5", bank_name: "The Alternative Bank" },
      new Date("2026-11-17T10:00:00Z"),
    );
    expect(v).toMatchObject({ amount: "NGN 512,500.00", charges: "NGN 1,000.00", vatOnCharges: "NGN 75.00", totalPayable: "NGN 513,575.00", startDate: "2026-12-21", endDate: "2027-11-21", generatedOn: "17/11/2026" });
  });
});

describe("Authorised Ijarah letter", () => {
  it("an Alt Drive Ijarah request gets its offer letter automatically on final approval", async () => {
    await applyConfig("ALT_DRIVE", syntheticConfig("ALT_DRIVE"));
    const tpl = (await db.query("SELECT production_approved, body_html FROM offer_templates WHERE product_code = 'ALT_DRIVE' AND structure = 'IJARAH' AND status = 'ACTIVE'")).rows[0];
    expect(tpl.production_approved).toBe(true);
    expect(tpl.body_html).not.toMatch(/DRAFT WORDING/);
    const id = await createRetailCase({ channel: "RM", product: "ALT_DRIVE", profile: "BUSINESS_OWNER", structure: "IJARAH", amountKobo: N(5_000_000), tenorMonths: 12, incomeBasisKobo: N(10_000_000), proposedMonthlyKobo: N(450_000) });
    await driveBusinessReview(id);
    const co1 = await openTaskOf(id);
    for (let i = 1; i <= 3; i++) await uploadDocument(await ctxFor(co1.email!), { applicationId: id, category: "CREDIT_REPORT", filename: `r${i}.pdf`, data: makePdf(`r${i}`) });
    await driveCredit(id); // no manual template approval
    expect((await app(id)).stage).toBe("OFFER_PREPARATION");
    await generateClosingDocuments(id);
    expect((await closingStatus(db, id))!.items.find((i) => i.kind === "OFFER")?.state).toBe("READY");
    const doc = (await db.query("SELECT storage_key FROM documents WHERE application_id = $1 AND category = 'GENERATED_OFFER' AND superseded_at IS NULL", [id])).rows[0];
    const html = (await objectStore().get(doc.storage_key)).toString("utf8");
    expect(html).toContain("Ijarah");
    expect(html).toContain((await app(id)).customer_name);
    expect(html).not.toMatch(/\{\{|DRAFT WORDING/);
  });
});

describe("Authorised retail letters sent to the customer", () => {
  it("every Murabaha and Ijarah letter is approved, prefilled-ready and free of draft wording", async () => {
    const rows = (await db.query("SELECT product_code, structure, production_approved, body_html FROM offer_templates WHERE status = 'ACTIVE' AND product_code IS NOT NULL")).rows;
    for (const [p, s2] of [["ALT_DRIVE", "MURABAHA"], ["ALT_DRIVE", "IJARAH"], ["ALT_POWER", "MURABAHA"], ["ALT_POWER", "IJARAH"], ["ALT_POWER", "STANDARD"], ["VENDOR_FINANCING", "MURABAHA"], ["VENDOR_FINANCING", "STANDARD"]]) {
      const t = rows.find((r: any) => r.product_code === p && r.structure === s2);
      expect(t, `${p} ${s2}`).toBeTruthy();
      expect(t.production_approved).toBe(true);
      expect(t.body_html).not.toMatch(/DRAFT WORDING/);
      expect(t.body_html).toMatch(s2 === "IJARAH" ? /Ijarah/ : /Murabaha/);
    }
  });

  it("on final approval the offer, GSI and Remita go to the customer together, copied to the RM; changes follow as an update", async () => {
    const id = await vf();
    await driveBusinessReview(id);
    await driveCredit(id); // letters are already approved: no manual step
    await generateClosingDocuments(id);
    const mails = async () => (await db.query("SELECT subject, to_addresses, cc_addresses, attachment_document_ids, body_text FROM notification_outbox WHERE kind = 'CUSTOMER_CLOSING_PACK' AND application_id = $1 ORDER BY created_at", [id])).rows;
    expect(await mails()).toHaveLength(0); // held until the GSI form and Remita sheet can be prepared too
    const rm = await ctxFor(RM);
    await saveRepaymentAccount(rm, id, { bankName: "Access Bank Plc", accountNumber: "0123456789", accountName: "Amina Bello", branch: "Yaba", townCity: "Lagos" });
    let m = await mails();
    expect(m).toHaveLength(1);
    expect(m[0].to_addresses).toEqual(["amina@example.com"]);
    expect(m[0].cc_addresses).toEqual([RM]);
    expect(m[0].attachment_document_ids).toHaveLength(3);
    expect(m[0].subject).toMatch(/offer/i);
    expect(m[0].body_text).toMatch(/GSI mandate form/);
    expect((await closingStatus(db, id))!.items.every((i) => i.sentAt)).toBe(true);
    expect(await generateClosingDocuments(id)).toBe(0);
    expect(await mails()).toHaveLength(1); // not sent twice
    await saveRepaymentAccount(rm, id, { bankName: "Zenith Bank Plc", accountNumber: "1234567890", accountName: "Amina Bello", branch: "", townCity: "Lagos" });
    m = await mails();
    expect(m).toHaveLength(2);
    expect(m[1].subject).toMatch(/Updated documents/);
    expect(m[1].attachment_document_ids).toHaveLength(2);
  });

  it("without a customer e-mail nothing is sent and the RM is told to hand the documents over", async () => {
    const id = await vf({ data: { email: "" } } as any);
    await driveBusinessReview(id);
    await driveCredit(id);
    await saveRepaymentAccount(await ctxFor(RM), id, { bankName: "Access Bank Plc", accountNumber: "0123456789", accountName: "Amina Bello", branch: "", townCity: "" });
    expect((await db.query("SELECT 1 FROM notification_outbox WHERE kind = 'CUSTOMER_CLOSING_PACK' AND application_id = $1", [id])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM notifications WHERE kind = 'CUSTOMER_PACK_NO_EMAIL' AND application_id = $1", [id])).rowCount).toBe(1);
  });
});

describe("14–17. Invoice confirmation", () => {
  const withInvoice = () => vf();
  const INV = "SUPPLIER_INVOICE";

  it("with no officer configured the dispatch fails safely and the Super Admin is alerted", async () => {
    const id = await withInvoice();
    await toOfferPreparation(id);
    const rm = await ctxFor(RM);
    await uploadDocument(rm, { applicationId: id, category: INV, filename: "invoice.pdf", data: makePdf("invoice") });
    const ic = (await db.query("SELECT status FROM invoice_confirmations WHERE application_id = $1", [id])).rows;
    expect(ic.map((r: any) => r.status)).toContain("DISPATCH_FAILED");
    expect((await db.query("SELECT 1 FROM notifications WHERE kind = 'INVOICE_CONFIRMATION_ALERT' AND application_id = $1", [id])).rowCount).toBeGreaterThan(0);
  });

  it("is sent to the officer, needs the issuer's response, can be returned, and a new invoice supersedes", async () => {
    const id = await withInvoice();
    await db.query("UPDATE invoice_confirmation_settings SET officer_emails = $1", [[DEMO_INVOICE_OFFICER]]);
    await toOfferPreparation(id);
    const rm = await ctxFor(RM);
    await uploadDocument(rm, { applicationId: id, category: INV, filename: "invoice.pdf", data: makePdf("invoice v1") });
    let ic = (await db.query("SELECT * FROM invoice_confirmations WHERE application_id = $1 AND status = 'PENDING'", [id])).rows[0];
    expect(ic).toBeTruthy();
    const mail = (await db.query("SELECT subject FROM notification_outbox WHERE kind = 'INVOICE_CONFIRMATION' AND application_id = $1", [id])).rows;
    const row = await app(id);
    expect(mail[0].subject).toBe(`Invoice Confirmation — ${row.customer_name} — ${row.ref}`);
    const officer = await ctxFor(DEMO_INVOICE_OFFICER);
    await fails(completeConfirmation(officer, ic.id, "", null), "VALIDATION");
    await fails(returnConfirmation(officer, ic.id, "wrong", null), "VALIDATION");
    await fails(completeConfirmation(rm, ic.id, "", null), "FORBIDDEN");
    await returnConfirmation(officer, ic.id, "The dealer says the chassis number on this invoice does not match.", null);
    expect(await invoiceConfirmationBlocker(db, id)).toMatch(/returned/);
    // corrected invoice: a new confirmation, the old one kept
    await uploadDocument(rm, { applicationId: id, category: INV, filename: "invoice-v2.pdf", data: makePdf("invoice v2") });
    ic = (await db.query("SELECT * FROM invoice_confirmations WHERE application_id = $1 AND status = 'PENDING'", [id])).rows[0];
    expect(ic.invoice_version).toBeGreaterThan(1);
    await uploadDocument(officer, { applicationId: id, category: "INVOICE_CONFIRMATION_RESPONSE", filename: "dealer-reply.pdf", data: makePdf("confirmed") });
    await completeConfirmation(officer, ic.id, "Confirmed by phone with the dealer.", null);
    expect(await invoiceConfirmationBlocker(db, id)).toBeNull();
    expect((await db.query("SELECT status FROM invoice_confirmations WHERE application_id = $1 ORDER BY created_at", [id])).rows.map((r: any) => r.status)).toEqual(["RETURNED", "COMPLETED"]);
    expect((await audits("INVOICE_CONFIRMATION_COMPLETED")).length).toBe(1);
  });

  it("the officer cannot confirm a request they initiated", async () => {
    const id = await withInvoice();
    const rmId = (await db.query("SELECT id FROM staff WHERE email = $1", [RM])).rows[0].id;
    await db.query("INSERT INTO role_assignments (staff_id, role) VALUES ($1, 'INVOICE_CONFIRMATION_OFFICER')", [rmId]);
    await db.query("UPDATE invoice_confirmation_settings SET officer_emails = $1", [[RM, DEMO_INVOICE_OFFICER]]);
    await toOfferPreparation(id);
    await uploadDocument(await ctxFor(RM), { applicationId: id, category: INV, filename: "invoice.pdf", data: makePdf("invoice") });
    const ic = (await db.query("SELECT ic.officer_id, s.email FROM invoice_confirmations ic JOIN staff s ON s.id = ic.officer_id WHERE ic.application_id = $1", [id])).rows[0];
    expect(ic.email).toBe(DEMO_INVOICE_OFFICER); // the backup, never the initiator
    expect(await dispatchForApplication(id)).toBe("NONE"); // idempotent
  });
});

describe("18–19. Closing checklist and disbursement readiness", () => {
  it("the pack needs the required items; Remita is optional until the Super Admin requires it", async () => {
    const id = await vf();
    await toOfferPreparation(id);
    const st = await checklistStatus(db, await app(id));
    expect(st.find((i) => i.code === "REMITA_MANDATE")?.required).toBe(false);
    const rm = await ctxFor(RM);
    for (const c of ["SIGNED_OFFER", "KYC", "PRE_DISBURSEMENT", "GSI_FORM"]) await uploadDocument(rm, { applicationId: id, category: c, filename: `${c}.pdf`, data: makePdf(c) });
    await expect(act(id, "SUBMIT_PACK", { contractStepsConfirmed: true })).rejects.toThrow(/Missing: .*insurance/i);
    const admin = await ctxFor("superadmin@altbank.ng");
    await saveChecklist(admin, "VENDOR_FINANCING", STANDARD_CHECKLIST.map((i) => (i.code === "REMITA_MANDATE" ? { ...i, required: true } : i)), "Remita mandates are now mandatory for vendor financing.");
    await uploadDocument(rm, { applicationId: id, category: "INSURANCE_SIGNED", filename: "ins.pdf", data: makePdf("ins") });
    await expect(act(id, "SUBMIT_PACK", { contractStepsConfirmed: true })).rejects.toThrow(/Remita/);
    await uploadDocument(rm, { applicationId: id, category: "REMITA_MANDATE", filename: "remita.pdf", data: makePdf("remita") });
    await uploadDocument(rm, { applicationId: id, category: "CONTRACT_EVIDENCE", filename: "c.pdf", data: makePdf("c") });
    await act(id, "SUBMIT_PACK", { contractStepsConfirmed: true });
    expect((await app(id)).stage).toBe("CO3_PACK_REVIEW");
  });

  it("disbursement waits for the invoice confirmation", async () => {
    const id = await vf();
    await db.query("UPDATE invoice_confirmation_settings SET officer_emails = $1", [[DEMO_INVOICE_OFFICER]]);
    await toOfferPreparation(id);
    const rm = await ctxFor(RM);
    await uploadDocument(rm, { applicationId: id, category: "SUPPLIER_INVOICE", filename: "inv.pdf", data: makePdf("inv") });
    for (const c of ["SIGNED_OFFER", "KYC", "PRE_DISBURSEMENT", "GSI_FORM", "INSURANCE_SIGNED", "CONTRACT_EVIDENCE"]) await uploadDocument(rm, { applicationId: id, category: c, filename: `${c}.pdf`, data: makePdf(c) });
    await act(id, "SUBMIT_PACK", { contractStepsConfirmed: true });
    const co3 = await openTaskOf(id);
    await uploadDocument(await ctxFor(co3.email!), { applicationId: id, category: "INSURANCE_EVIDENCE", filename: "ins.pdf", data: makePdf("insurance") });
    await act(id, "FORWARD");
    const do1 = await openTaskOf(id);
    await uploadDocument(await ctxFor(do1.email!), { applicationId: id, category: "CRMS_EVIDENCE", filename: "crms.pdf", data: makePdf("crms") });
    await expect(act(id, "OKAY", { crmsLogged: true, confirmInvoice: false })).rejects.toThrow(/Invoice confirmation is not yet completed/);
    await confirmInvoiceIfNeeded(id);
    await act(id, "OKAY", { crmsLogged: true });
    expect((await app(id)).stage).toBe("DISBURSEMENT_BOOKING");
  });
});

describe("20. Facility archive and Legal & Shariah records review", () => {
  it("archives a completed facility, sends it for review and records Received / Reviewed", async () => {
    const id = await vf();
    await toOfferPreparation(id);
    await driveToBooking(id);
    await payAndReconcile(id);
    await completeAll(id);
    expect((await app(id)).stage).toBe("COMPLETED");
    expect(await runFacilityArchives(new Date())).toBe(1);
    const a = await app(id);
    expect(a.records_status).toBe("SENT_TO_LEGAL_SHARIAH");
    const arch = (await db.query("SELECT * FROM application_archives WHERE application_id = $1", [id])).rows[0];
    expect(arch.filename.startsWith("AMINA_BELLO")).toBe(true);
    expect(arch.filename.endsWith(`_${a.ref}.zip`)).toBe(true);
    const zip = await JSZip.loadAsync(await objectStore().get(arch.storage_key));
    const names = Object.keys(zip.files);
    expect(names.some((n) => n.endsWith("00-facility-summary.html"))).toBe(true);
    expect(names.some((n) => n.endsWith("manifest.json"))).toBe(true);
    expect((await db.query("SELECT 1 FROM notification_outbox WHERE kind = 'FACILITY_ARCHIVE' AND application_id = $1", [id])).rowCount).toBe(1);
    expect(await archiveOne(id)).toBe(false); // once only
    await fails(updateHandover(await ctxFor(RM), id, "LEGAL", "RECEIVED", ""), "FORBIDDEN");
    await updateHandover(await ctxFor("legal.officer@altbank.ng"), id, "LEGAL", "RECEIVED", "");
    await fails(updateHandover(await ctxFor("legal.officer@altbank.ng"), id, "LEGAL", "REVIEWED", ""), "VALIDATION");
    await updateHandover(await ctxFor("legal.officer@altbank.ng"), id, "LEGAL", "REVIEWED", "Pack complete; no issues.");
    expect((await app(id)).records_status).toBe("SENT_TO_LEGAL_SHARIAH");
    await updateHandover(await ctxFor("shariah.officer@altbank.ng"), id, "SHARIAH", "REVIEWED", "Contracts in order.");
    expect((await app(id)).records_status).toBe("REVIEW_COMPLETED");
  });

  it("facilities completed before the release are not archived again", async () => {
    await db.query("UPDATE schema_migrations SET applied_at = now() + interval '1 day' WHERE name = '045_platform_completion.sql'");
    const id = await vf();
    await toOfferPreparation(id);
    await driveToBooking(id);
    await payAndReconcile(id);
    await completeAll(id);
    expect(await runFacilityArchives(new Date())).toBe(0);
    await db.query("UPDATE schema_migrations SET applied_at = now() - interval '1 day' WHERE name = '045_platform_completion.sql'");
  });
});

void passRetailCreditChecks;
