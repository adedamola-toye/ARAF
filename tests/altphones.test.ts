import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { computeTerms, formatRateE4, imeiChecksumOk, mapScore, parseRateE4, repaymentDates } from "@/lib/altphones";
import { ALT, appRow, CapturingMail, CREDIT_PERSON, latestPaymentRef, loc, lv, setupAltphones, sidOf, stockOf, TestBureau, TestGateway } from "@/server/demo/altphones-scenario";
import { setCreditBureauForTests, setPaymentGatewayForTests } from "@/server/altphones/integrations";
import { setMailTransportForTests } from "@/server/notify/transport";
import {
  acceptContract,
  cancelApplication,
  checkDirectDebit,
  checkPayment,
  completeOutright,
  confirmInternalMandate,
  handlePaystackWebhook,
  requestPayment,
  runCreditCheck,
  saveCustomer,
  saveLocations,
  sendContractOtp,
  startDirectDebit,
  startSale,
  submitForApproval,
} from "@/server/altphones/origination";
import { confirmDisbursement, decide } from "@/server/altphones/approvals";
import { saveModel, savePricing } from "@/server/altphones/catalogue";
import { decideReplenishment, requestReplenishment, stockOverview } from "@/server/altphones/stock";
import { commitImport, previewImport } from "@/server/altphones/imports";
import { viewableApp } from "@/server/altphones/core";
import { grantRole } from "@/server/domain/admin";

// Valid (Luhn) synthetic IMEIs
const IMEI = ["490154203237518", "356938035643809", "353918050210125", "352099001761481"].filter(imeiChecksumOk);

let bureau: TestBureau;
let gw: TestGateway;
let mail: CapturingMail;
let models: string[];

beforeEach(async () => {
  await resetDb();
  bureau = new TestBureau(700);
  gw = new TestGateway();
  mail = new CapturingMail();
  setCreditBureauForTests(bureau);
  setPaymentGatewayForTests(gw);
  setMailTransportForTests(mail);
  ({ models } = await setupAltphones());
});
afterEach(() => {
  setCreditBureauForTests(undefined);
  setPaymentGatewayForTests(undefined);
  setMailTransportForTests(null);
});

const CUSTOMER = { name: "Synthetic Customer", email: "customer@example.com", phone: "0803 123 4567" };
const CREDIT_CUSTOMER = { ...CUSTOMER, abAccount: "0123456789", externalAccount: "9876543210", externalBankCode: "058", tenure: "6", repaymentDay: "25", accountsConfirmed: true };

async function outrightPaid(email = ALT.doOfficer, where = "Ikeja Branch") {
  const ctx = await ctxFor(email);
  const { id } = await startSale(ctx, { kind: "OUTRIGHT", modelId: models[0] });
  const sa = email === ALT.sa;
  await saveLocations(ctx, id, { modelId: models[0], originId: await loc(sa ? "Yaba Altbox" : where), supplyId: await loc(where) });
  await saveCustomer(ctx, id, CUSTOMER);
  await requestPayment(ctx, id, {});
  gw.pay(await latestPaymentRef(id));
  await checkPayment(ctx, id);
  return { id, ctx };
}

/** A credit application ready to submit (paid, reserved, both mandates, contract accepted). */
async function creditReady(email = ALT.doOfficer) {
  const ctx = await ctxFor(email);
  const sa = email === ALT.sa;
  const { id } = await startSale(ctx, { kind: "CREDIT", modelId: models[0] });
  await runCreditCheck(ctx, id, { ...CREDIT_PERSON, bvn: "22222222222" });
  await saveLocations(ctx, id, { modelId: models[0], originId: await loc(sa ? "Yaba Altbox" : "Ikeja Branch"), supplyId: await loc(sa ? "Yaba Altshop" : "Ikeja Branch") });
  await saveCustomer(ctx, id, CREDIT_CUSTOMER);
  await requestPayment(ctx, id, {});
  gw.pay(await latestPaymentRef(id));
  await checkPayment(ctx, id);
  await startDirectDebit(ctx, id);
  gw.authorize((await appRow(id)).dd_reference);
  await checkDirectDebit(ctx, id);
  await confirmInternalMandate(ctx, id, { confirmed: true });
  await sendContractOtp(ctx, id, {});
  await acceptContract(ctx, id, { code: mail.lastCode()! });
  return { id, ctx };
}

describe("financing calculator", () => {
  it("charges markup on the ₦145,000 price, deducts the down payment, and puts the rounding in the final instalment", () => {
    const t = computeTerms({ priceKobo: 14_500_000, downPaymentKobo: 2_900_000, tenureMonths: 3, rateE4: 100_000, basis: "FLAT_TOTAL" });
    expect(t.financedKobo).toBe(11_600_000);
    expect(t.markupKobo).toBe(1_450_000); // 10% of ₦145,000
    expect(t.totalRepaymentKobo).toBe(13_050_000); // ₦145,000 + ₦14,500 − ₦29,000
    expect(t.instalmentKobo).toBe(4_350_000);
    expect(t.finalInstalmentKobo).toBe(4_350_000);
    expect(t.instalmentKobo * 2 + t.finalInstalmentKobo).toBe(t.totalRepaymentKobo);
    const m = computeTerms({ priceKobo: 14_500_000, downPaymentKobo: 2_900_000, tenureMonths: 12, rateE4: 35_000, basis: "FLAT_PER_MONTH" });
    expect(m.effectiveRateE4).toBe(420_000); // 3.5% × 12
    expect(m.markupKobo).toBe(6_090_000);
    expect(m.instalmentKobo * 11 + m.finalInstalmentKobo).toBe(m.totalRepaymentKobo);
    expect(() => computeTerms({ priceKobo: 14_500_000, downPaymentKobo: 2_900_000, tenureMonths: 9, rateE4: 1, basis: "FLAT_TOTAL" })).toThrow();
    expect(parseRateE4("3.3333")).toBe(33_333);
    expect(formatRateE4(125_000)).toBe("12.5%");
  });

  it("matches the approved figures for 3, 6 and 12 months (8.97%, 15.1%, 23.45% of ₦145,000, less ₦29,000 down)", () => {
    const cases: [number, number, number, number, number, number][] = [
      // tenure, rateE4, markup, balance in instalments, monthly, final (kobo)
      [3, 89_700, 1_300_650, 12_900_650, 4_300_217, 4_300_216],
      [6, 151_000, 2_189_500, 13_789_500, 2_298_250, 2_298_250],
      [12, 234_500, 3_400_250, 15_000_250, 1_250_021, 1_250_019],
    ];
    for (const [m, rate, markup, total, monthly, final] of cases) {
      const t = computeTerms({ priceKobo: 14_500_000, downPaymentKobo: 2_900_000, tenureMonths: m, rateE4: rate, basis: "FLAT_TOTAL" });
      expect([t.markupKobo, t.totalRepaymentKobo, t.instalmentKobo, t.finalInstalmentKobo]).toEqual([markup, total, monthly, final]);
      expect(t.instalmentKobo * (m - 1) + t.finalInstalmentKobo).toBe(total);
    }
  });

  it("maps scores into configured bands and refuses unconfigured bands", () => {
    expect(mapScore(700, 600, 450)).toBe("PASS");
    expect(mapScore(600, 600, 450)).toBe("PASS");
    expect(mapScore(500, 600, 450)).toBe("FAIR");
    expect(mapScore(449.99, 600, 450)).toBe("FAIL");
    expect(mapScore(700, null, 450)).toBeNull();
  });

  it("applies the short-month, weekend and public-holiday rules", () => {
    // From 15 Jan 2027, day 31: Feb has 28 days → 28 Feb 2027 (Sunday) → next business day 1 Mar.
    expect(repaymentDates({ startDate: "2027-01-15", months: 3, repaymentDay: 31, shortMonthRule: "LAST_DAY_OF_MONTH", weekendRule: "NEXT_BUSINESS_DAY" })).toEqual(["2027-03-01", "2027-03-31", "2027-04-30"]);
    expect(repaymentDates({ startDate: "2027-01-15", months: 1, repaymentDay: 31, shortMonthRule: "FIRST_DAY_OF_NEXT_MONTH", weekendRule: "NO_ADJUSTMENT" })).toEqual(["2027-03-01"]);
    // 25 Dec 2026 is a Friday holiday → previous business day 24 Dec.
    expect(repaymentDates({ startDate: "2026-11-12", months: 1, repaymentDay: 25, shortMonthRule: "LAST_DAY_OF_MONTH", weekendRule: "PREVIOUS_BUSINESS_DAY", holidays: ["2026-12-25"] })).toEqual(["2026-12-24"]);
  });
});

