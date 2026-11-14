import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { ALT, CapturingMail, loc, setupAltphones } from "@/server/demo/altphones-scenario";
import { setMailTransportForTests } from "@/server/notify/transport";
import { readRegister, parseDate, parseMoney, parseTenor, parseImei, parseAccount, parsePhone } from "@/server/altphones/register";
import { classify, decideBatch, decideMatching, decideRecord, discardBatch, listRecords, mapLocations, mapReferrers, reconciliation, setAsAt, stageRegister, submitBatch } from "@/server/altphones/migration";
import { decryptField } from "@/server/crypto";

// A synthetic register in the shape of the team's workbook. Every person, number and IMEI here is made up.
const HEAD = ["CUSTOMER'S NAME", "ACCOUNT NUMBER", "MOBILE NUMBER", "BVN", "NIN", "RESIDENTIAL ADDRESS", "No. OF ALTPHONE", "DOWNPAYMENT AMOUNT", "DOWNPAYMENT DATE", "REPAYMENT AMOUNT", "REPAYMENT START DATE", "REPAYMENT END DATE", "TENOR", "IMEI2 NUMBER", "REFERRED BY:", "LOCATION"];
const MONTHS = ["OCT. 2025", "NOV. 2025", "DEC. 2025", "JAN. 2026", "FEB. 2026", "MAR. 2026", "APR. 2026", "MAY. 2026", "JUN. 2026", "JUL. 2026", "AUG. 2026", "SEPT. 2026", "OCT. 2026"];
const bvn = (n: number) => `222000000${String(n).padStart(2, "0")}`;
/** A synthetic IMEI with a correct check digit. */
const imei = (n: number) => {
  const body = `3500000000${String(n).padStart(4, "0")}`;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(body[13 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body + String((10 - (sum % 10)) % 10);
};
const excelDate = (serial: number) => new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
type Row = (string | number | Date | null)[];
const person = (n: number, o: Partial<Record<"units" | "down" | "inst" | "start" | "tenor" | "imei" | "ref" | "loc" | "bvn" | "nin", unknown>> = {}): Row => [
  `Test Customer ${n}`,
  123456780 + n, // stored as a number in Excel: the leading 0 is lost
  8030000000 + n,
  (o.bvn as string) ?? bvn(n),
  (o.nin as string) ?? `9990000000${n % 10}`,
  `${n} Example Street`,
  (o.units as number | string) ?? 1,
  (o.down as number) ?? 29000,
  "11th november 2025",
  (o.inst as number | Date) ?? 12500,
  (o.start as string) ?? "15th june 2026",
  "15th may 2027",
  (o.tenor as string | number | Date) ?? "12 months",
  (o.imei as string | number) ?? imei(n),
  (o.ref as string) ?? "",
  (o.loc as string) ?? "IKEJA BRANCH",
];
const marks = (from: string, seq: string): Row => MONTHS.map((m, i) => {
  const k = MONTHS.indexOf(from);
  const c = i >= k ? seq[i - k] : undefined;
  return c === "Y" ? "yes" : c === "N" ? "no" : null;
});

async function workbook(extra?: (wb: ExcelJS.Workbook) => void) {
  const wb = new ExcelJS.Workbook();
  const internal = wb.addWorksheet("INTERNAL");
  internal.addRow([...HEAD, ...MONTHS]);
  internal.addRow([...person(1), ...marks("JUN. 2026", "YYYYY")]); // 2: current
  internal.addRow([...person(2, { inst: excelDate(23000), tenor: 6, start: "12th Febuary 2026" }), ...marks("MAY. 2026", "YYNN")]); // 3: arrears, amount repaired, misspelt month
  internal.addRow([...person(3, { inst: 43000, tenor: "3months" }), ...marks("AUG. 2026", "YYY")]); // 4: completed by its marks
  internal.addRow([...person(4, { start: "1st march 2026" }), ...marks("OCT. 2025", "")]); // 5: no evidence
  internal.addRow([...person(5, { start: "1st december 2026", imei: "490154203237519" }), ...marks("OCT. 2025", "")]); // 6: not started; IMEI mistyped (check digit)
  internal.addRow([...person(6, { units: "12 Example Street, Ikeja", inst: "9th january 2026" }), ...marks("OCT. 2025", "")]); // 7: shifted columns
  internal.addRow([...person(7, { imei: imei(99) }), ...marks("SEPT. 2026", "Y")]); // 8: IMEI duplicated on EXTERNAL
  const external = wb.addWorksheet("EXTERNAL");
  external.addRow([...HEAD, ...MONTHS]);
  external.addRow([...person(8, { imei: `L1 ${imei(99)}`, loc: "MARARABA", ref: "Ade Okafor" }), ...marks("SEPT. 2026", "Y")]); // 2: same IMEI as INTERNAL row 8
  external.addRow([...person(9, { bvn: bvn(50) }), ...marks("JUN. 2026", "YYYY")]); // 3: same customer as the COMPLETED sheet
  external.addRow([...person(10, { ref: "SOMEONE UNKNOWN", imei: "3500000001" }), ...marks("JUN. 2026", "YYYYY")]); // 4: a month after a September as-at; short IMEI
  const completed = wb.addWorksheet("COMPLETED REPAYMENT");
  completed.addRow(["S/N", ...HEAD]);
  completed.addRow([1, ...person(11, { bvn: bvn(50), tenor: excelDate(6), inst: 23000 })]); // 2
  const cancelled = wb.addWorksheet("CANCELED REQUEST");
  cancelled.addRow(["S/N", ...HEAD, "oct", "nov", "dec"]);
  cancelled.addRow([1, ...person(12), null, "yes", "no"]);
  wb.addWorksheet("NOTES").addRow(["Team notes", "not data"]);
  extra?.(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

beforeEach(async () => {
  await resetDb();
  setMailTransportForTests(new CapturingMail());
  await setupAltphones({ stock: 0 });
});
afterEach(() => setMailTransportForTests(null));

const rec = async (sheet: string, row: number) => (await db.query("SELECT * FROM altphones_migration_records WHERE sheet = $1 AND row_no = $2", [sheet, row])).rows[0];
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

describe("reading the register", () => {
  it("parses the value formats found in the team's workbook", () => {
    expect(parseDate("11th november 2025")).toBe("2025-11-11");
    expect(parseDate("1st  April, 2026")).toBe("2026-04-01");
    expect(parseDate("12th Febuary 2026")).toBe("2026-02-12");
    expect(parseDate("4th Novermber2025")).toBe("2025-11-04");
    expect(parseDate("12h may, 2026")).toBe("2026-05-12");
    expect(parseDate("15/06/2026")).toBe("2026-06-15");
    expect(parseDate("10th november")).toBeNull(); // no year: flagged, never guessed
    expect(parseDate("31st february 2026")).toBeNull();
    expect(parseMoney(excelDate(12500))).toMatchObject({ kobo: 1250000, repaired: true });
    expect(parseMoney("29,000(PAID BY A RELATIVE)")).toMatchObject({ kobo: 2900000, repaired: false });
    expect(parseMoney("21'750")).toMatchObject({ kobo: 2175000 });
    expect(parseMoney("9th january 2026")).toMatchObject({ kobo: null, looksLikeDate: true });
    expect(parseTenor(excelDate(6))).toEqual({ months: 6, repaired: true });
    expect(parseTenor("12 months").months).toBe(12);
    expect(parseTenor("6months").months).toBe(6);
    expect(parseImei(`L1 ${imei(1)}`)).toEqual({ value: imei(1), state: "OK", problem: null });
    expect(parseImei("nil").state).toBe("MISSING");
    expect(parseImei("3500000000001").state).toBe("INVALID");
    expect(parseAccount(123456789)).toEqual({ value: "0123456789", ok: true });
    expect(parsePhone(8031234567)).toEqual({ value: "08031234567", ok: true });
  });

  it("reads every recognised sheet, month columns included, and reports the rest", async () => {
    const { sheets, rows } = await readRegister(await workbook());
    expect(sheets.map((s) => [s.name, s.kind, s.rows])).toEqual([
      ["INTERNAL", "INTERNAL", 7],
      ["EXTERNAL", "EXTERNAL", 3],
      ["COMPLETED REPAYMENT", "COMPLETED", 1],
      ["CANCELED REQUEST", "CANCELLED", 1],
      ["NOTES", null, 0],
    ]);
    expect(sheets[0].monthColumns).toHaveLength(13);
    expect(sheets[3].monthColumns).toEqual(["2025-10", "2025-11", "2025-12"]); // "oct, nov, dec" continue from 2025
    const arrears = rows.find((r) => r.sheet === "INTERNAL" && r.row === 3)!;
    expect(arrears).toMatchObject({ instalmentKobo: 2300000, tenor: 6, startDate: "2026-02-12", account: "0123456782", phone: "08030000002" });
    expect(arrears.issues.map((i) => i.code)).toContain("AMOUNT_REPAIRED");
    expect(rows.find((r) => r.sheet === "INTERNAL" && r.row === 7)!.issues.map((i) => i.code)).toContain("SHIFTED_COLUMNS");
    expect(rows.find((r) => r.sheet === "COMPLETED REPAYMENT")!).toMatchObject({ tenor: 6, months: [] });
  });

  it("classifies from the evidence: yes = paid, no = missed, up to the as-at date", () => {
    const base = { sheet_kind: "EXTERNAL" as const, tenor_months: 6, instalment_kobo: 2300000, start_date: "2026-05-01" };
    const m = (s: string) => [...s].map((c, i) => ({ m: `2026-${String(5 + i).padStart(2, "0")}`, s: c as "Y" | "N" }));
    expect(classify({ ...base, months: m("YYYY") }, "2026-10-31")).toMatchObject({ computed: "CURRENT", paid: 4, missed: 0, outstanding: 4600000, arrears: 0 });
    expect(classify({ ...base, months: m("YYNN") }, "2026-10-31")).toMatchObject({ computed: "IN_ARREARS", missed: 2, arrears: 4600000, outstanding: 9200000 });
    expect(classify({ ...base, months: m("YNYYYY") }, "2026-10-31")).toMatchObject({ computed: "IN_ARREARS", paid: 5 }); // a missed month stays missed
    expect(classify({ ...base, months: m("YYYYYY") }, "2026-10-31")).toMatchObject({ computed: "COMPLETED", outstanding: 0 });
    expect(classify({ ...base, months: m("YYYYYN") }, "2026-08-31")).toMatchObject({ computed: "CURRENT", paid: 4, monthsAfterAsAt: 2 });
    expect(classify({ ...base, months: [] }, "2026-10-31").computed).toBe("NEEDS_REVIEW"); // never assumed complete
    expect(classify({ ...base, months: [], start_date: "2026-12-01" }, "2026-10-31").computed).toBe("NOT_STARTED");
    expect(classify({ ...base, sheet_kind: "COMPLETED", months: [] }, "2026-10-31")).toMatchObject({ computed: "COMPLETED", paid: 6, outstanding: 0 });
    expect(classify({ ...base, sheet_kind: "CANCELLED", months: m("YN") }, "2026-10-31")).toMatchObject({ computed: "CANCELLED", outstanding: 0, arrears: 0 });
  });
});

describe("staging a batch", () => {
  it("stages every row encrypted, classifies, flags issues and reconciles — and publishes nothing", async () => {
    const pm = await ctxFor(ALT.pm);
    await expect(stageRegister(await ctxFor(ALT.doOfficer), { filename: "register.xlsx", data: await workbook(), asAt: "2026-10-31" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(stageRegister(pm, { filename: "register.xlsx", data: await workbook(), asAt: "2099-01-01" })).rejects.toMatchObject({ code: "VALIDATION" });
    const data = await workbook();
    const b = await stageRegister(pm, { filename: "register.xlsx", data, asAt: "2026-10-31" });
    expect(b.rows).toBe(12);

    expect((await rec("INTERNAL", 2)).classification).toBe("CURRENT");
    expect(await rec("INTERNAL", 3)).toMatchObject({ classification: "IN_ARREARS", missed_count: 2, arrears_kobo: "4600000" });
    expect((await rec("INTERNAL", 4)).classification).toBe("COMPLETED");
    expect(codes(await rec("INTERNAL", 5))).toContain("NO_EVIDENCE");
    expect((await rec("INTERNAL", 6)).classification).toBe("NOT_STARTED");
    expect(codes(await rec("INTERNAL", 7))).toContain("SHIFTED_COLUMNS");
    expect(codes(await rec("INTERNAL", 8))).toContain("DUPLICATE_IMEI");
    expect(codes(await rec("EXTERNAL", 2))).toEqual(expect.arrayContaining(["DUPLICATE_IMEI", "LOCATION_UNMAPPED"]));
    expect(codes(await rec("EXTERNAL", 3))).toContain("CUSTOMER_IN_OTHER_SHEET");
    expect(codes(await rec("COMPLETED REPAYMENT", 2))).toContain("CUSTOMER_IN_OTHER_SHEET");
    expect((await rec("COMPLETED REPAYMENT", 2)).classification).toBe("COMPLETED");
    expect((await rec("CANCELED REQUEST", 2)).classification).toBe("CANCELLED");
    // "Referred by" names that match a staff member are linked automatically; unknown names are flagged.
    expect((await rec("EXTERNAL", 2)).officer_id).toBeTruthy();
    expect(codes(await rec("EXTERNAL", 4))).toContain("REFERRER_UNMAPPED");
    expect((await rec("INTERNAL", 2)).location_id).toBe(await loc("Ikeja Branch"));

    // Personal data is encrypted at rest; only the last four digits are readable.
    const r = await rec("INTERNAL", 2);
    expect(r.bvn_enc).not.toContain(bvn(1));
    expect(decryptField(r.bvn_enc)).toBe(bvn(1));
    expect(r.account_last4).toBe("6781");

    const s = await reconciliation(db, b.id);
    expect(s.sheets.filter((x) => x.kind).every((x) => x.read === x.staged)).toBe(true);
    expect(s.sheets.find((x) => x.name === "NOTES")?.note).toMatch(/not recognised/);
    expect(s).toMatchObject({ records: 12, included: 12, excluded: 0, blockedOpen: 6 });
    // Nothing is published while staged.
    expect((await db.query("SELECT count(*)::int AS n FROM altphones_historical_accounts")).rows[0].n).toBe(0);
    // The same file cannot be uploaded twice, and only one batch can be open.
    await expect(stageRegister(pm, { filename: "again.xlsx", data, asAt: "2026-10-31" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(stageRegister(pm, { filename: "other.xlsx", data: await workbook((wb) => wb.addWorksheet("X")), asAt: "2026-10-31" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("re-evaluates when the as-at date changes", async () => {
    const pm = await ctxFor(ALT.pm);
    const b = await stageRegister(pm, { filename: "register.xlsx", data: await workbook(), asAt: "2026-10-31" });
    expect((await rec("INTERNAL", 3)).classification).toBe("IN_ARREARS");
    await setAsAt(pm, b.id, "2026-06-30"); // before the two missed months
    expect(await rec("INTERNAL", 3)).toMatchObject({ classification: "CURRENT", missed_count: 0 });
    expect(codes(await rec("INTERNAL", 3))).toContain("MONTHS_AFTER_AS_AT");
  });
});

describe("resolving, submitting and approving", () => {
  async function resolveAll(batchId: string) {
    const pm = await ctxFor(ALT.pm);
    const id = async (sheet: string, row: number) => (await rec(sheet, row)).id as string;
    await decideRecord(pm, await id("INTERNAL", 5), { decision: "INCLUDE", classification: "CURRENT", note: "Team ledger shows payments up to date" });
    await decideRecord(pm, await id("INTERNAL", 7), { decision: "EXCLUDE", note: "Row damaged; re-enter after checking the file" });
    await decideRecord(pm, await id("INTERNAL", 8), { decision: "EXCLUDE", note: "Same phone as EXTERNAL row 2; that row is correct" });
    await decideRecord(pm, await id("EXTERNAL", 3), { decision: "INCLUDE", note: "Second phone bought after the first was repaid" });
    await decideRecord(pm, await id("COMPLETED REPAYMENT", 2), { decision: "INCLUDE", note: "First phone, fully repaid" });
    return batchId;
  }

  it("refuses to submit while records are blocked, and decisions need reasons", async () => {
    const pm = await ctxFor(ALT.pm);
    const b = await stageRegister(pm, { filename: "register.xlsx", data: await workbook(), asAt: "2026-10-31" });
    await expect(submitBatch(pm, b.id)).rejects.toMatchObject({ code: "VALIDATION" });
    const noEvidence = (await rec("INTERNAL", 5)).id;
    await expect(decideRecord(pm, noEvidence, { decision: "INCLUDE", note: "looks fine" })).rejects.toMatchObject({ code: "VALIDATION" }); // a status is required
    await expect(decideRecord(pm, noEvidence, { decision: "EXCLUDE" })).rejects.toMatchObject({ code: "VALIDATION" }); // a reason is required
    // Excluding one of the duplicate IMEIs clears the duplicate on the other.
    await decideRecord(pm, (await rec("INTERNAL", 8)).id, { decision: "EXCLUDE", note: "Duplicate of EXTERNAL row 2" });
    expect(codes(await rec("EXTERNAL", 2))).not.toContain("DUPLICATE_IMEI");
    // Location labels are linked once and remembered.
    await mapLocations(pm, b.id, [{ label: "MARARABA", locationId: await loc("Yaba Altshop") }]);
    expect((await rec("EXTERNAL", 2)).location_id).toBe(await loc("Yaba Altshop"));
    expect((await db.query("SELECT location_id FROM altphones_location_aliases WHERE label = 'MARARABA'")).rows[0].location_id).toBe(await loc("Yaba Altshop"));
    await mapReferrers(pm, b.id, [{ label: "SOMEONE UNKNOWN", staffId: (await db.query("SELECT id FROM staff WHERE email = $1", [ALT.doOfficer])).rows[0].id }]);
    expect((await rec("EXTERNAL", 4)).officer_id).toBeTruthy();
  });

  it("PM prepares, a Unit Head approves; publishing creates verified accounts without moving stock", async () => {
    const pm = await ctxFor(ALT.pm);
    const uh = await ctxFor(ALT.unitHead);
    const b = await stageRegister(pm, { filename: "register.xlsx", data: await workbook(), asAt: "2026-10-31" });
    await resolveAll(b.id);
    await expect(decideBatch(uh, b.id, { decision: "APPROVE" })).rejects.toMatchObject({ code: "CONFLICT" }); // not submitted yet
    await submitBatch(pm, b.id);
    expect((await db.query("SELECT to_addresses FROM notification_outbox WHERE kind = 'ALTPHONES_MIGRATION_SUBMITTED'")).rows[0].to_addresses).toContain(ALT.unitHead);
    await expect(decideRecord(pm, (await rec("INTERNAL", 2)).id, { decision: "EXCLUDE", note: "changed my mind" })).rejects.toMatchObject({ code: "CONFLICT" }); // locked once submitted
    await expect(decideBatch(pm, b.id, { decision: "APPROVE" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideBatch(await ctxFor(ALT.admin), b.id, { decision: "APPROVE" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Return needs a reason and sends it back to the preparer.
    await expect(decideBatch(uh, b.id, { decision: "RETURN" })).rejects.toMatchObject({ code: "VALIDATION" });
    await decideBatch(uh, b.id, { decision: "RETURN", comment: "Confirm the cancelled request was refunded" });
    expect((await db.query("SELECT status, returned_note FROM altphones_migration_batches WHERE id = $1", [b.id])).rows[0]).toEqual({ status: "DRAFT", returned_note: "Confirm the cancelled request was refunded" });
    await submitBatch(pm, b.id, "Refund confirmed by finance");

    const ledgerBefore = (await db.query("SELECT count(*)::int AS n FROM altphones_stock_ledger")).rows[0].n;
    const r = await decideBatch(uh, b.id, { decision: "APPROVE", comment: "Reconciled against the team register" });
    expect(r.published).toBe(10); // 12 rows − 2 excluded
    expect((await db.query("SELECT count(*)::int AS n FROM altphones_stock_ledger")).rows[0].n).toBe(ledgerBefore);

    const acc = async (sheet: string, row: number) => (await db.query("SELECT * FROM altphones_historical_accounts WHERE source_sheet = $1 AND source_row = $2", [sheet, row])).rows[0];
    expect(await acc("INTERNAL", 3)).toMatchObject({ status: "IN_ARREARS", missed_count: 2, arrears_kobo: "4600000", verification: "VERIFIED" });
    expect((await acc("INTERNAL", 3)).nin_enc).toBeTruthy(); // not complete: NIN kept
    expect((await acc("INTERNAL", 4)).nin_enc).toBeNull(); // complete: NIN left out
    expect((await acc("COMPLETED REPAYMENT", 2)).nin_enc).toBeNull();
    expect((await acc("INTERNAL", 5)).status).toBe("CURRENT"); // the preparer's decision from the team's records
    expect((await acc("INTERNAL", 5)).decision_note).toMatch(/Team ledger/);
    expect(await acc("INTERNAL", 7)).toBeUndefined(); // excluded
    expect((await db.query("SELECT i.status FROM altphones_historical_instalments i JOIN altphones_historical_accounts a ON a.id = i.account_id WHERE a.source_sheet = 'INTERNAL' AND a.source_row = 3 ORDER BY month")).rows.map((x) => x.status)).toEqual(["PAID", "PAID", "MISSED", "MISSED"]);
    expect((await db.query("SELECT status, legacy, location_id FROM altphones_devices WHERE imei = $1", [imei(1)])).rows[0]).toEqual({ status: "ISSUED", legacy: true, location_id: null });
    // Staging copies of personal data are cleared once published.
    expect((await db.query("SELECT count(*)::int AS n FROM altphones_migration_records WHERE bvn_enc IS NOT NULL OR nin_enc IS NOT NULL OR address_enc IS NOT NULL")).rows[0].n).toBe(0);
    expect((await db.query("SELECT status FROM altphones_migration_batches WHERE id = $1", [b.id])).rows[0].status).toBe("PUBLISHED");
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'ALTPHONES_MIGRATION_PUBLISHED'")).rows[0].n).toBe(1);

    // A later register: the same phones and customers are caught.
    const later = await stageRegister(pm, { filename: "later.xlsx", data: await workbook((wb) => wb.addWorksheet("EXTRA")), asAt: "2026-10-31" });
    expect(codes(await (async () => (await db.query("SELECT issues FROM altphones_migration_records WHERE batch_id = $1 AND sheet = 'INTERNAL' AND row_no = 2", [later.id])).rows[0])())).toEqual(expect.arrayContaining(["IMEI_ALREADY_REGISTERED", "ALREADY_MIGRATED_CUSTOMER"]));
    await discardBatch(pm, later.id, "Duplicate of the published register");
    expect((await db.query("SELECT status FROM altphones_migration_batches WHERE id = $1", [later.id])).rows[0].status).toBe("DISCARDED");
  });

  it("decides every undecided record matching a filter in one step", async () => {
    const pm = await ctxFor(ALT.pm);
    const b = await stageRegister(pm, { filename: "register.xlsx", data: await workbook(), asAt: "2026-10-31" });
    await expect(decideMatching(pm, b.id, { issue: "NO_EVIDENCE" }, { decision: "INCLUDE", note: "Confirmed with the team" })).rejects.toMatchObject({ code: "VALIDATION" }); // a status is needed
    await expect(decideMatching(pm, b.id, { issue: "NO_EVIDENCE" }, { decision: "INCLUDE", classification: "CURRENT", note: "" })).rejects.toMatchObject({ code: "VALIDATION" }); // and a reason
    const r = await decideMatching(pm, b.id, { issue: "NO_EVIDENCE" }, { decision: "INCLUDE", classification: "CURRENT", note: "Confirmed with the team's collection records" });
    expect(r).toMatchObject({ decided: 2, blocked: 4 }); // INTERNAL rows 5 and 7 have no marks
    expect(await rec("INTERNAL", 5)).toMatchObject({ decision: "INCLUDE", override_classification: "CURRENT" });
    await expect(decideMatching(pm, b.id, { issue: "NO_EVIDENCE" }, { decision: "EXCLUDE", note: "Second pass" })).rejects.toMatchObject({ code: "VALIDATION" }); // already decided: nothing left
    await expect(decideMatching(await ctxFor(ALT.unitHead), b.id, { sheet: "INTERNAL" }, { decision: "EXCLUDE", note: "Not mine to do" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lists and filters records for review", async () => {
    const pm = await ctxFor(ALT.pm);
    const b = await stageRegister(pm, { filename: "register.xlsx", data: await workbook(), asAt: "2026-10-31" });
    expect((await listRecords(db, b.id, { issue: "blocked" })).total).toBe(6);
    expect((await listRecords(db, b.id, { status: "IN_ARREARS" })).total).toBe(1);
    expect((await listRecords(db, b.id, { sheet: "EXTERNAL" })).total).toBe(3);
    expect((await listRecords(db, b.id, { q: "Test Customer 1" })).rows.map((r) => r.customer_name)).toContain("Test Customer 1");
    expect((await listRecords(db, b.id, { q: imei(1) })).total).toBe(1);
  });
});

describe("IMEI format", () => {
  it("explains what is wrong with an IMEI", async () => {
    const { imeiProblem } = await import("@/lib/altphones");
    const valid = "490154203237518";
    expect(imeiProblem(valid)).toBeNull();
    expect(imeiProblem("49015420 323751-8")).toBeNull(); // spaces and dashes are ignored
    expect(imeiProblem("")).toMatch(/No IMEI/);
    expect(imeiProblem("49015420323751")).toMatch(/14 digits: the last \(check\) digit is missing/);
    expect(imeiProblem("4901542032375180")).toMatch(/16 digits/);
    expect(imeiProblem("4901542032")).toMatch(/10 digits; it must have 15/);
    expect(imeiProblem("49015420323751A")).toMatch(/digits only/);
    expect(imeiProblem("000000000000000")).toMatch(/placeholder/);
    expect(imeiProblem("111111111111111")).toMatch(/placeholder/);
    expect(imeiProblem("490154203237519")).toMatch(/check digit does not match/); // last digit mistyped
    expect(imeiProblem("490154203273518")).toMatch(/check digit does not match/); // two digits swapped
  });

  it("flags wrong IMEIs in the register with the reason", async () => {
    const { rows } = await readRegister(await workbook());
    expect(rows.find((x) => x.sheet === "INTERNAL" && x.row === 2)!.issues.map((i) => i.code)).not.toContain("IMEI_INVALID");
    const r = rows.find((x) => x.sheet === "INTERNAL" && x.row === 6)!;
    expect(r.issues.find((i) => i.code === "IMEI_INVALID")?.message).toMatch(/490154203237519: .*check digit does not match/);
    expect(rows.find((x) => x.sheet === "EXTERNAL" && x.row === 4)!.issues.find((i) => i.code === "IMEI_INVALID")?.message).toMatch(/10 digits/);
  });
});
