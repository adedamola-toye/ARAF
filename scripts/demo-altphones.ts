import { loadEnv } from "./load-env";
loadEnv();
import { db, closePool } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedReferenceData } from "../src/server/demo/seed";
import { ctxFor } from "../src/server/demo/scenario";
import { ALT, appRow, CapturingMail, latestPaymentRef, loc, setupAltphones, TestBureau, TestGateway } from "../src/server/demo/altphones-scenario";
import { setCreditBureauForTests, setPaymentGatewayForTests } from "../src/server/altphones/integrations";
import { setMailTransportForTests } from "../src/server/notify/transport";
import {
  acceptContract,
  checkDirectDebit,
  checkPayment,
  completeOutright,
  confirmInternalMandate,
  requestPayment,
  runCreditCheck,
  saveCustomer,
  saveLocations,
  sendContractOtp,
  startDirectDebit,
  startSale,
  submitForApproval,
} from "../src/server/altphones/origination";
import { confirmDisbursement, decide } from "../src/server/altphones/approvals";

/**
 * SYNTHETIC Altphones applications at every stage on the DEVELOPMENT database (never production).
 * Seedfi, Paystack and email are replaced by in-memory doubles inside this script only, so the
 * resulting "payments" and "mandates" are demo data; the running application still has no providers.
 * Markup rates, score bands and contract wording are synthetic placeholders.
 */
