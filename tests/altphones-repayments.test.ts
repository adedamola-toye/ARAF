import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { ALT, appRow, CapturingMail, decideV, setupAltphones, sidOf, submitCreditSale, TestBureau, TestGateway } from "@/server/demo/altphones-scenario";
import { setCreditBureauForTests, setPaymentGatewayForTests } from "@/server/altphones/integrations";
import { setMailTransportForTests } from "@/server/notify/transport";
import { confirmDisbursement } from "@/server/altphones/approvals";
import { positionOf, recordRepayment, reverseRepayment } from "@/server/altphones/repayments";
import { viewableApp } from "@/server/altphones/core";
import { commitImport, previewImport, submitImport } from "@/server/altphones/imports";
import { collections, groupBy, portfolioAccess, portfolioFacilities } from "@/server/altphones/portfolio";
import { facilityPosition } from "@/lib/altphones-repayments";
import { imeiChecksumOk } from "@/lib/altphones";
import { grantRole } from "@/server/domain/admin";
import { hmac } from "@/server/crypto";
import { lagosDate } from "@/server/time";

const IMEI = ["490154203237518", "356938035643809", "353918050210125", "352099001761481"].filter(imeiChecksumOk);
let gw: TestGateway;
let mail: CapturingMail;

beforeEach(async () => {
  await resetDb();
  gw = new TestGateway();
  mail = new CapturingMail();
  setCreditBureauForTests(new TestBureau(700));
  setPaymentGatewayForTests(gw);
  setMailTransportForTests(mail);
  await setupAltphones();
});
afterEach(() => {
  setCreditBureauForTests(undefined);
  setPaymentGatewayForTests(undefined);
  setMailTransportForTests(null);
});

/** A Delight Officer credit sale approved by the PM and Unit Head and handed over. */
async function facility(bvn = "22222222222", imei = IMEI[0]) {
  const id = await submitCreditSale(gw, mail, "DO", bvn);
  await decideV(await ctxFor(ALT.pm), id, { action: "APPROVE", comments: "Checked" });
  await decideV(await ctxFor(ALT.unitHead), id, { action: "APPROVE", comments: "Approved" });
  await confirmDisbursement(await ctxFor(ALT.doOfficer), id, { imei, modelConfirmed: true, locationConfirmed: true, handedOver: true });
  return id;
}
const sched = async (id: string) => (await db.query<{ due: string; amt: string }>("SELECT to_char(due_date,'YYYY-MM-DD') AS due, amount_kobo::text AS amt FROM altphones_schedule WHERE application_id = $1 ORDER BY seq", [id])).rows;
const naira = (kobo: number | string) => (Number(kobo) / 100).toFixed(2);
const today = () => lagosDate(new Date());

describe("facility position (pure)", () => {
  it("allocates repayments oldest first and derives instalment and facility status", () => {
    const s = [1, 2, 3].map((seq) => ({ seq, dueDate: `2026-0${seq}-25`, amountKobo: 1_000_000 }));
    const p = facilityPosition(s, 1_500_000, "2026-03-25");
    expect(p.instalments.map((i) => i.status)).toEqual(["PAID", "OVERDUE", "DUE"]);
    expect(p).toMatchObject({ repaidKobo: 1_500_000, outstandingKobo: 1_500_000, arrearsKobo: 500_000, overdueInstalments: 1, daysOverdue: 28, status: "OVERDUE", dueToDateKobo: 3_000_000 });
    expect(facilityPosition(s, 0, "2026-01-01").status).toBe("NOT_STARTED");
    expect(facilityPosition(s, 3_000_000, "2026-01-01").status).toBe("FULLY_REPAID"); // early settlement
    expect(facilityPosition(s, 1_000_000, "2026-02-01").status).toBe("ACTIVE");
  });
});

