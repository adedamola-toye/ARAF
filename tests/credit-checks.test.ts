import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { CREDIT_PERSON, TestBureau } from "@/server/demo/altphones-scenario";
import { createRetailCase } from "@/server/demo/retail-scenario";
import { applyConfig, syntheticConfig } from "@/server/demo/retail-scenario";
import { setCreditBureauForTests } from "@/server/altphones/integrations";
import { retailCreditStatus, runRetailCreditCheck } from "@/server/domain/retail-credit";
import { retailReadiness, saveRetailDraft } from "@/server/domain/retail";
import { submitApplication } from "@/server/domain/workflow";
import { createStaffDraft, saveStaffDraft, submitStaffRequest } from "@/server/staff/requests";
import { runStaffCreditCheck } from "@/server/staff/credit";
import { PROFILE, STAFF, reqRow } from "@/server/demo/staff-scenario";
import { uploadStaffDocument } from "@/server/staff/documents";
import { makePdf } from "@/server/demo/scenario";

const N = (naira: number) => naira * 100;
let bureau: TestBureau;
beforeEach(async () => {
  await resetDb();
  bureau = new TestBureau(700);
  setCreditBureauForTests(bureau);
  await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING"));
});
afterEach(() => setCreditBureauForTests(undefined));

const appRow = async (id: string) => (await db.query("SELECT stage, status FROM applications WHERE id = $1", [id])).rows[0];
const draft = (o: Partial<Parameters<typeof createRetailCase>[0]> = {}) =>
  createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(10_000_000), tenorMonths: 12, incomeBasisKobo: N(10_000_000), proposedMonthlyKobo: N(1_000_000), submit: false, ...o });

describe("Relationship Manager route — SeedFi credit check", () => {
  it("blocks submission until the initiator runs the check; Pass and Fair continue", async () => {
    const id = await draft();
    const rm = await ctxFor("rm.bola@altbank.ng");
    expect((await retailReadiness(db, id, new Date())).blockers.join(" ")).toMatch(/Run the SeedFi credit check for Amina Bello/);
    await expect(submitApplication(rm, id, randomUUID())).rejects.toThrow(/not ready|SeedFi credit check/);
    await expect(runRetailCreditCheck(await ctxFor("tl.lagos@altbank.ng"), id, "APPLICANT", CREDIT_PERSON)).rejects.toMatchObject({ code: "FORBIDDEN" });
    bureau.score = 560; // Fair (530–619)
    const r = await runRetailCreditCheck(rm, id, "APPLICANT", CREDIT_PERSON);
    expect(r.outcome).toBe("FAIR");
    expect(bureau.calls[0]).toMatchObject({ firstName: "Synthetic", bvn: expect.stringMatching(/^\d{11}$/) }); // BVN from the saved draft
    const after = await retailReadiness(db, id, new Date());
    expect(after.blockers.join(" ")).not.toMatch(/SeedFi/);
    await submitApplication(rm, id, randomUUID());
    expect((await appRow(id)).stage).not.toBe("DRAFT");
  });

  it("a Fail closes the request; an unavailable check never counts", async () => {
    const id = await draft();
    const rm = await ctxFor("rm.bola@altbank.ng");
    setCreditBureauForTests(null);
    expect((await runRetailCreditCheck(rm, id, "APPLICANT", CREDIT_PERSON)).outcome).toBe("UNAVAILABLE");
    expect((await retailReadiness(db, id, new Date())).blockers.join(" ")).toMatch(/SeedFi/);
    setCreditBureauForTests(new TestBureau(500)); // below 530
    const r = await runRetailCreditCheck(rm, id, "APPLICANT", CREDIT_PERSON);
    expect(r.outcome).toBe("FAIL");
    expect(await appRow(id)).toEqual({ stage: "REJECTED", status: "REJECTED" });
    expect((await db.query("SELECT 1 FROM audit_events WHERE action = 'REQUEST_CLOSED_CREDIT_FAILED' AND application_id = $1", [id])).rowCount).toBe(1);
  });

  it("changing the BVN on the draft needs a new check", async () => {
    const id = await draft();
    const rm = await ctxFor("rm.bola@altbank.ng");
    await runRetailCreditCheck(rm, id, "APPLICANT", CREDIT_PERSON);
    expect((await retailCreditStatus(db, id, new Date()))[0].current).toBe(true);
    await saveRetailDraft(rm, id, { data: {}, bvn: "33333333333" });
    expect((await retailCreditStatus(db, id, new Date()))[0].current).toBe(false);
  });

  it("a limited company needs a check for every director", async () => {
    const id = await draft({ type: "LIMITED" });
    const st = await retailCreditStatus(db, id, new Date());
    expect(st.length).toBeGreaterThan(0);
    expect(st.every((p) => p.key.startsWith("DIRECTOR:"))).toBe(true);
    const rm = await ctxFor("rm.bola@altbank.ng");
    await runRetailCreditCheck(rm, id, st[0].key, CREDIT_PERSON);
    if (st.length > 1) expect((await retailReadiness(db, id, new Date())).blockers.join(" ")).toMatch(/SeedFi/);
    for (const p of st.slice(1)) await runRetailCreditCheck(rm, id, p.key, CREDIT_PERSON);
    expect((await retailReadiness(db, id, new Date())).blockers.join(" ")).not.toMatch(/SeedFi/);
  });
});

describe("Staff Request route — SeedFi credit check", () => {
  async function readyDraft() {
    const ctx = await ctxFor(STAFF.applicant);
    const { id } = await createStaffDraft(ctx);
    const lv = async () => (await reqRow(id)).lock_version;
    await saveStaffDraft(ctx, id, { ...PROFILE, amount: "1,000,000", acknowledgedNetKobo: "98000000", acceptDeclaration: true, lockVersion: await lv() });
    await uploadStaffDocument(ctx, { requestId: id, category: "PAYSLIP", filename: "p.pdf", data: makePdf("Synthetic payslip") });
    return { ctx, id, lv };
  }

  it("the applicant must pass the check before submitting", async () => {
    const { ctx, id, lv } = await readyDraft();
    await expect(submitStaffRequest(ctx, id, { lockVersion: await lv() })).rejects.toMatchObject({ fields: { creditCheck: expect.any(String) } });
    await expect(runStaffCreditCheck(ctx, id, { ...CREDIT_PERSON, bvn: "123" })).rejects.toMatchObject({ fields: { bvn: expect.any(String) } });
    await expect(runStaffCreditCheck(await ctxFor("co1@altbank.ng"), id, { ...CREDIT_PERSON, bvn: "22222222222" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const r = await runStaffCreditCheck(ctx, id, { ...CREDIT_PERSON, bvn: "22222222222" });
    expect(r.outcome).toBe("PASS");
    await submitStaffRequest(ctx, id, { lockVersion: await lv() });
    expect((await reqRow(id)).status).toBe("SUBMITTED");
    const row = (await db.query("SELECT bvn_last4, outcome, score FROM credit_checks WHERE staff_request_id = $1", [id])).rows[0];
    expect(row).toEqual({ bvn_last4: "2222", outcome: "PASS", score: "700.00" });
  });

  it("a Fail declines the request", async () => {
    const { ctx, id } = await readyDraft();
    setCreditBureauForTests(new TestBureau(420));
    const r = await runStaffCreditCheck(ctx, id, { ...CREDIT_PERSON, bvn: "22222222222" });
    expect(r.outcome).toBe("FAIL");
    expect((await reqRow(id)).status).toBe("DECLINED");
  });
});