async function main() {
  if (process.env.APP_ENV === "production") throw new Error("Refusing to run in production.");
  await migrate(process.env.DATABASE_URL!);
  await seedReferenceData(db);
  const gw = new TestGateway();
  const mail = new CapturingMail();
  setCreditBureauForTests(new TestBureau(700));
  setPaymentGatewayForTests(gw);
  setMailTransportForTests(mail);
  const have = (await db.query<{ id: string }>("SELECT id FROM altphones_models WHERE active ORDER BY sort_order")).rows.map((r) => r.id);
  const models = have.length ? have : (await setupAltphones({ stock: 12 })).models;
  const out: [string, string][] = [];
  const log = async (label: string, id: string) => {
    const r = await appRow(id);
    out.push([label, `${r.ref} ${r.status} /altphones/applications/${id}`]);
  };
  const CUST = (n: number) => ({ name: `Synthetic Customer ${n}`, email: `customer${n}@example.com`, phone: "0803 123 4567" });
  const CREDIT = (n: number) => ({ ...CUST(n), abAccount: "0123456789", externalAccount: "9876543210", externalBank: "Synthetic Bank", tenure: n % 3 === 0 ? "12" : n % 2 ? "6" : "3", repaymentDay: "25", accountsConfirmed: true });

  async function outright(email: string, n: number, stop: "draft" | "awaiting" | "paid" | "done") {
    const sa = email === ALT.sa;
    const ctx = await ctxFor(email);
    const { id } = await startSale(ctx, { kind: "OUTRIGHT", modelId: models[0] });
    if (stop === "draft") return id;
    await saveLocations(ctx, id, { modelId: models[0], originId: await loc(sa ? "Yaba Altbox" : "Ikeja Branch"), supplyId: await loc(sa ? "Yaba Altshop" : "Ikeja Branch") });
    await saveCustomer(ctx, id, CUST(n));
    await requestPayment(ctx, id, {});
    if (stop === "awaiting") return id;
    gw.pay(await latestPaymentRef(id));
    await checkPayment(ctx, id);
    if (stop === "paid") return id;
    await completeOutright(ctx, id, { imei: imei(n), handedOver: true });
    return id;
  }
  async function credit(email: string, n: number, stop: "credit" | "customer" | "mandates" | "ready" | "submitted") {
    const sa = email === ALT.sa;
    const ctx = await ctxFor(email);
    const { id } = await startSale(ctx, { kind: "CREDIT", modelId: models[0] });
    if (stop === "credit") return id;
    await runCreditCheck(ctx, id, { bvn: "22222222222", consent: true });
    await saveLocations(ctx, id, { modelId: models[0], originId: await loc(sa ? "Yaba Altbox" : "Ikeja Branch"), supplyId: await loc(sa ? "Yaba Altshop" : "Ikeja Branch") });
    if (stop === "customer") return id;
    await saveCustomer(ctx, id, CREDIT(n));
    await requestPayment(ctx, id, {});
    gw.pay(await latestPaymentRef(id));
    await checkPayment(ctx, id);
    if (stop === "mandates") return id;
    await startDirectDebit(ctx, id);
    gw.authorize((await appRow(id)).dd_reference);
    await checkDirectDebit(ctx, id);
    await confirmInternalMandate(ctx, id, { confirmed: true });
    await sendContractOtp(ctx, id, {});
    await acceptContract(ctx, id, { code: mail.lastCode()! });
    if (stop === "ready") return id;
    await submitForApproval(ctx, id, {});
    return id;
  }
  let n = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM altphones_applications")).rows[0].n) + 1;
  await log("DO outright — draft", await outright(ALT.doOfficer, n++, "draft"));
  await log("DO outright — awaiting payment", await outright(ALT.doOfficer, n++, "awaiting"));
  await log("SA outright — paid, ready for handover", await outright(ALT.sa, n++, "paid"));
  await log("DO outright — completed", await outright(ALT.doOfficer, n++, "done"));
  await log("DO credit — BVN step", await credit(ALT.doOfficer, n++, "credit"));
  await log("DO credit — mandates step", await credit(ALT.doOfficer, n++, "mandates"));
  await log("SA credit — ready to submit", await credit(ALT.sa, n++, "ready"));
  await log("SA credit — with BPM", await credit(ALT.sa, n++, "submitted"));
  const pmQ = await credit(ALT.doOfficer, n++, "submitted");
  await log("DO credit — with Product Manager", pmQ);
  const uhQ = await credit(ALT.doOfficer, n++, "submitted");
  await decide(await ctxFor(ALT.pm), uhQ, { action: "APPROVE", comments: "Checked", reviewed: true });
  await log("DO credit — with Unit Head", uhQ);
  const appr = await credit(ALT.sa, n++, "submitted");
  await decide(await ctxFor(ALT.bpm), appr, { action: "APPROVE", comments: "", reviewed: true });
  await decide(await ctxFor(ALT.pm), appr, { action: "APPROVE", comments: "", reviewed: true });
  await decide(await ctxFor(ALT.unitHead), appr, { action: "APPROVE", comments: "", reviewed: true });
  await log("SA credit — approved, ready for disbursement", appr);
  const disb = await credit(ALT.doOfficer, n++, "submitted");
  await decide(await ctxFor(ALT.pm), disb, { action: "APPROVE", comments: "", reviewed: true });
  await decide(await ctxFor(ALT.unitHead), disb, { action: "APPROVE", comments: "", reviewed: true });
  await confirmDisbursement(await ctxFor(ALT.doOfficer), disb, { imei: imei(n++), modelConfirmed: true, locationConfirmed: true, handedOver: true });
  await log("DO credit — disbursed", disb);
  setCreditBureauForTests(new TestBureau(300));
  const declined = await credit(ALT.doOfficer, n++, "credit");
  await runCreditCheck(await ctxFor(ALT.doOfficer), declined, { bvn: "33333333333", consent: true });
  await log("DO credit — declined by Seedfi", declined);
  for (const [k, v] of out) console.log(`${k.padEnd(48)} ${v}`);
}

/** A synthetic 15-digit IMEI with a valid check digit. */
function imei(n: number) {
  const base = `35${String(900000000000 + n * 7919).slice(0, 12)}`;
  for (let c = 0; c < 10; c++) {
    const s = base + c;
    let sum = 0;
    for (let i = 0; i < 15; i++) {
      let d = Number(s[14 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return s;
  }
  throw new Error("unreachable");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