describe("repayment lifecycle for ARAF facilities", () => {
  it("records evidenced repayments, refuses bad ones, reverses with a second person, and completes when fully repaid", async () => {
    const id = await facility();
    expect((await appRow(id)).repayment_status).toBe("NOT_STARTED");
    const rows = await sched(id);
    expect(rows).toHaveLength(6);
    const first = rows[0];
    const date = today();
    // Only the PM, Collections and Super Admin record repayments.
    await expect(recordRepayment(await ctxFor(ALT.doOfficer), id, { paidOn: date, amount: naira(first.amt), reference: "FT-001" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const pm = await ctxFor(ALT.pm);
    await recordRepayment(pm, id, { paidOn: date, amount: naira(first.amt), reference: "FT-001", note: "Statement line 1" });
    let pos = await positionOf(db, id, date);
    expect(pos.instalments[0].status).toBe("PAID");
    expect((await appRow(id)).repayment_status).toBe("ACTIVE");
    // Evidence, duplicates, dates and overpayment.
    await expect(recordRepayment(pm, id, { paidOn: date, amount: "100", reference: "ft-001" })).rejects.toMatchObject({ fields: { reference: expect.stringMatching(/already recorded/) } });
    await expect(recordRepayment(pm, id, { paidOn: "2099-01-01", amount: "100", reference: "FT-X" })).rejects.toMatchObject({ fields: { paidOn: expect.stringMatching(/future/) } });
    await expect(recordRepayment(pm, id, { paidOn: "2020-01-01", amount: "100", reference: "FT-Y" })).rejects.toMatchObject({ fields: { paidOn: expect.stringMatching(/before the phone was handed over/) } });
    await expect(recordRepayment(pm, id, { paidOn: date, amount: "100", reference: "" })).rejects.toMatchObject({ fields: { reference: expect.any(String) } });
    await expect(recordRepayment(pm, id, { paidOn: date, amount: naira(pos.outstandingKobo + 100), reference: "FT-BIG" })).rejects.toMatchObject({ fields: { amount: expect.stringMatching(/outstanding balance/) } });
    // Later, with instalments 2 and 3 unpaid, the facility is in arrears.
    const later = facilityPosition(rows.map((r, i) => ({ seq: i + 1, dueDate: r.due, amountKobo: Number(r.amt) })), pos.repaidKobo, rows[2].due.replace(/-\d\d$/, "-28"));
    expect(later).toMatchObject({ status: "OVERDUE", overdueInstalments: 2 });
    // Append-only ledger; reversals by a Unit Head or Super Admin who did not record it, with a reason.
    const rep = (await db.query("SELECT id FROM altphones_repayments WHERE application_id = $1", [id])).rows[0].id;
    await expect(db.query("UPDATE altphones_repayments SET amount_kobo = 1 WHERE id = $1", [rep])).rejects.toThrow(/append-only/);
    await expect(reverseRepayment(pm, rep, "Posted to the wrong facility")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const uh = await ctxFor(ALT.unitHead);
    await expect(reverseRepayment(uh, rep, "short")).rejects.toMatchObject({ code: "VALIDATION" });
    await reverseRepayment(uh, rep, "Posted to the wrong facility by mistake");
    await expect(reverseRepayment(uh, rep, "Posted to the wrong facility by mistake")).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await positionOf(db, id, date)).repaidKobo).toBe(0);
    const admin = await ctxFor(ALT.admin);
    await recordRepayment(admin, id, { paidOn: date, amount: naira(first.amt), reference: "FT-002" });
    const own = (await db.query("SELECT id FROM altphones_repayments WHERE reference = 'FT-002'")).rows[0].id;
    await expect(reverseRepayment(admin, own, "Recorded against the wrong customer")).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Pay off the balance: fully repaid, customer emailed, PM notified; nothing more can be recorded.
    pos = await positionOf(db, id, date);
    await recordRepayment(pm, id, { paidOn: date, amount: naira(pos.outstandingKobo), reference: "FT-003", note: "Early settlement" });
    const a = await appRow(id);
    expect(a.repayment_status).toBe("FULLY_REPAID");
    expect(a.fully_repaid_at).toBeTruthy();
    expect(Number(a.amount_repaid_kobo)).toBe(pos.totalKobo);
    expect((await db.query("SELECT 1 FROM altphones_events WHERE application_id = $1 AND action = 'FULLY_REPAID'", [id])).rowCount).toBe(1);
    expect((await db.query("SELECT 1 FROM notification_outbox WHERE kind = 'ALTPHONES_CUSTOMER_FULLY_REPAID'")).rowCount).toBe(1);
    await expect(recordRepayment(pm, id, { paidOn: date, amount: "1", reference: "FT-004" })).rejects.toMatchObject({ fields: { amount: expect.stringMatching(/already fully repaid/) } });
  });

  it("Collections Officers can open and service facilities; the repayments file accepts ARAF references after Unit Head approval", async () => {
    const id = await facility();
    const ref = (await appRow(id)).ref;
    await grantRole(await ctxFor(ALT.admin), { staffId: await sidOf(ALT.sa), role: "COLLECTIONS_OFFICER" });
    const col = await ctxFor(ALT.sa);
    expect((await viewableApp(col, db, id)).as.has("COLLECTIONS")).toBe(true);
    const [first, second] = await sched(id);
    await recordRepayment(col, id, { paidOn: today(), amount: naira(first.amt), reference: "COL-1" });
    const admin = await ctxFor(ALT.admin);
    const head = "Facility reference,Payment date,Amount,Payment reference,Month covered,Note";
    const bad = await previewImport(admin, "HISTORICAL_REPAYMENTS", "bad.csv", Buffer.from(`${head}\n${ref},${today()},${naira(second.amt)},COL-1,,duplicate\nALP-2026-999999,${today()},100,X-1,,\n${ref},${today()},99999999,BIG-1,,\n`));
    expect(bad.summary).toMatchObject({ valid: 0, errors: 3 });
    const msgs = (await db.query("SELECT errors FROM altphones_imports WHERE id = $1", [bad.id])).rows[0].errors.map((e: { message: string }) => e.message).join(" ");
    expect(msgs).toMatch(/already recorded[\s\S]*not found[\s\S]*outstanding balance/);
    const good = await previewImport(admin, "HISTORICAL_REPAYMENTS", "rep.csv", Buffer.from(`${head}\n${ref},${today()},${naira(second.amt)},STMT-22,,Statement line 22\n`));
    expect(good.summary).toMatchObject({ valid: 1, errors: 0 });
    await submitImport(admin, good.id);
    await commitImport(await ctxFor(ALT.unitHead), good.id);
    const r = (await db.query("SELECT source, recorded_role FROM altphones_repayments WHERE reference = 'STMT-22'")).rows[0];
    expect(r).toEqual({ source: "CSV", recorded_role: "UNIT_HEAD" });
    expect((await positionOf(db, id, today())).instalments.slice(0, 2).map((i) => i.status)).toEqual(["PAID", "PAID"]);
  });
});

describe("duplicate customers and IMEIs", () => {
  async function historicalAccount(bvn: string, imei: string) {
    const staff = await sidOf(ALT.pm);
    const b = (await db.query("INSERT INTO altphones_migration_batches (ref, filename, sha256, as_at, status, prepared_by, prepared_at) VALUES ('MIG-T','t.xlsx','abc','2026-10-31','PUBLISHED',$1,now()) RETURNING id", [staff])).rows[0].id;
    const r = (await db.query("INSERT INTO altphones_migration_records (batch_id, sheet, sheet_kind, row_no, customer_name) VALUES ($1,'INTERNAL','INTERNAL',2,'Synthetic Historical') RETURNING id", [b])).rows[0].id;
    await db.query(
      `INSERT INTO altphones_historical_accounts (ref, batch_id, record_id, source_sheet, source_row, customer_name, bvn_hash, imei, status, units, instalment_kobo, tenor_months, total_obligation_kobo, outstanding_kobo, arrears_kobo, as_at, published_by, published_at)
       VALUES ('HIS-2026-000001',$1,$2,'INTERNAL',2,'Synthetic Historical',$3,$4,'IN_ARREARS',1,1250000,12,15000000,10000000,2500000,'2026-10-31',$5,now())`,
      [b, r, hmac(`bvn:${bvn}`), imei, staff],
    );
  }

  it("warns about the same customer's other facilities (ARAF and historical) without blocking the sale", async () => {
    await historicalAccount("22222222222", IMEI[3]);
    const first = await facility("22222222222", IMEI[0]);
    const second = await submitCreditSale(gw, mail, "DO", "22222222222");
    const w = (await appRow(second)).duplicate_warnings as { source: string; ref: string }[];
    expect(w.map((x) => [x.source, x.ref]).sort()).toEqual([["ARAF", (await appRow(first)).ref], ["HISTORICAL", "HIS-2026-000001"]].sort());
    expect((await appRow(second)).status).toBe("UNDER_PM_REVIEW");
    expect((await db.query("SELECT 1 FROM altphones_events WHERE application_id = $1 AND action = 'DUPLICATE_CUSTOMER_WARNING'", [second])).rowCount).toBe(1);
    const other = await submitCreditSale(gw, mail, "DO", "33333333333");
    expect((await appRow(other)).duplicate_warnings).toBeNull();
  });

  it("refuses to issue an IMEI already sold on a historical facility", async () => {
    await historicalAccount("44444444444", IMEI[1]);
    const id = await submitCreditSale(gw, mail, "DO");
    await decideV(await ctxFor(ALT.pm), id, { action: "APPROVE", comments: "Checked" });
    await decideV(await ctxFor(ALT.unitHead), id, { action: "APPROVE", comments: "Approved" });
    await expect(confirmDisbursement(await ctxFor(ALT.doOfficer), id, { imei: IMEI[1], modelConfirmed: true, locationConfirmed: true, handedOver: true })).rejects.toMatchObject({ fields: { imei: expect.stringMatching(/HIS-2026-000001/) } });
  });
});

describe("portfolio reporting", () => {
  it("combines ARAF facilities and historical accounts; access is limited", async () => {
    const id = await facility();
    const [first] = await sched(id);
    await recordRepayment(await ctxFor(ALT.pm), id, { paidOn: today(), amount: naira(first.amt), reference: "FT-P1" });
    const list = await portfolioFacilities(db, today());
    const f = list.find((x) => x.id === id)!;
    expect(f).toMatchObject({ source: "ARAF", channel: "Delight Officer", bucket: "CURRENT", repaidKobo: Number(first.amt) });
    expect(groupBy(list, (x) => x.channel).find((g) => g.key === "Delight Officer")!.facilities).toBe(1);
    const months = await collections(db, today());
    expect(months).toHaveLength(12);
    expect(months[months.length - 1].collectedKobo).toBe(Number(first.amt));
    expect(await portfolioAccess(db, await sidOf(ALT.pm))).toBe(true);
    expect(await portfolioAccess(db, await sidOf(ALT.unitHead))).toBe(true);
    expect(await portfolioAccess(db, await sidOf(ALT.doOfficer))).toBe(false);
    expect(await portfolioAccess(db, await sidOf("rm.bola@altbank.ng"))).toBe(false);
  });
});
