import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { saveDraft, performTaskAction } from "@/server/domain/workflow";
import { uploadDocument } from "@/server/domain/documents";
import { recordAssessment } from "@/server/domain/assessment";
import {
  act,
  appRow,
  approveFirstReview,
  createSubmittedCase,
  ctxFor,
  driveToOffer,
  makePdf,
  openTaskOf,
  preparePack,
  prepareFirstReview,
} from "@/server/demo/scenario";
import { audits, key, outbox, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function atFirstReview(amount = NAIRA(1_000_000)) {
  const id = await createSubmittedCase({ initiator: "RM", amountKobo: amount });
  await act(id, "ENDORSE");
  return id;
}

describe("first credit review gates (server enforced)", () => {
  it("requires three credit reports", async () => {
    const id = await atFirstReview();
    const t = await openTaskOf(id);
    const ctx = await ctxFor(t.email!);
    for (let i = 1; i <= 2; i++) await uploadDocument(ctx, { applicationId: id, category: "CREDIT_REPORT", filename: `r${i}.pdf`, data: makePdf(`r${i}`) });
    await expect(act(id, "APPROVE", { invoiceLogged: true, invoiceDialogConfirmed: true })).rejects.toThrow(/three credit reports.*currently 2/);
    expect((await audits("TASK_APPROVE")).at(-1).outcome).toBe("FAILURE");
  });
  it("requires the APR/DSR assessment for the current version", async () => {
    const id = await atFirstReview();
    const ctx = await ctxFor((await openTaskOf(id)).email!);
    for (let i = 1; i <= 3; i++) await uploadDocument(ctx, { applicationId: id, category: "CREDIT_REPORT", filename: `r${i}.pdf`, data: makePdf(`r${i}`) });
    await expect(act(id, "APPROVE", { invoiceLogged: true, invoiceDialogConfirmed: true })).rejects.toThrow(/APR calculation with DSR/);
  });
  it('requires "Logged invoice on invoice portal" and the reminder dialog confirmation', async () => {
    const id = await atFirstReview();
    await prepareFirstReview(id);
    await expect(act(id, "APPROVE", { invoiceDialogConfirmed: true })).rejects.toThrow(/Logged invoice on invoice portal/);
    await expect(act(id, "APPROVE", { invoiceLogged: true })).rejects.toThrow(/Do not forget to log invoice/);
    await act(id, "APPROVE", { invoiceLogged: true, invoiceDialogConfirmed: true });
    const done = (await db.query("SELECT attestation FROM tasks WHERE application_id = $1 AND stage = 'FIRST_CREDIT_REVIEW'", [id])).rows[0];
    expect(done.attestation.invoiceLogged).toBe(true);
  });
  it("only the assigned first reviewer can record the assessment", async () => {
    const id = await atFirstReview();
    const other = await ctxFor("co2@altbank.ng");
    await expect(recordAssessment(other, id, {})).rejects.toThrow(/assigned first credit reviewer/);
  });
  it("production blocks credit approval while the APR calculator is not bank-validated", async () => {
    const id = await atFirstReview();
    await prepareFirstReview(id);
    process.env.APP_ENV = "production";
    try {
      await expect(act(id, "APPROVE", { invoiceLogged: true, invoiceDialogConfirmed: true })).rejects.toThrow(/APR workbook rules are not configured/);
    } finally {
      process.env.APP_ENV = "test";
    }
  });
});

describe("offer pack, CO3 and CRMS gates", () => {
  it("pack must be complete; CO3 must upload separate insurance evidence; DO1 must toggle Logged CRMS", async () => {
    const id = await createSubmittedCase({ initiator: "ANM_SOUTH", amountKobo: NAIRA(2_000_000) });
    await driveToOffer(id);
    await expect(act(id, "SUBMIT_PACK")).rejects.toThrow(/offer pack is incomplete.*generated offer/);
    await preparePack(id);
    await act(id, "SUBMIT_PACK");
    expect((await openTaskOf(id)).email).toBe("co3@altbank.ng");
    await expect(act(id, "FORWARD")).rejects.toThrow(/evidence of insurance/);
    const co3 = await ctxFor("co3@altbank.ng");
    await uploadDocument(co3, { applicationId: id, category: "INSURANCE_EVIDENCE", filename: "ins.pdf", data: makePdf("ins") });
    await act(id, "FORWARD");
    await expect(act(id, "OKAY")).rejects.toThrow(/Logged CRMS/);
    // DO1 sends for correction -> directly back to CO3 -> resubmits to the same DO1
    await expect(act(id, "SEND_FOR_CORRECTION")).rejects.toThrow(/reason is required/);
    await act(id, "SEND_FOR_CORRECTION", { reason: "GSI form unsigned" });
    let t = await openTaskOf(id);
    expect(t.stage).toBe("DISBURSEMENT_CORRECTION");
    expect(t.email).toBe("co3@altbank.ng");
    await uploadDocument(co3, { applicationId: id, category: "GSI_FORM", filename: "gsi-v2.pdf", data: makePdf("gsi v2") });
    await act(id, "RESUBMIT");
    t = await openTaskOf(id);
    expect(t.stage).toBe("DISBURSEMENT_CHECK");
    expect(t.email).toBe("do1@altbank.ng");
    await act(id, "OKAY", { crmsLogged: true });
    expect((await openTaskOf(id)).email).toBe("do2@altbank.ng");
  });
});

describe("rejection and correction routing", () => {
  it.each(["BUSINESS_ENDORSEMENT", "FIRST_CREDIT_REVIEW", "SECOND_CREDIT_REVIEW", "UNIT_HEAD_REVIEW", "DIVISIONAL_HEAD_REVIEW"])(
    "rejection at %s ends the case as Rejected and notifies the initiator",
    async (stage) => {
      const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
      const steps: (() => Promise<unknown>)[] = [() => act(id, "ENDORSE"), () => approveFirstReview(id), () => act(id, "APPROVE"), () => act(id, "APPROVE")];
      while ((await openTaskOf(id)).stage !== stage) await steps.shift()!();
      await expect(act(id, "REJECT")).rejects.toThrow(/reason is required/);
      await act(id, "REJECT", { reason: "Insufficient turnover" });
      const app = await appRow(id);
      expect(app.status).toBe("REJECTED");
      expect(await openTaskOf(id)).toBeUndefined();
      const mail = await outbox("REJECTION");
      expect(mail[0].to_addresses).toEqual(["rm.ade@altbank.ng"]);
      expect(mail[0].body_text).toContain("Insufficient turnover");
    },
  );

  it("first reviewer correction returns to the initiator; non-material resubmission returns to the same reviewer", async () => {
    const id = await atFirstReview();
    const reviewer = (await openTaskOf(id)).email;
    await act(id, "RETURN", { reason: "Phone number wrong" });
    const t = await openTaskOf(id);
    expect(t.stage).toBe("INITIATOR_CORRECTION");
    expect(t.email).toBe("rm.ade@altbank.ng");
    const rm = await ctxFor("rm.ade@altbank.ng");
    await saveDraft(rm, id, { data: { phone: "08039999999" } });
    await act(id, "RESUBMIT");
    const back = await openTaskOf(id);
    expect(back.stage).toBe("FIRST_CREDIT_REVIEW");
    expect(back.email).toBe(reviewer);
    const v = await db.query("SELECT version_no FROM application_versions WHERE application_id = $1 ORDER BY version_no", [id]);
    expect(v.rows.map((r) => r.version_no)).toEqual([1, 2]);
  });

  it("later credit correction returns to the first reviewer, who can ask the initiator for documents; returns to the originating stage", async () => {
    const id = await atFirstReview();
    const firstReviewer = (await openTaskOf(id)).email;
    await approveFirstReview(id);
    await act(id, "APPROVE"); // second
    expect((await openTaskOf(id)).stage).toBe("UNIT_HEAD_REVIEW");
    await act(id, "RETURN", { reason: "Rent receipt illegible" });
    let t = await openTaskOf(id);
    expect(t.stage).toBe("CREDIT_CORRECTION");
    expect(t.email).toBe(firstReviewer);
    await act(id, "REQUEST_INITIATOR", { reason: "Please re-upload rent receipt" });
    t = await openTaskOf(id);
    expect(t.stage).toBe("INITIATOR_CORRECTION");
    const rm = await ctxFor("rm.ade@altbank.ng");
    await uploadDocument(rm, { applicationId: id, category: "RENT_RECEIPT", filename: "rent-v2.pdf", data: makePdf("rent v2") });
    await act(id, "RESUBMIT");
    t = await openTaskOf(id);
    expect(t.stage).toBe("CREDIT_CORRECTION");
    expect(t.email).toBe(firstReviewer);
    await act(id, "RESUBMIT");
    t = await openTaskOf(id);
    expect(t.stage).toBe("UNIT_HEAD_REVIEW");
    expect(t.email).toBe("unit.head@altbank.ng");
    // Approvals still valid (non-material)
    const inv = await db.query("SELECT count(*)::int AS n FROM decisions WHERE application_id = $1 AND invalidated_at IS NOT NULL", [id]);
    expect(inv.rows[0].n).toBe(0);
  });

  it("material change requires fresh credit review, recalculates the route and invalidates prior approvals", async () => {
    const id = await atFirstReview(NAIRA(4_000_000));
    await approveFirstReview(id);
    await act(id, "APPROVE");
    await act(id, "RETURN", { reason: "Amount must be revised" }); // Unit Head
    await act(id, "REQUEST_INITIATOR", { reason: "Revise amount and items" });
    const rm = await ctxFor("rm.ade@altbank.ng");
    await saveDraft(rm, id, { data: { requestedAmountKobo: NAIRA(15_000_000), items: [{ description: "Fridges", quantity: 10, unitCostKobo: NAIRA(1_500_000) }] } });
    await act(id, "RESUBMIT");
    const app = await appRow(id);
    expect(app.route).toBe(2);
    const t = await openTaskOf(id);
    expect(t.stage).toBe("FIRST_CREDIT_REVIEW");
    expect(t.email).toBe("co2@altbank.ng");
    const dec = (await db.query("SELECT stage, action, invalidated_at, v.version_no FROM decisions d JOIN application_versions v ON v.id = d.version_id WHERE d.application_id = $1 ORDER BY d.seq", [id])).rows;
    const approvals = dec.filter((d) => ["APPROVE", "PROCEED"].includes(d.action));
    expect(approvals.length).toBe(2);
    expect(approvals.every((d) => d.invalidated_at)).toBe(true);
    expect(approvals.every((d) => d.version_no === 1)).toBe(true);
    expect((await audits("ROUTE_RECALCULATED")).length).toBe(1);
    // Old assessment superseded: approval needs a new one for the new version.
    const ctx = await ctxFor("co2@altbank.ng");
    for (let i = 1; i <= 3; i++) await uploadDocument(ctx, { applicationId: id, category: "CREDIT_REPORT", filename: `n${i}.pdf`, data: makePdf("n") });
    await expect(act(id, "APPROVE", { invoiceLogged: true, invoiceDialogConfirmed: true })).rejects.toThrow(/APR calculation/);
  });

  it("reassessment during credit correction sends the case back through first review", async () => {
    const id = await atFirstReview();
    await approveFirstReview(id);
    await act(id, "APPROVE");
    await act(id, "RETURN", { reason: "Recheck DSR" });
    await prepareFirstReview(id); // new reports + new assessment
    await act(id, "RESUBMIT");
    expect((await openTaskOf(id)).stage).toBe("FIRST_CREDIT_REVIEW");
  });

  it("business endorsement return goes to the initiator and back to the endorser", async () => {
    const id = await createSubmittedCase({ initiator: "MERCHANT_OFFICER", amountKobo: NAIRA(1_000) });
    await act(id, "RETURN", { reason: "Add POS serial" });
    await act(id, "RESUBMIT");
    expect((await openTaskOf(id)).email).toBe("mo.lead@altbank.ng");
  });

  it("CO3 can return the offer pack to the initiator", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    await driveToOffer(id);
    await preparePack(id);
    await act(id, "SUBMIT_PACK");
    await act(id, "RETURN", { reason: "KYC expired" });
    const t = await openTaskOf(id);
    expect(t.stage).toBe("OFFER_PREPARATION");
    await act(id, "SUBMIT_PACK");
    expect((await openTaskOf(id)).stage).toBe("CO3_PACK_REVIEW");
  });

  it("submission validates rental coverage in Lagos time and the restricted fields", async () => {
    const rm = await ctxFor("rm.ade@altbank.ng");
    const { createDraft, submitApplication } = await import("@/server/domain/workflow");
    const { id } = await createDraft(rm, { initiatorRole: "RM", applicantType: "INDIVIDUAL" });
    await saveDraft(rm, id, { data: { rentStart: "2020-01-01", rentEnd: "2020-12-31" } });
    const err = await submitApplication(rm, id, key()).catch((e) => e);
    expect(err.fields.rentEnd).toMatch(/expired/);
    expect(err.fields.bvn).toMatch(/BVN is required/);
    expect(err.fields.doc_BANK_STATEMENT).toBeDefined();
    await expect(saveDraft(rm, id, { data: {}, bvn: "123" })).rejects.toMatchObject({ fields: { bvn: expect.any(String) } });
    // An amount above ₦50m is rejected at submission
    await saveDraft(rm, id, { data: { requestedAmountKobo: NAIRA(50_000_001) } });
    const err2 = await submitApplication(rm, id, key()).catch((e) => e);
    expect(err2.fields.requestedAmountKobo).toMatch(/outside/);
  });

  it("Limited requires every director with a BVN (no fixed cap)", async () => {
    const ctx = await ctxFor("anm.north@altbank.ng");
    const { createDraft } = await import("@/server/domain/workflow");
    const { id } = await createDraft(ctx, { initiatorRole: "ANM", applicantType: "LIMITED" });
    const many = Array.from({ length: 15 }, (_, i) => ({ fullName: `Director ${i + 1}`, bvn: `222000000${String(i).padStart(2, "0")}` }));
    await saveDraft(ctx, id, { data: { companyName: "Big Co Ltd" }, directors: many });
    const n = await db.query("SELECT count(*)::int AS n FROM application_directors d JOIN application_versions v ON v.id = d.version_id WHERE v.application_id = $1", [id]);
    expect(n.rows[0].n).toBe(15);
    // Stored encrypted, only last 4 in clear
    const row = (await db.query("SELECT bvn_enc, bvn_last4 FROM application_directors LIMIT 1")).rows[0];
    expect(row.bvn_enc).toMatch(/^v1:/);
    expect(row.bvn_last4).toHaveLength(4);
  });

  it("unauthorised officers cannot act on someone else's task", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    const t = await openTaskOf(id);
    const admin = await ctxFor("superadmin@altbank.ng");
    await expect(performTaskAction(admin, { taskId: t.id, action: "ENDORSE", idempotencyKey: key() })).rejects.toThrow(/not assigned to you/);
    const denied = await audits("TASK_ENDORSE");
    expect(denied.at(-1).outcome).toBe("DENIED");
  });
});
