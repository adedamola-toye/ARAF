import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { audits, resetDb } from "./helpers";
import { act, createSubmittedCase, ctxFor, openTaskOf } from "@/server/demo/scenario";
import { applyConfig, createRetailCase, syntheticConfig } from "@/server/demo/retail-scenario";
import { setOrgLink } from "@/server/domain/org";
import { visibleProducts, originationSettings } from "@/app/(app)/requests/new/catalogue";
import { createRetailDraft } from "@/server/domain/retail";
import { createDraft } from "@/server/domain/workflow";
import { DomainError } from "@/server/errors";

const N = (n: number) => n * 100;
const ADMIN = "superadmin@altbank.ng";
const sid = async (email: string) => (await db.query("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id as string;
const app = async (id: string) => (await db.query("SELECT * FROM applications WHERE id = $1", [id])).rows[0];
const ENDORSE = { reason: "Reviewed the merchant, documents and amount; endorsed." };

beforeEach(async () => {
  await resetDb();
  await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING"));
});

describe("Product access by role", () => {
  it("Merchant Officers see WakeelBoost only; Leads and Heads the four products; RMs the four", async () => {
    const s = await originationSettings(db);
    expect(visibleProducts(["MERCHANT_OFFICER"], s).map((p) => p.code)).toEqual(["WAKEELBOOST"]);
    for (const r of ["MERCHANT_OFFICER_LEAD", "MERCHANT_OFFICER_HEAD", "RM"]) expect(visibleProducts([r], s).map((p) => p.code)).toEqual(["WAKEELBOOST", "VENDOR_FINANCING", "ALT_DRIVE", "ALT_POWER"]);
    expect(visibleProducts(["DELIGHT_OFFICER"], s)).toEqual([]);
  });

  it("a Merchant Officer cannot open a retail product through the server even by calling it directly", async () => {
    const id = (await db.query("INSERT INTO staff (email, full_name) VALUES ('mo.only@altbank.ng','MO Only') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO role_assignments (staff_id, role) VALUES ($1,'MERCHANT_OFFICER')", [id]);
    const ctx = await ctxFor("mo.only@altbank.ng");
    await expect(createRetailDraft(ctx, { initiatorRole: "MERCHANT_OFFICER", productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", applicantType: "ENTERPRISE" })).rejects.toBeInstanceOf(DomainError);
    await expect(createRetailDraft(ctx, { initiatorRole: "RM", productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", applicantType: "ENTERPRISE" })).rejects.toBeInstanceOf(DomainError);
    expect((await createDraft(ctx, { initiatorRole: "MERCHANT_OFFICER", applicantType: "INDIVIDUAL" })).id).toBeTruthy();
  });

  it("the initial Lead and Head are provisioned by role, with the Lead reporting to the Head", async () => {
    const lead = await sid("abiodun.ayinde@altbank.ng");
    const head = await sid("alexander.olasinde@altbank.ng");
    expect((await db.query("SELECT role FROM role_assignments WHERE staff_id = $1 AND active", [lead])).rows.map((r) => r.role)).toEqual(["MERCHANT_OFFICER_LEAD"]);
    expect((await db.query("SELECT role FROM role_assignments WHERE staff_id = $1 AND active", [head])).rows.map((r) => r.role)).toEqual(["MERCHANT_OFFICER_HEAD"]);
    expect((await db.query("SELECT manager_id FROM org_links WHERE staff_id = $1 AND relation = 'MO_HEAD'", [lead])).rows[0].manager_id).toBe(head);
  });
});

describe("Merchant Officer approval hierarchy (WakeelBoost)", () => {
  it("Merchant Officer → their Lead → the Lead's Head → credit, each recorded", async () => {
    const admin = await ctxFor(ADMIN);
    await setOrgLink(admin, { staffId: await sid("mo.chi@altbank.ng"), relation: "MO_LEAD", managerId: await sid("mo.lead@altbank.ng"), reason: "Kemi leads Chioma's merchant team." });
    await setOrgLink(admin, { staffId: await sid("mo.lead@altbank.ng"), relation: "MO_HEAD", managerId: await sid("mo.head@altbank.ng"), reason: "Kemi reports to the synthetic Head." });
    const id = await createSubmittedCase({ initiator: "MERCHANT_OFFICER", amountKobo: N(1_000_000) });
    let t = await openTaskOf(id);
    expect([t.stage, t.email]).toEqual(["BUSINESS_ENDORSEMENT", "mo.lead@altbank.ng"]);
    await act(id, "ENDORSE", ENDORSE);
    t = await openTaskOf(id);
    expect([t.stage, t.email]).toEqual(["MO_HEAD_REVIEW", "mo.head@altbank.ng"]);
    await act(id, "ENDORSE", ENDORSE);
    t = await openTaskOf(id);
    expect(t.stage).toBe("FIRST_CREDIT_REVIEW");
    const a = await app(id);
    expect(a.endorser_id).toBe(await sid("mo.lead@altbank.ng"));
    expect(a.mo_head_id).toBe(await sid("mo.head@altbank.ng"));
    expect((await audits("REPORTING_LINE_CHANGED")).length).toBe(2);
  });

  it("the Head can return the request; a resubmission goes back to the Head", async () => {
    const id = await createSubmittedCase({ initiator: "MERCHANT_OFFICER", amountKobo: N(1_000_000) });
    await act(id, "ENDORSE", ENDORSE);
    await act(id, "RETURN", { reason: "Add the latest rent receipt please." });
    expect((await openTaskOf(id)).stage).toBe("INITIATOR_CORRECTION");
    await act(id, "RESUBMIT");
    expect((await openTaskOf(id)).stage).toBe("MO_HEAD_REVIEW");
  });

  it("a Lead's own request goes to the Head; a Head's own request goes to credit; nobody reviews their own request", async () => {
    await setOrgLink(await ctxFor(ADMIN), { staffId: await sid("mo.lead@altbank.ng"), relation: "MO_HEAD", managerId: await sid("mo.head@altbank.ng"), reason: "Kemi reports to the synthetic Head." });
    const lead = await createSubmittedCase({ initiator: "MERCHANT_OFFICER_LEAD", amountKobo: N(1_000_000) });
    const t = await openTaskOf(lead);
    expect([t.stage, t.email]).toEqual(["MO_HEAD_REVIEW", "mo.head@altbank.ng"]);
    const head = await createSubmittedCase({ initiator: "MERCHANT_OFFICER_HEAD", amountKobo: N(1_000_000) });
    const h = await openTaskOf(head);
    expect(h.stage).toBe("FIRST_CREDIT_REVIEW");
    expect(h.email).not.toBe("mo.head@altbank.ng");
  });

  it("only a Super Admin sets reporting lines, and the manager must hold the right role", async () => {
    await expect(setOrgLink(await ctxFor("mo.lead@altbank.ng"), { staffId: await sid("mo.chi@altbank.ng"), relation: "MO_LEAD", managerId: await sid("mo.lead@altbank.ng"), reason: "trying to set my own team" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setOrgLink(await ctxFor(ADMIN), { staffId: await sid("mo.chi@altbank.ng"), relation: "MO_LEAD", managerId: await sid("rm.bola@altbank.ng"), reason: "wrong manager role" })).rejects.toThrow(/does not hold/);
  });
});

describe("Merchant Officer Lead / Head originating retail products", () => {
  it("a Lead's Vendor Financing request goes to the Merchant Officer Head, then credit", async () => {
    await setOrgLink(await ctxFor(ADMIN), { staffId: await sid("mo.lead@altbank.ng"), relation: "MO_HEAD", managerId: await sid("mo.head@altbank.ng"), reason: "Kemi reports to the synthetic Head." });
    const id = await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(10_000_000), tenorMonths: 12, incomeBasisKobo: N(10_000_000), proposedMonthlyKobo: N(1_000_000), submit: false });
    // Re-point the case to a Lead originator (same customer data), as the Lead would have entered it.
    const leadId = await sid("mo.lead@altbank.ng");
    await db.query("UPDATE applications SET initiator_id = $2, initiator_role = 'MERCHANT_OFFICER_LEAD', team = NULL WHERE id = $1", [id, leadId]);
    await db.query("UPDATE credit_checks SET requested_by = $2 WHERE application_id = $1", [id, leadId]);
    // The Lead is the originator, so their own business photograph and credit proposal (as the Lead would enter them).
    await db.query("UPDATE documents SET uploaded_by = $2 WHERE application_id = $1", [id, leadId]);
    const { saveProposal } = await import("@/server/domain/retail");
    const { fullProposal } = await import("@/server/demo/retail-scenario");
    await saveProposal(await ctxFor("mo.lead@altbank.ng"), id, fullProposal());
    const { passRetailCreditChecks } = await import("@/server/demo/retail-scenario");
    const { submitApplication } = await import("@/server/domain/workflow");
    const ctx = await ctxFor("mo.lead@altbank.ng");
    await passRetailCreditChecks(ctx, id);
    const { retailReadiness } = await import("@/server/domain/retail");
    const rd = await retailReadiness(db, id, new Date());
    expect([rd.blockers, rd.fieldErrors]).toEqual([[], {}]);
    await submitApplication(ctx, id, crypto.randomUUID());
    const t = await openTaskOf(id);
    expect([t.stage, t.email]).toEqual(["MO_HEAD_REVIEW", "mo.head@altbank.ng"]);
    await act(id, "ENDORSE", { reason: "Reviewed the vendor, customer and amount; endorsed for credit." });
    expect((await openTaskOf(id)).stage).toBe("FIRST_CREDIT_REVIEW");
  });
});

describe("Acquisition evidence at RM disbursement confirmation", () => {
  it("origination and approval never ask for it; the RM cannot confirm without it (server-enforced); uploading it enables confirmation", async () => {
    const { driveToOffer, preparePack, appRow } = await import("@/server/demo/scenario");
    const { lagosDate, addDaysToDateString } = await import("@/server/time");
    const { uploadDocument } = await import("@/server/domain/documents");
    const { makePdf } = await import("@/server/demo/scenario");
    const id = await createSubmittedCase({ initiator: "MERCHANT_OFFICER", amountKobo: N(1_000_000) });
    await driveToOffer(id); // business review, credit and approvals: no acquisition evidence involved
    await preparePack(id);
    await act(id, "SUBMIT_PACK"); // the pack does not need contract / acquisition evidence
    const co3 = await openTaskOf(id);
    await uploadDocument(await ctxFor(co3.email!), { applicationId: id, category: "INSURANCE_EVIDENCE", filename: "ins.pdf", data: makePdf("ins") });
    await act(id, "FORWARD");
    await act(id, "OKAY", { crmsLogged: true }); // authorised disbursement readiness does not need it either
    const a = await appRow(id);
    const today = lagosDate(new Date());
    await act(id, "DISBURSED", { booking: { amountKobo: Number(a.requested_amount_kobo), disbursedOn: today, transactionRef: `T${Date.now()}`, schedule: [{ dueDate: addDaysToDateString(today, 30), amountKobo: Number(a.requested_amount_kobo) }] } });
    await act(id, "COMPLETE_PROCESS");
    expect((await openTaskOf(id)).stage).toBe("VENDOR_CONFIRMATION");
    await expect(act(id, "CONFIRM_VENDOR_PAYMENT", { withEvidence: false })).rejects.toThrow("Please upload evidence of delivery or acquisition before confirming disbursement.");
    await act(id, "CONFIRM_VENDOR_PAYMENT"); // helper uploads the evidence first, as the RM would
    expect((await appRow(id)).status).toBe("CLOSED");
  });
});

describe("Product-specific documentation", () => {
  it("defaults follow the product and customer category; Staff Salary Advance has no invoice confirmation", async () => {
    const { checklistItems } = await import("@/server/domain/closing-checklist");
    const req = async (k: string) => (await checklistItems(db, k)).filter((i) => i.required).map((i) => i.code);
    expect(await req("VENDOR_FINANCING:BUSINESS_OWNER")).toEqual(expect.arrayContaining(["PRE_DISBURSEMENT", "GSI_FORM", "UNDATED_CHEQUES", "DOMICILIATION_UNDERTAKING"]));
    expect(await req("ALT_POWER:BUSINESS_OWNER")).toEqual(expect.arrayContaining(["REMITA_MANDATE", "DOMICILIATION_UNDERTAKING"]));
    expect(await req("ALT_POWER:SALARY_EARNER")).toContain("REMITA_MANDATE");
    expect(await req("ALT_POWER:SALARY_EARNER")).not.toContain("DOMICILIATION_UNDERTAKING");
    expect(await req("ALT_DRIVE:SALARY_EARNER")).toContain("REMITA_MANDATE");
    expect(await req("ALT_DRIVE:BUSINESS_OWNER")).not.toContain("UNDATED_CHEQUES");
    // Staff Salary Advance lives in its own tables: no invoice confirmations are ever created for it.
    expect((await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'invoice_confirmations' AND column_name = 'staff_request_id'")).rowCount).toBe(0);
  });
});