describe("catalogue and channel", () => {
  it("shows at most three active phones and only the Product Manager can change them", async () => {
    const pm = await ctxFor(ALT.pm);
    await expect(saveModel(pm, { name: "Fourth phone", specifications: "Spec", active: true, sortOrder: "4" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(saveModel(await ctxFor(ALT.doOfficer), { name: "X", specifications: "Spec", active: false, sortOrder: "0" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("Delight Officers sell from their Branch; Smile Associates from a BOX supplied by a Shop or Branch", async () => {
    const d = await ctxFor(ALT.doOfficer);
    const { id } = await startSale(d, { kind: "OUTRIGHT", modelId: models[0] });
    expect((await appRow(id)).channel).toBe("DO");
    await expect(saveLocations(d, id, { modelId: models[0], originId: await loc("Yaba Altbox"), supplyId: "" })).rejects.toMatchObject({ code: "VALIDATION" });
    await saveLocations(d, id, { modelId: models[0], originId: await loc("Ikeja Branch"), supplyId: await loc("Yaba Altshop") });
    expect((await appRow(id)).supply_location_id).toBe(await loc("Ikeja Branch")); // DO always supplies from the originating Branch
    const s = await ctxFor(ALT.sa);
    const sale = await startSale(s, { kind: "OUTRIGHT", modelId: models[0] });
    expect((await appRow(sale.id)).channel).toBe("SA");
    await expect(saveLocations(s, sale.id, { modelId: models[0], originId: await loc("Ikeja Branch"), supplyId: await loc("Yaba Altshop") })).rejects.toMatchObject({ fields: { originId: expect.any(String) } });
    await expect(saveLocations(s, sale.id, { modelId: models[0], originId: await loc("Yaba Altbox"), supplyId: await loc("Yaba Altbox") })).rejects.toMatchObject({ fields: { supplyId: expect.any(String) } });
    await saveLocations(s, sale.id, { modelId: models[0], originId: await loc("Yaba Altbox"), supplyId: await loc("Yaba Altshop") });
    const r = await appRow(sale.id);
    expect([r.origin_location_id, r.supply_location_id]).toEqual([await loc("Yaba Altbox"), await loc("Yaba Altshop")]);
    await expect(startSale(await ctxFor(ALT.pm), { kind: "OUTRIGHT", modelId: models[0] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("outright sale", () => {
  it("verifies ₦145,000, reserves on payment, deducts once at handover, and emails a receipt copying altbox", async () => {
    const before = await stockOf("Ikeja Branch", models[0]);
    const { id, ctx } = await outrightPaid();
    let r = await appRow(id);
    expect([r.status, r.reservation_status, r.price_kobo]).toEqual(["PAID", "RESERVED", "14500000"]);
    expect(await stockOf("Ikeja Branch", models[0])).toEqual({ physical: before.physical, reserved: 1, available: before.available - 1 });
    expect(bureau.calls).toHaveLength(0);
    await expect(completeOutright(ctx, id, { imei: IMEI[0], handedOver: false })).rejects.toMatchObject({ code: "VALIDATION" });
    await completeOutright(ctx, id, { imei: IMEI[0], handedOver: true });
    r = await appRow(id);
    expect([r.status, r.imei, r.reservation_status]).toEqual(["COMPLETED", IMEI[0], "CONSUMED"]);
    expect(r.receipt_number).toMatch(/^RCT-\d{4}-\d{6}$/);
    expect(await stockOf("Ikeja Branch", models[0])).toEqual({ physical: before.physical - 1, reserved: 0, available: before.available - 1 });
    const again = await completeOutright(ctx, id, { imei: IMEI[0], handedOver: true });
    expect(again.already).toBe(true);
    expect(await stockOf("Ikeja Branch", models[0])).toEqual({ physical: before.physical - 1, reserved: 0, available: before.available - 1 });
    const receipt = (await db.query("SELECT to_addresses, cc_addresses, body_text FROM notification_outbox WHERE kind = 'ALTPHONES_CUSTOMER_RECEIPT'")).rows;
    expect(receipt).toHaveLength(1);
    expect(receipt[0].to_addresses).toEqual(["customer@example.com"]);
    expect(receipt[0].cc_addresses).toEqual(["altbox@altbank.ng"]);
    expect(receipt[0].body_text).toContain(r.receipt_number);
    expect(receipt[0].body_text).toContain("₦145,000");
    const dev = (await db.query("SELECT status, application_id FROM altphones_devices WHERE imei = $1", [IMEI[0]])).rows[0];
    expect(dev).toEqual({ status: "ISSUED", application_id: id });
  });

  it("never records payment without a verified matching amount, and webhooks must be signed", async () => {
    const ctx = await ctxFor(ALT.doOfficer);
    const { id } = await startSale(ctx, { kind: "OUTRIGHT", modelId: models[0] });
    await saveLocations(ctx, id, { modelId: models[0], originId: await loc("Ikeja Branch"), supplyId: "" });
    await saveCustomer(ctx, id, CUSTOMER);
    await requestPayment(ctx, id, {});
    const ref = await latestPaymentRef(id);
    expect((await checkPayment(ctx, id)).status).toBe("PENDING");
    gw.pay(ref, 1_000_000); // wrong amount
    const body = JSON.stringify({ event: "charge.success", data: { reference: ref } });
    expect((await handlePaystackWebhook(ctx, body, "f".repeat(128))).status).toBe(401);
    const res = await handlePaystackWebhook(ctx, body, gw.sign(body));
    expect(res.outcome).toBe("MISMATCH");
    expect((await appRow(id)).status).toBe("AWAITING_PAYMENT");
    expect((await handlePaystackWebhook(ctx, body, gw.sign(body))).outcome).toBe("DUPLICATE");
  });

  it("without Paystack configured, payment cannot be requested", async () => {
    setPaymentGatewayForTests(null);
    const ctx = await ctxFor(ALT.doOfficer);
    const { id } = await startSale(ctx, { kind: "OUTRIGHT", modelId: models[0] });
    await saveLocations(ctx, id, { modelId: models[0], originId: await loc("Ikeja Branch"), supplyId: "" });
    await saveCustomer(ctx, id, CUSTOMER);
    await expect(requestPayment(ctx, id, {})).rejects.toMatchObject({ code: "GATE", message: expect.stringMatching(/Paystack is not configured/) });
  });
});

describe("credit assessment", () => {
  it("requires an 11-digit BVN, never treats an unavailable or failed check as a pass, and stores the BVN encrypted", async () => {
    const ctx = await ctxFor(ALT.doOfficer);
    const { id } = await startSale(ctx, { kind: "CREDIT", modelId: models[0] });
    await expect(runCreditCheck(ctx, id, { ...CREDIT_PERSON, bvn: "1234567890" })).rejects.toMatchObject({ fields: { bvn: expect.any(String) } });
    setCreditBureauForTests(null);
    const u = await runCreditCheck(ctx, id, { ...CREDIT_PERSON, bvn: "22222222222" });
    expect(u.outcome).toBe("UNAVAILABLE");
    let r = await appRow(id);
    expect([r.seedfi_status, r.seedfi_outcome]).toEqual(["UNAVAILABLE", null]);
    expect(r.bvn_enc).not.toContain("22222222222");
    await expect(saveCustomer(ctx, id, CREDIT_CUSTOMER)).rejects.toMatchObject({ code: "GATE" });
    setCreditBureauForTests(new TestBureau(null, new Error("timeout")));
    expect((await runCreditCheck(ctx, id, { ...CREDIT_PERSON, bvn: "22222222222" })).outcome).toBe("UNAVAILABLE");
    setCreditBureauForTests(new TestBureau(300));
    const f = await runCreditCheck(ctx, id, { ...CREDIT_PERSON, bvn: "22222222222" });
    expect(f.outcome).toBe("FAIL");
    r = await appRow(id);
    expect([r.status, r.seedfi_outcome, r.seedfi_score]).toEqual(["CREDIT_DECLINED", "FAIL", "300.00"]);
    expect(r.seedfi_reference).toMatch(/^altphones-[0-9a-f]{32}$/); // stable per BVN, never the BVN itself
    expect([r.customer_first_name, r.customer_last_name, r.customer_gender]).toEqual(["Synthetic", "Customer", "male"]);
    await expect(saveCustomer(ctx, id, CREDIT_CUSTOMER)).rejects.toMatchObject({ code: "CONFLICT" });
    const logged = (await db.query("SELECT count(*)::int AS n FROM audit_events WHERE details::text LIKE '%22222222222%'")).rows[0].n;
    expect(logged).toBe(0);
  });
});

describe("credit sale — Delight Officer route (Product Manager → Unit Head)", () => {
  it("locks the agreed terms, reserves on the verified down payment, and disburses once", async () => {
    const before = await stockOf("Ikeja Branch", models[0]);
    const { id, ctx } = await creditReady();
    let r = await appRow(id);
    expect([r.status, r.down_payment_kobo, r.financed_kobo, r.tenure_months, r.markup_rate_e4, r.markup_kobo]).toEqual(["IN_PREPARATION", "2900000", "11600000", 6, 200_000, "2900000"]);
    expect(await stockOf("Ikeja Branch", models[0])).toEqual({ physical: before.physical, reserved: 1, available: before.available - 1 });
    expect([r.dd_status, r.dd_account_last4]).toEqual(["ACTIVE", "6789"]);
    expect(r.internal_mandate_confirmed_at).not.toBeNull();
    expect(r.contract_accepted_at).not.toBeNull();
    const acc = (await db.query("SELECT a.contract_sha256, c.sha256, c.body FROM altphones_contract_acceptances a JOIN altphones_contracts c ON c.id = a.contract_id WHERE a.application_id = $1", [id])).rows[0];
    expect(acc.contract_sha256).toBe(acc.sha256);
    expect(acc.body).toContain("₦116,000");
    const otp = (await db.query("SELECT code_hash FROM altphones_otp_challenges WHERE application_id = $1", [id])).rows[0];
    expect(otp.code_hash).toMatch(/^[0-9a-f]{64}$/); // never the code itself

    // later pricing change does not affect this contract
    await savePricing(await ctxFor(ALT.pm), { rates: { "3": "1", "6": "1", "12": "1" }, basis: "FLAT_TOTAL", weekendRule: "NEXT_BUSINESS_DAY", shortMonthRule: "LAST_DAY_OF_MONTH", contractTemplate: "Contract {{ref}}", reason: "Later change" });

    await submitForApproval(ctx, id, {});
    expect((await appRow(id)).status).toBe("UNDER_PM_REVIEW");
    const uh = await ctxFor(ALT.unitHead);
    await expect(decide(uh, id, { action: "APPROVE", comments: "", reviewed: true })).rejects.toMatchObject({ code: "FORBIDDEN" }); // cannot skip the PM
    const pm = await ctxFor(ALT.pm);
    await expect(decide(pm, id, { action: "APPROVE", comments: "", reviewed: false })).rejects.toMatchObject({ code: "VALIDATION" });
    await decide(pm, id, { action: "APPROVE", comments: "Checked", reviewed: true });
    expect((await appRow(id)).status).toBe("UNDER_UNIT_HEAD_REVIEW");
    await decide(uh, id, { action: "APPROVE", comments: "", reviewed: true });
    r = await appRow(id);
    expect(r.status).toBe("APPROVED");
    expect(r.markup_kobo).toBe("2900000");
    expect((await db.query("SELECT 1 FROM notification_outbox WHERE kind = 'ALTPHONES_APPROVED'")).rowCount).toBe(1);

    await expect(confirmDisbursement(pm, id, { imei: IMEI[1], modelConfirmed: true, locationConfirmed: true, handedOver: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await confirmDisbursement(ctx, id, { imei: IMEI[1], modelConfirmed: true, locationConfirmed: true, handedOver: true });
    r = await appRow(id);
    expect([r.status, r.imei, r.reservation_status]).toEqual(["DISBURSED", IMEI[1], "CONSUMED"]);
    expect(await stockOf("Ikeja Branch", models[0])).toEqual({ physical: before.physical - 1, reserved: 0, available: before.available - 1 });
    const again = await confirmDisbursement(ctx, id, { imei: IMEI[1], modelConfirmed: true, locationConfirmed: true, handedOver: true });
    expect(again.already).toBe(true);
    expect(await stockOf("Ikeja Branch", models[0])).toEqual({ physical: before.physical - 1, reserved: 0, available: before.available - 1 });
    const sched = (await db.query("SELECT basis, amount_kobo FROM altphones_schedule WHERE application_id = $1 ORDER BY seq", [id])).rows;
    expect(sched).toHaveLength(6);
    expect(sched.every((s) => s.basis === "FINAL")).toBe(true);
    expect(sched.reduce((a, s) => a + Number(s.amount_kobo), 0)).toBe(Number(r.total_repayment_kobo));
    const customerMails = (await db.query("SELECT kind, cc_addresses FROM notification_outbox WHERE kind LIKE 'ALTPHONES_CUSTOMER_%' ORDER BY created_at")).rows;
    expect(customerMails.map((m) => m.kind)).toEqual(["ALTPHONES_CUSTOMER_CONTRACT_ACCEPTED_1", "ALTPHONES_CUSTOMER_DISBURSED"]);
    expect(customerMails.every((m) => m.cc_addresses.includes("altbox@altbank.ng"))).toBe(true);
  });

  it("cannot submit until payment, both mandates and the contract are in place; OTP has retry limits", async () => {
    const ctx = await ctxFor(ALT.doOfficer);
    const { id } = await startSale(ctx, { kind: "CREDIT", modelId: models[0] });
    await runCreditCheck(ctx, id, { ...CREDIT_PERSON, bvn: "22222222222" });
    await saveLocations(ctx, id, { modelId: models[0], originId: await loc("Ikeja Branch"), supplyId: "" });
    await saveCustomer(ctx, id, CREDIT_CUSTOMER);
    await requestPayment(ctx, id, {});
    await expect(submitForApproval(ctx, id, {})).rejects.toMatchObject({ code: "CONFLICT" });
    gw.pay(await latestPaymentRef(id));
    await checkPayment(ctx, id);
    await expect(submitForApproval(ctx, id, {})).rejects.toMatchObject({ code: "GATE", message: expect.stringMatching(/Direct Debit/) });
    await expect(sendContractOtp(ctx, id, {})).rejects.toMatchObject({ code: "GATE" });
    await startDirectDebit(ctx, id);
    expect((await checkDirectDebit(ctx, id)).status).toBe("PENDING");
    gw.authorize((await appRow(id)).dd_reference);
    await checkDirectDebit(ctx, id);
    await confirmInternalMandate(ctx, id, { confirmed: true });
    await sendContractOtp(ctx, id, {});
    const good = mail.lastCode()!;
    const bad = good === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await expect(acceptContract(ctx, id, { code: bad })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(acceptContract(ctx, id, { code: bad })).rejects.toMatchObject({ message: expect.stringMatching(/Too many/) });
    await expect(acceptContract(ctx, id, { code: good })).rejects.toMatchObject({ message: expect.stringMatching(/No active code/) });
    await sendContractOtp(ctx, id, {});
    await acceptContract(ctx, id, { code: mail.lastCode()! });
    await submitForApproval(ctx, id, {});
    expect((await appRow(id)).status).toBe("UNDER_PM_REVIEW");
  });
});

describe("credit sale — Smile Associate route (BPM → Product Manager → Unit Head)", () => {
  it("follows every stage in order, supports return and resubmission, and returns to the originator", async () => {
    const { id, ctx } = await creditReady(ALT.sa);
    await submitForApproval(ctx, id, {});
    expect((await appRow(id)).status).toBe("UNDER_BPM_REVIEW");
    const pm = await ctxFor(ALT.pm);
    await expect(decide(pm, id, { action: "APPROVE", comments: "", reviewed: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const bpm = await ctxFor(ALT.bpm);
    await expect(decide(bpm, id, { action: "RETURN", comments: "", reviewed: false })).rejects.toMatchObject({ code: "VALIDATION" });
    await decide(bpm, id, { action: "RETURN", comments: "Attach clearer evidence", reviewed: false });
    expect((await appRow(id)).status).toBe("RETURNED_FOR_CORRECTION");
    await submitForApproval(ctx, id, { comments: "Updated" });
    expect((await appRow(id)).status).toBe("UNDER_BPM_REVIEW");
    await decide(bpm, id, { action: "APPROVE", comments: "", reviewed: true });
    expect((await appRow(id)).status).toBe("UNDER_PM_REVIEW");
    // The BPM cannot also act as Product Manager on the same application
    await grantRole(await ctxFor(ALT.admin), { staffId: await sidOf(ALT.bpm), role: "ALTPHONES_PRODUCT_MANAGER" });
    await expect(decide(bpm, id, { action: "APPROVE", comments: "", reviewed: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await decide(pm, id, { action: "APPROVE", comments: "", reviewed: true });
    await decide(await ctxFor(ALT.unitHead), id, { action: "APPROVE", comments: "", reviewed: true });
    expect((await appRow(id)).status).toBe("APPROVED");
    const reviews = (await db.query("SELECT stage, action FROM altphones_reviews WHERE application_id = $1 ORDER BY submission_no, CASE stage WHEN 'BPM' THEN 1 WHEN 'PM' THEN 2 ELSE 3 END", [id])).rows;
    expect(reviews).toEqual([
      { stage: "BPM", action: "RETURN" },
      { stage: "BPM", action: "APPROVE" },
      { stage: "PM", action: "APPROVE" },
      { stage: "UNIT_HEAD", action: "APPROVE" },
    ]);
    const before = await stockOf("Yaba Altshop", models[0]);
    await confirmDisbursement(ctx, id, { imei: IMEI[2], modelConfirmed: true, locationConfirmed: true, handedOver: true });
    expect(await stockOf("Yaba Altshop", models[0])).toEqual({ physical: before.physical - 1, reserved: before.reserved - 1, available: before.available });
    const r = await appRow(id);
    expect([r.status, r.origin_location_id]).toEqual(["DISBURSED", await loc("Yaba Altbox")]);
    expect((await db.query("SELECT 1 FROM altphones_stock WHERE location_id = $1", [await loc("Yaba Altbox")])).rowCount).toBe(0);
  });

  it("rejection releases the reservation and flags the down payment for refund", async () => {
    const { id, ctx } = await creditReady(ALT.sa);
    await submitForApproval(ctx, id, {});
    const before = await stockOf("Yaba Altshop", models[0]);
    await decide(await ctxFor(ALT.bpm), id, { action: "REJECT", comments: "Not eligible", reviewed: false });
    const r = await appRow(id);
    expect([r.status, r.reservation_status, r.refund_status]).toEqual(["REJECTED", "RELEASED", "REQUIRED"]);
    expect(await stockOf("Yaba Altshop", models[0])).toEqual({ physical: before.physical, reserved: before.reserved - 1, available: before.available + 1 });
  });
});

describe("stock integrity", () => {
  it("never oversells: the last unit is reserved once, the second paid sale waits without a reservation", async () => {
    const pm = await ctxFor(ALT.pm);
    const admin = await ctxFor(ALT.admin);
    const req = await requestReplenishment(pm, { kind: "OPENING", locationId: await loc("Wuse Altshop"), modelId: models[1], quantity: "1", imeis: IMEI[3], reason: "Synthetic" });
    await decideReplenishment(admin, req.id, { decision: "APPROVE", comment: "" });
    const sa = await ctxFor(ALT.sa);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { id } = await startSale(sa, { kind: "OUTRIGHT", modelId: models[1] });
      await saveLocations(sa, id, { modelId: models[1], originId: await loc("Yaba Altbox"), supplyId: await loc("Wuse Altshop") });
      await saveCustomer(sa, id, CUSTOMER);
      await requestPayment(sa, id, {});
      ids.push(id);
    }
    for (const id of ids) gw.pay(await latestPaymentRef(id));
    await Promise.all(ids.map((id) => checkPayment(sa, id)));
    const rows = await Promise.all(ids.map(appRow));
    expect(rows.map((r) => r.reservation_status).sort()).toEqual(["NONE", "RESERVED"]);
    expect(await stockOf("Wuse Altshop", models[1])).toEqual({ physical: 1, reserved: 1, available: 0 });
    const reservedApp = rows.find((r) => r.reservation_status === "RESERVED")!;
    expect(reservedApp.device_id).not.toBeNull(); // the registered IMEI was earmarked
    expect((await db.query("SELECT 1 FROM notification_outbox WHERE kind = 'ALTPHONES_EXCEPTION_PAID_NO_STOCK'")).rowCount).toBe(1);
    // cancelling the reserved sale releases the unit and flags a refund
    await cancelApplication(sa, reservedApp.id, { reason: "Customer changed mind" });
    expect(await stockOf("Wuse Altshop", models[1])).toEqual({ physical: 1, reserved: 0, available: 1 });
    expect((await appRow(reservedApp.id)).refund_status).toBe("REQUIRED");
  });

  it("BOX locations never hold stock; replenishment needs a Super Admin who did not request it", async () => {
    const pm = await ctxFor(ALT.pm);
    await expect(requestReplenishment(pm, { kind: "RECEIPT", locationId: await loc("Yaba Altbox"), modelId: models[0], quantity: "5", imeis: "", reason: "Test" })).rejects.toMatchObject({ fields: { locationId: expect.any(String) } });
    await expect(db.query("INSERT INTO altphones_stock (location_id, model_id, physical) VALUES ($1,$2,5)", [await loc("Yaba Altbox"), models[0]])).rejects.toThrow(/Only Branches and Shops/);
    await expect(requestReplenishment(await ctxFor(ALT.doOfficer), { kind: "RECEIPT", locationId: await loc("Ikeja Branch"), modelId: models[0], quantity: "5", imeis: "", reason: "Test" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const before = await stockOf("Ikeja Branch", models[0]);
    const r = await requestReplenishment(pm, { kind: "RECEIPT", locationId: await loc("Ikeja Branch"), modelId: models[0], quantity: "5", imeis: "", reason: "Delivery note 42" });
    expect(await stockOf("Ikeja Branch", models[0])).toEqual(before); // nothing until approved
    await expect(decideReplenishment(pm, r.id, { decision: "APPROVE", comment: "" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await decideReplenishment(await ctxFor(ALT.admin), r.id, { decision: "APPROVE", comment: "" });
    await expect(decideReplenishment(await ctxFor(ALT.admin), r.id, { decision: "APPROVE", comment: "" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await stockOf("Ikeja Branch", models[0])).physical).toBe(before.physical + 5);
    await expect(db.query("UPDATE altphones_stock_ledger SET physical_delta = 100")).rejects.toThrow(/append-only/);
    const ov = (await stockOverview(db)).find((x) => x.location_name === "Ikeja Branch" && x.model_id === models[0])!;
    expect(ov.remaining).toBe(ov.physical); // ledger reconciles with the balance
  });
});

describe("historical imports", () => {
  it("imports legacy transactions without payments, emails or stock movements, and refuses duplicates", async () => {
    const admin = await ctxFor(ALT.admin);
    const before = await stockOf("Ikeja Branch", models[0]);
    const outboxBefore = (await db.query("SELECT count(*)::int AS n FROM notification_outbox")).rows[0].n;
    const csv = [
      "Reference,Type,Customer name,Customer email,Customer phone,Phone model,IMEI,Transaction date,Originating officer,Originating location,Supplying location,Tenure",
      `LEG-1,Outright,Old Customer,old@example.com,08031234567,Altphone L1 Series — Black & Gold,${IMEI[0]},2026-02-01,do.ife@altbank.ng,Ikeja Branch,Ikeja Branch,`,
      `LEG-2,Credit,Old Credit,,,Altphone L1 Series — Black & Gold,${IMEI[1]},15/03/2026,,Yaba Altbox,Yaba Altshop,6`,
      `LEG-2,Credit,Dup Ref,,,Altphone L1 Series — Black & Gold,${IMEI[2]},2026-03-15,,Yaba Altbox,Yaba Altshop,6`,
    ].join("\n");
    const bad = await previewImport(admin, "TRANSACTIONS", "legacy.csv", Buffer.from(csv));
    expect(bad.summary).toMatchObject({ rows: 3, valid: 2, errors: 1 });
    await expect(commitImport(admin, bad.id)).rejects.toMatchObject({ code: "VALIDATION" });
    const good = await previewImport(admin, "TRANSACTIONS", "legacy.csv", Buffer.from(csv.split("\n").slice(0, 3).join("\n")));
    expect(good.summary).toMatchObject({ valid: 2, errors: 0 });
    await commitImport(admin, good.id);
    const apps = (await db.query("SELECT status, legacy, channel, legacy_ref FROM altphones_applications WHERE legacy ORDER BY legacy_ref")).rows;
    expect(apps).toEqual([
      { status: "COMPLETED", legacy: true, channel: "DO", legacy_ref: "LEG-1" },
      { status: "DISBURSED", legacy: true, channel: "SA", legacy_ref: "LEG-2" },
    ]);
    expect(await stockOf("Ikeja Branch", models[0])).toEqual(before);
    expect((await db.query("SELECT count(*)::int AS n FROM altphones_payments")).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM notification_outbox")).rows[0].n).toBe(outboxBefore);
    await expect(previewImport(admin, "TRANSACTIONS", "legacy.csv", Buffer.from(csv.split("\n").slice(0, 3).join("\n")))).rejects.toMatchObject({ code: "CONFLICT" });
    const again = await previewImport(admin, "TRANSACTIONS", "legacy-again.csv", Buffer.from(csv.split("\n").slice(0, 2).join("\n") + "\n"));
    expect(again.summary).toMatchObject({ valid: 0, errors: 1 }); // reference and IMEI already recorded
    await expect(previewImport(await ctxFor(ALT.pm), "TRANSACTIONS", "x.csv", Buffer.from(csv))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("imports historical stock movements once, as legacy ledger entries", async () => {
    const admin = await ctxFor(ALT.admin);
    const csv = "Reference,Location,Phone model,Movement,Quantity,Date,Note\nS-1,Wuse Altshop,Altphone L1 Series — Green,Opening,10,2026-01-01,\nS-2,Wuse Altshop,Altphone L1 Series — Green,Sale,3,2026-02-01,\nS-3,Yaba Altbox,Altphone L1 Series — Green,Receipt,3,2026-02-01,\n";
    const p1 = await previewImport(admin, "STOCK", "stock.csv", Buffer.from(csv));
    expect(p1.summary).toMatchObject({ valid: 2, errors: 1 }); // BOX row refused
    const ok = await previewImport(admin, "STOCK", "stock.csv", Buffer.from(csv.split("\n").slice(0, 3).join("\n")));
    await commitImport(admin, ok.id);
    expect(await stockOf("Wuse Altshop", models[1])).toEqual({ physical: 7, reserved: 0, available: 7 });
    const ov = (await stockOverview(db)).find((x) => x.location_name === "Wuse Altshop" && x.model_id === models[1])!;
    expect([ov.opening, ov.sales, ov.remaining]).toEqual([10, 3, 7]);
    const dup = await previewImport(admin, "STOCK", "stock-2.csv", Buffer.from(csv.split("\n").slice(0, 2).join("\n") + "\n"));
    expect(dup.summary).toMatchObject({ valid: 0, errors: 1 });
  });

  it("imports locations with validation and duplicate prevention", async () => {
    const admin = await ctxFor(ALT.admin);
    // Addresses are never uploaded here.
    await expect(previewImport(admin, "LOCATIONS", "with-address.csv", Buffer.from("State,City,Type,Name,Address\nLAGOS,Lekki,Shop,Lekki Altshop,1 Road\n"))).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringMatching(/Addresses are not uploaded/) });
    const csv = "State,City,Type,Name\nLAGOS,Lekki,Shop,Lekki Altshop\nLAGOS,Lekki,BOX,Lekki Altbox\nLAGOS,Ikeja,Branch,Ikeja Branch\nATLANTIS,X,Shop,Nowhere\nLAGOS,Lekki,Shop,Lekki Altshop\n";
    const p = await previewImport(admin, "LOCATIONS", "locations.csv", Buffer.from(csv));
    expect(p.summary).toMatchObject({ rows: 5, valid: 2, errors: 2, skipped: 1 });
    const fixed = await previewImport(admin, "LOCATIONS", "locations-fixed.csv", Buffer.from(csv.split("\n").slice(0, 4).join("\n") + "\n"));
    await commitImport(admin, fixed.id);
    expect((await db.query("SELECT outlet_type FROM locations WHERE name IN ('Lekki Altshop','Lekki Altbox') ORDER BY name")).rows.map((r) => r.outlet_type)).toEqual(["ALTBOX", "ALTSHOP"]);
  });
});

describe("setup uploads", () => {
  it("provisions Delight Officers and Smile Associates with their route and home location", async () => {
    const admin = await ctxFor(ALT.admin);
    const roles = async (email: string) =>
      (await db.query("SELECT role FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE s.email = $1 AND ra.active AND ra.role IN ('DELIGHT_OFFICER','SMILE_ASSOCIATE') ORDER BY role", [email])).rows.map((r) => r.role);
    const head = "Email,Full name,Route,State,Home location,Active";
    const csv = [
      head,
      "new.officer@altbank.ng,Nkechi New-Officer,Delight Officer,LAGOS,Ikeja Branch,Yes",
      "nobody@altbank.ng,Not In Directory,DO,LAGOS,,Yes",
      "someone@gmail.com,Outside,SA,LAGOS,,Yes",
      "new.officer2@altbank.ng,Wrong Home,SA,LAGOS,Ikeja Branch,Yes",
      "x@altbank.ng,Bad Route,Cashier,LAGOS,,Yes",
    ].join("\n");
    const p = await previewImport(admin, "OFFICERS", "officers.csv", Buffer.from(csv));
    expect(p.summary).toMatchObject({ rows: 5, valid: 1, errors: 4 });
    await expect(commitImport(admin, p.id)).rejects.toMatchObject({ code: "VALIDATION" });
    const ok = await previewImport(admin, "OFFICERS", "officers-ok.csv", Buffer.from(csv.split("\n").slice(0, 2).join("\n")));
    await commitImport(admin, ok.id);
    expect(await roles("new.officer@altbank.ng")).toEqual(["DELIGHT_OFFICER"]);
    const home = (await db.query("SELECT l.name FROM altphones_officer_homes h JOIN staff s ON s.id = h.staff_id JOIN locations l ON l.id = h.location_id WHERE s.email = 'new.officer@altbank.ng'")).rows[0];
    expect(home.name).toBe("Ikeja Branch");
    // Switching route revokes the other one; the home must suit the new route.
    const sw = await previewImport(admin, "OFFICERS", "officers-switch.csv", Buffer.from(`${head}\nnew.officer@altbank.ng,Nkechi New-Officer,SA,LAGOS,Yaba Altbox,Yes\n`));
    await commitImport(admin, sw.id);
    expect(await roles("new.officer@altbank.ng")).toEqual(["SMILE_ASSOCIATE"]);
    // Active = No removes Altphones access.
    const off = await previewImport(admin, "OFFICERS", "officers-off.csv", Buffer.from(`${head}\nnew.officer@altbank.ng,Nkechi New-Officer,SA,LAGOS,,No\n`));
    await commitImport(admin, off.id);
    expect(await roles("new.officer@altbank.ng")).toEqual([]);
    await expect(previewImport(await ctxFor(ALT.pm), "OFFICERS", "x.csv", Buffer.from(csv))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("loads opening stock at Branches and Shops with optional IMEIs, never at a BOX, and only once", async () => {
    const admin = await ctxFor(ALT.admin);
    const before = await stockOf("Wuse Altshop", models[2]);
    const csv = `Location,Phone model,Quantity,IMEIs,Note\nWuse Altshop,Altphone L1 Series — Blue,4,${IMEI[0]} ${IMEI[1]},Launch stock\nYaba Altbox,Altphone L1 Series — Blue,2,,\nWuse Altshop,Altphone L1 Series — Blue,1,,\n`;
    const p = await previewImport(admin, "OPENING_STOCK", "opening.csv", Buffer.from(csv));
    expect(p.summary).toMatchObject({ rows: 3, valid: 1, errors: 2 }); // BOX row and repeated location/model refused
    const good = csv.split("\n").slice(0, 2).join("\n") + "\n";
    const ok = await previewImport(admin, "OPENING_STOCK", "opening-ok.csv", Buffer.from(good));
    await commitImport(admin, ok.id);
    expect(await stockOf("Wuse Altshop", models[2])).toEqual({ physical: before.physical + 4, reserved: before.reserved, available: before.available + 4 });
    expect((await db.query("SELECT count(*)::int AS n FROM altphones_devices WHERE imei = ANY($1) AND status = 'IN_STOCK'", [[IMEI[0], IMEI[1]]])).rows[0].n).toBe(2);
    await expect(previewImport(admin, "OPENING_STOCK", "opening-ok.csv", Buffer.from(good))).rejects.toMatchObject({ code: "CONFLICT" });
    const again = await previewImport(admin, "OPENING_STOCK", "opening-again.csv", Buffer.from(good.replace("Launch stock", "again")));
    expect(again.summary).toMatchObject({ valid: 0, errors: 1 }); // IMEIs already registered
  });
});

describe("access", () => {
  it("only the originator, the reviewers of its stages and Super Admins can open an application", async () => {
    const { id } = await creditReady(ALT.sa);
    await expect(viewableApp(await ctxFor(ALT.doOfficer), db, id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewableApp(await ctxFor(ALT.bpm), db, id)).rejects.toMatchObject({ code: "FORBIDDEN" }); // not yet submitted
    await submitForApproval(await ctxFor(ALT.sa), id, {});
    expect([...(await viewableApp(await ctxFor(ALT.bpm), db, id)).as]).toContain("BPM");
    expect([...(await viewableApp(await ctxFor(ALT.admin), db, id)).as]).toContain("ADMIN");
    expect((await db.query("SELECT 1 FROM audit_events WHERE action = 'ALTPHONES_VIEW_DENIED'")).rowCount).toBeGreaterThan(0);
    void lv;
  });
});

describe("approved catalogue", () => {
  it("ships the Altphone L1 Series in its three colours with the deck specifications and photos", async () => {
    const rows = (await db.query("SELECT name, specifications, image_key, active FROM altphones_models WHERE active ORDER BY sort_order")).rows;
    expect(rows.map((r) => r.name)).toEqual(["Altphone L1 Series — Black & Gold", "Altphone L1 Series — Green", "Altphone L1 Series — Blue"]);
    for (const r of rows) {
      expect(r.specifications).toContain("4GB RAM · 128GB storage");
      expect(r.specifications).toContain("MediaTek G81");
      expect(r.image_key).toMatch(/^static:altphones\/altphone-l1-[a-z-]+\.webp$/);
    }
    const { readModelImage } = await import("@/server/altphones/catalogue");
    const id = (await db.query("SELECT id FROM altphones_models WHERE name LIKE '%Green'")).rows[0].id;
    expect(await readModelImage(id)).toEqual({ staticPath: "/images/altphones/altphone-l1-green.webp" });
  });

  it("a fresh installation records the approved markup rates as a settings version", async () => {
    const r = (await db.query("SELECT markup_rates, markup_basis, reason FROM altphones_settings WHERE markup_rates = $1::jsonb ORDER BY version LIMIT 1", [JSON.stringify({ "3": 89700, "6": 151000, "12": 234500 })])).rows[0];
    expect(r).toBeDefined();
    expect(r.markup_basis).toBe("FLAT_TOTAL");
  });

  it("a fresh installation records SeedFi's documented decision bands as a settings version", async () => {
    const v2 = (await db.query("SELECT score_pass_min, score_fair_min, reason FROM altphones_settings WHERE version = 2")).rows[0];
    expect([v2.score_pass_min, v2.score_fair_min]).toEqual(["620.00", "530.00"]);
    expect(v2.reason).toMatch(/SeedFi Loan Engine API documentation v2.0/);
  });
});

describe("SeedFi Seed Score client (API documentation v2.0)", () => {
  const PERSONAS = {
    // Staging personas from the SeedFi documentation (section 3.2) with their documented responses.
    "12345654321": { overall: 384, reviewed: 384, history: false }, // Theodore Stone — clean, no history
    "09876567890": { overall: 532, reviewed: 532, history: true }, // Nathan Smith — clean, has history
    "12345678901": { overall: 544, reviewed: 444, history: true }, // John Doe — bad credit
  } as Record<string, { overall: number; reviewed: number; history: boolean }>;
  const saved = { ...process.env };
  let requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[];
  beforeEach(() => {
    requests = [];
    Object.assign(process.env, { SEEDFI_ENABLED: "true", SEEDFI_BASE_URL: "https://stg-loan-engine.theseedfi.com", SEEDFI_API_KEY: "test-api-key" });
    setCreditBureauForTests(undefined);
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push({ url, headers: init.headers as Record<string, string>, body });
      const p = PERSONAS[body.bvn];
      if (!p) return new Response(JSON.stringify({ detail: "BVN not found", status_code: 400 }), { status: 400 });
      return new Response(
        JSON.stringify({
          credit_score: {
            payment_history: { payment_history_score: 16.5, payment_history_seedfi_score: 132.0 },
            demographics: { demographics_score: 8.0, demographics_seedfi_score: 64.0 },
            overall_seedfi_score: p.overall,
            reviewed_seedfi_score: p.reviewed,
            user_has_credit_history: p.history,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ["SEEDFI_ENABLED", "SEEDFI_BASE_URL", "SEEDFI_API_KEY"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function check(bvn: string) {
    const ctx = await ctxFor(ALT.doOfficer);
    const { id } = await startSale(ctx, { kind: "CREDIT", modelId: models[0] });
    const res = await runCreditCheck(ctx, id, { bvn, firstName: "Nathan", lastName: "Smith", dateOfBirth: "1990-01-15", gender: "Male", phone: "0803 123 4567", consent: true });
    return { res, row: await appRow(id) };
  }

  it("calls the documented endpoint with the X-API-Key and the required fields", async () => {
    await check("09876567890");
    expect(requests).toHaveLength(1);
    const r = requests[0];
    expect(r.url).toBe("https://stg-loan-engine.theseedfi.com/scoring/api/v1/seed-score/calculate");
    expect(r.headers["x-api-key"]).toBe("test-api-key");
    expect(r.body).toMatchObject({ first_name: "Nathan", last_name: "Smith", bvn: "09876567890", date_of_birth: "1990-01-15", phone_number: "08031234567", gender: "male" });
    expect(String(r.body.customer_id)).toMatch(/^altphones-[0-9a-f]{32}$/);
  });

  it("maps the documented personas with SeedFi's bands (Pass ≥ 620, Fair 530–619, Fail < 530) on the reviewed score", async () => {
    const nathan = await check("09876567890");
    expect([nathan.res.outcome, nathan.row.seedfi_score, nathan.row.seedfi_overall_score, nathan.row.seedfi_has_history]).toEqual(["FAIR", "532.00", "532.00", true]);
    const john = await check("12345678901"); // overall 544 would be Fair, but the reviewed score 444 is used
    expect([john.res.outcome, john.row.status, john.row.seedfi_score, john.row.seedfi_overall_score]).toEqual(["FAIL", "CREDIT_DECLINED", "444.00", "544.00"]);
    const theodore = await check("12345654321");
    expect(theodore.res.outcome).toBe("FAIL");
    expect(theodore.row.seedfi_details.components.payment_history).toEqual({ payment_history_score: 16.5, payment_history_seedfi_score: 132 });
  });

  it("treats SeedFi errors and malformed scores as unavailable, never as a pass", async () => {
    const err = await check("11111111111");
    expect(err.res.outcome).toBe("UNAVAILABLE");
    expect(err.row.seedfi_last_error).toMatch(/BVN not found \(HTTP 400\)/);
    expect(err.row.seedfi_outcome).toBeNull();
    const { parseSeedScore } = await import("@/server/altphones/integrations");
    expect(() => parseSeedScore({ credit_score: { overall_seedfi_score: 950 } }, "x")).toThrow();
    expect(() => parseSeedScore({ status: 200, data: {} }, "x")).toThrow();
    expect(parseSeedScore({ status: 200, data: { credit_score: { overall_seedfi_score: 700 } } }, "x").score).toBe(700);
    // Shape returned by SeedFi staging (verified live): wrapped in { status, data }, with validity_date and is_dummy_data.
    const live = parseSeedScore({ status: 200, data: { credit_score: { overall_seedfi_score: 544.0, reviewed_seedfi_score: 444.0, user_has_credit_history: true, validity_date: "2026-12-12T22:48:00.360104", cached: false, is_dummy_data: true } } }, "c1");
    expect([live.score, live.overallScore, live.validUntil, live.isDummyData]).toEqual([444, 544, "2026-12-12", true]);
  });

  it("validates the Seed Score inputs before calling SeedFi", async () => {
    const ctx = await ctxFor(ALT.doOfficer);
    const { id } = await startSale(ctx, { kind: "CREDIT", modelId: models[0] });
    await expect(runCreditCheck(ctx, id, { bvn: "09876567890", firstName: "", lastName: "Smith", dateOfBirth: "2999-01-01", gender: "x", phone: "123", consent: true })).rejects.toMatchObject({
      fields: { firstName: expect.any(String), dateOfBirth: expect.any(String), gender: expect.any(String), phone: expect.any(String) },
    });
    expect(requests).toHaveLength(0);
  });
});

describe("contract wording", () => {
  it("the starting draft uses only known placeholders and renders completely", async () => {
    const { CONTRACT_DRAFT, unknownPlaceholders, renderContract, SAMPLE_CONTRACT_VALUES } = await import("@/lib/altphones-contract");
    expect(unknownPlaceholders(CONTRACT_DRAFT)).toEqual([]);
    const out = renderContract(CONTRACT_DRAFT, SAMPLE_CONTRACT_VALUES);
    expect(out).not.toMatch(/\{\{/);
    expect(out).toContain("Altphone L1 Series — Green");
    expect(out).toMatch(/no interest/);
  });

  it("a Super Admin or the Altphones Product Manager can change it; others cannot; drafts and unknown placeholders are refused", async () => {
    const { saveContract } = await import("@/server/altphones/catalogue");
    const { CONTRACT_DRAFT } = await import("@/lib/altphones-contract");
    const approved = CONTRACT_DRAFT.replace(/\[DRAFT FOR LEGAL AND SHARIAH REVIEW[^\]]*\]\n/, "");
    await expect(saveContract(await ctxFor(ALT.admin), { template: CONTRACT_DRAFT, reason: "Legal memo 1" })).rejects.toMatchObject({ fields: { template: expect.stringMatching(/draft notice/) } });
    await expect(saveContract(await ctxFor(ALT.admin), { template: approved + "\n{{loan_amount}}", reason: "Legal memo 1" })).rejects.toMatchObject({ fields: { template: expect.stringMatching(/loan_amount/) } });
    await expect(saveContract(await ctxFor(ALT.doOfficer), { template: approved, reason: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const v1 = await saveContract(await ctxFor(ALT.admin), { template: approved, reason: "Legal and Shariah approval L-001" });
    const v2 = await saveContract(await ctxFor(ALT.pm), { template: approved.replace("Please read it carefully.", "Please read it carefully before you agree."), reason: "Wording tweak L-002" });
    expect(v2.version).toBe(v1.version + 1);
    const row = (await db.query("SELECT contract_template, reason FROM altphones_settings WHERE version = $1", [v2.version])).rows[0];
    expect(row.contract_template).toContain("before you agree");
    expect(row.reason).toBe("Contract wording: Wording tweak L-002");
    // pricing changes keep the wording
    await savePricing(await ctxFor(ALT.pm), { rates: { "3": "1", "6": "1", "12": "1" }, basis: "FLAT_PER_MONTH", weekendRule: "NEXT_BUSINESS_DAY", shortMonthRule: "LAST_DAY_OF_MONTH", reason: "Rates" });
    expect((await db.query("SELECT contract_template FROM altphones_settings ORDER BY version DESC LIMIT 1")).rows[0].contract_template).toContain("before you agree");
  });

  it("an issued contract is filled in with the customer's figures, including the team mailbox", async () => {
    const { saveContract } = await import("@/server/altphones/catalogue");
    const { CONTRACT_DRAFT } = await import("@/lib/altphones-contract");
    await saveContract(await ctxFor(ALT.admin), { template: CONTRACT_DRAFT.replace(/\[DRAFT FOR LEGAL AND SHARIAH REVIEW[^\]]*\]\n/, ""), reason: "L-001" });
    const { id } = await creditReady();
    const body = (await db.query("SELECT c.body FROM altphones_contracts c JOIN altphones_applications a ON a.contract_id = c.id WHERE a.id = $1", [id])).rows[0].body;
    expect(body).not.toMatch(/\{\{/);
    expect(body).toContain("Email altbox@altbank.ng");
    expect(body).toContain("₦174,000");
    expect(body).toContain("Synthetic Customer");
  });
});

describe("account name enquiry (Paystack)", () => {
  async function toCustomerStep() {
    const ctx = await ctxFor(ALT.doOfficer);
    const { id } = await startSale(ctx, { kind: "CREDIT", modelId: models[0] });
    await runCreditCheck(ctx, id, { ...CREDIT_PERSON, bvn: "22222222222" });
    await saveLocations(ctx, id, { modelId: models[0], originId: await loc("Ikeja Branch"), supplyId: "" });
    return { ctx, id };
  }

  it("looks up both accounts and stores the names as verified by Paystack", async () => {
    const { ctx, id } = await toCustomerStep();
    await saveCustomer(ctx, id, CREDIT_CUSTOMER);
    const r = await appRow(id);
    expect([r.ab_account_name, r.external_account_name, r.external_bank_name, r.external_bank_code, r.accounts_verified_via]).toEqual(["SYNTHETIC CUSTOMER", "SYNTHETIC CUSTOMER 3210", "Synthetic Bank", "058", "PAYSTACK"]);
  });

  it("refuses accounts that do not exist and banks not on Paystack's list", async () => {
    const { ctx, id } = await toCustomerStep();
    gw.missingAccounts.add("058:9876543210");
    gw.missingAccounts.add("000304:0123456789");
    await expect(saveCustomer(ctx, id, CREDIT_CUSTOMER)).rejects.toMatchObject({ fields: { externalAccount: expect.stringMatching(/No Synthetic Bank account/), abAccount: expect.stringMatching(/No Alternative Bank account/) } });
    await expect(saveCustomer(ctx, id, { ...CREDIT_CUSTOMER, externalBankCode: "999" })).rejects.toMatchObject({ fields: { externalBank: expect.any(String) } });
    await expect(saveCustomer(ctx, id, { ...CREDIT_CUSTOMER, externalBankCode: "000304" })).rejects.toMatchObject({ fields: { externalBank: expect.any(String) } }); // must be another bank
  });

  it("without Paystack the officer confirms the accounts manually", async () => {
    const { ctx, id } = await toCustomerStep();
    setPaymentGatewayForTests(null);
    await expect(saveCustomer(ctx, id, { ...CREDIT_CUSTOMER, externalBankCode: undefined })).rejects.toMatchObject({ fields: { externalBank: expect.any(String) } });
    await saveCustomer(ctx, id, { ...CREDIT_CUSTOMER, externalBankCode: undefined, externalBank: "Example Bank" });
    const r = await appRow(id);
    expect([r.accounts_verified_via, r.ab_account_name, r.external_bank_name]).toEqual(["OFFICER", null, "Example Bank"]);
  });
});
