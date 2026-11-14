/**
 * Reads the Altphones historical sales register (an Excel workbook with INTERNAL, EXTERNAL, COMPLETED REPAYMENT and
 * CANCELED REQUEST sheets) into normalised rows. Pure: no database access, nothing is guessed silently — anything
 * repaired or unreadable is reported as an issue on the row.
 */
import ExcelJS from "exceljs";
import { imeiProblem } from "@/lib/altphones";

export type SheetKind = "INTERNAL" | "EXTERNAL" | "COMPLETED" | "CANCELLED";
export type IssueLevel = "BLOCK" | "WARN";
export interface Issue {
  code: string;
  level: IssueLevel;
  message: string;
}
export interface RegisterRow {
  sheet: string;
  kind: SheetKind;
  row: number;
  name: string;
  account: string | null;
  phone: string | null;
  bvn: string | null;
  nin: string | null;
  address: string | null;
  units: number | null;
  downPaymentKobo: number | null;
  downPaymentDate: string | null;
  instalmentKobo: number | null;
  startDate: string | null;
  endDate: string | null;
  tenor: number | null;
  imei: string | null;
  location: string | null;
  referrer: string | null;
  months: { m: string; s: "Y" | "N" }[];
  issues: Issue[];
}
export interface RegisterSheet {
  name: string;
  kind: SheetKind | null;
  rows: number;
  monthColumns: string[];
  note?: string;
}

type Raw = string | number | Date | null;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const MONTHS: Record<string, number> = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };

const norm = (h: unknown) =>
  String(h ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const text = (v: Raw) => (v === null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).replace(/\s+/g, " ").trim());
const isNil = (s: string) => /^(nil|nill|none|na|n\/a|-+|\.)$/i.test(s.trim());
const serial = (d: Date) => Math.round((d.getTime() - EXCEL_EPOCH) / 86400000);
const iso = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
};

function cellValue(v: unknown): Raw {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return cellValue(o.result);
    if ("richText" in o) return (o.richText as { text: string }[]).map((x) => x.text).join("");
    if ("text" in o) return String(o.text ?? "");
    if ("error" in o) return null;
  }
  return String(v);
}

/** A sheet's kind from its name. */
export function sheetKind(name: string): SheetKind | null {
  const n = name.toLowerCase();
  if (/cancel/.test(n)) return "CANCELLED";
  if (/complet/.test(n)) return "COMPLETED";
  if (/intern/.test(n)) return "INTERNAL";
  if (/extern/.test(n)) return "EXTERNAL";
  return null;
}

const monthOf = (word: string) => MONTHS[word] ?? MONTHS[word.slice(0, 3)] ?? null;

/** Date written as a date cell, "11th November 2025", "1st  April, 2026" or 11/11/2025 (day first). */
export function parseDate(v: Raw): string | null {
  if (v === null) return null;
  if (v instanceof Date) return v.getUTCFullYear() >= 2015 ? v.toISOString().slice(0, 10) : null;
  if (typeof v === "number") return v > 40000 && v < 60000 ? new Date(EXCEL_EPOCH + v * 86400000).toISOString().slice(0, 10) : null;
  const s = v.toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
  // Day and month name, with ordinal typos ("12h") and misspelt months ("Febuary", "Novermber") read by their first three letters.
  let m = s.match(/^(\d{1,2})\s*[a-z]{0,2}\s+(?:of\s+)?([a-z]{3,})\.?\s*(\d{4})$/);
  if (m && monthOf(m[2])) return iso(Number(m[3]), monthOf(m[2])!, Number(m[1]));
  m = s.match(/^([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})$/);
  if (m && monthOf(m[1])) return iso(Number(m[3]), monthOf(m[1])!, Number(m[2]));
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return iso(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]), Number(m[1]));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

/** Naira amount → kobo. Amounts Excel turned into dates are converted back (e.g. 1934-03-22 → 12,500) and flagged. */
export function parseMoney(v: Raw): { kobo: number | null; repaired: boolean; looksLikeDate: boolean } {
  if (v === null) return { kobo: null, repaired: false, looksLikeDate: false };
  if (v instanceof Date) {
    const n = serial(v);
    return n > 0 ? { kobo: n * 100, repaired: true, looksLikeDate: false } : { kobo: null, repaired: false, looksLikeDate: true };
  }
  if (typeof v === "number") return { kobo: Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null, repaired: false, looksLikeDate: false };
  const s = v.replace(/\(.*?(\)|$)/g, " ").trim();
  if (parseDate(s)) return { kobo: null, repaired: false, looksLikeDate: true };
  const m = s.match(/\d[\d,' ]*(\.\d+)?/);
  if (!m) return { kobo: null, repaired: false, looksLikeDate: false };
  const n = Number(m[0].replace(/[,' ]/g, ""));
  return { kobo: Number.isFinite(n) ? Math.round(n * 100) : null, repaired: false, looksLikeDate: false };
}

/** Tenor in months: 12, "12 months", "6months", or a date cell Excel made out of 6 (1900-01-06). */
export function parseTenor(v: Raw): { months: number | null; repaired: boolean } {
  if (v === null) return { months: null, repaired: false };
  if (v instanceof Date) {
    const n = serial(v);
    return n >= 1 && n <= 36 ? { months: n, repaired: true } : { months: null, repaired: false };
  }
  const n = typeof v === "number" ? v : Number((v.match(/\d+/) ?? [""])[0]);
  return Number.isInteger(n) && n >= 1 && n <= 36 ? { months: n, repaired: false } : { months: null, repaired: false };
}

const digits = (v: Raw) => (v === null ? "" : typeof v === "number" ? (Number.isSafeInteger(v) ? String(v) : BigInt(Math.round(v)).toString()) : String(v).replace(/\D/g, ""));
export function parseAccount(v: Raw): { value: string | null; ok: boolean } {
  const s = text(v);
  if (!s || isNil(s)) return { value: null, ok: false };
  const d = (typeof v === "string" ? s.split(/[,/;]/)[0] : s).replace(/\D/g, "");
  const a = d.length === 9 ? "0" + d : d;
  return { value: a || null, ok: /^\d{10}$/.test(a) };
}
export function parsePhone(v: Raw): { value: string | null; ok: boolean } {
  const s = text(v);
  if (!s || isNil(s)) return { value: null, ok: false };
  let d = (typeof v === "string" ? s.split(/[,/;]/)[0] : s).replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("234")) d = "0" + d.slice(3);
  if (d.length === 10 && /^[789]/.test(d)) d = "0" + d;
  return { value: d || null, ok: /^0[789]\d{9}$/.test(d) };
}
export function parseId11(v: Raw): { value: string | null; ok: boolean } {
  const s = text(v);
  if (!s || isNil(s)) return { value: null, ok: false };
  const d = digits(v);
  return { value: d || null, ok: /^\d{11}$/.test(d) };
}
/** IMEI: the 15-digit number in the cell ("L1 35…" and spaced numbers are accepted). */
export function parseImei(v: Raw): { value: string | null; state: "OK" | "MISSING" | "INVALID"; problem: string | null } {
  const s = text(v);
  if (!s || isNil(s)) return { value: null, state: "MISSING", problem: null };
  let value: string;
  if (typeof v === "number") value = digits(v);
  else {
    // A clean 15-digit number first ("L1 35…"); otherwise digits written in groups ("35 0000 …").
    const run = s.match(/\d+/g)?.find((x) => x.length === 15) ?? s.replace(/(\d)[\s-](?=\d)/g, "$1").match(/\d+/g)?.find((x) => x.length === 15);
    value = run ?? s.replace(/\D/g, "");
  }
  const problem = value ? imeiProblem(value) : "The IMEI cell has no digits.";
  return { value: value || null, state: problem ? "INVALID" : "OK", problem };
}

function monthKey(header: string, prevKey: string | null, defaultYear: number): string | null {
  const m = norm(header).match(/^(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)(\d{4})?$/);
  if (!m) return null;
  const mon = MONTHS[m[1]];
  let year = m[2] ? Number(m[2]) : defaultYear;
  if (!m[2] && prevKey) {
    const [py, pm] = prevKey.split("-").map(Number);
    year = mon <= pm ? py + 1 : py;
  }
  return `${year}-${String(mon).padStart(2, "0")}`;
}

/** Read every sheet of the register. */
export async function readRegister(data: Buffer): Promise<{ sheets: RegisterSheet[]; rows: RegisterRow[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const tables = wb.worksheets.map((ws) => {
    const rows: { n: number; v: Raw[] }[] = [];
    ws.eachRow({ includeEmpty: false }, (r, n) => {
      const v: Raw[] = [];
      for (let i = 1; i <= r.cellCount; i++) v.push(cellValue(r.getCell(i).value));
      if (v.some((x) => x !== null && text(x) !== "")) rows.push({ n, v });
    });
    return { name: ws.name, rows };
  });
  // Month headers without a year (e.g. "oct", "nov") continue from the earliest year used elsewhere.
  const years = tables.flatMap((t) => (t.rows[0]?.v ?? []).map((h) => norm(h).match(/^[a-z]+(\d{4})$/)?.[1]).filter(Boolean).map(Number));
  const defaultYear = years.length ? Math.min(...years) : new Date().getUTCFullYear();

  const sheets: RegisterSheet[] = [];
  const out: RegisterRow[] = [];
  for (const t of tables) {
    const kind = sheetKind(t.name);
    if (!t.rows.length) continue;
    const hdr = t.rows[0].v.map((h) => norm(h));
    const col = (...names: string[]) => names.map((n) => hdr.indexOf(n)).find((i) => i >= 0) ?? -1;
    const c = {
      name: col("customersname", "customername", "name"),
      account: col("accountnumber", "accountno"),
      phone: col("mobilenumber", "phonenumber", "phone"),
      bvn: col("bvn"),
      nin: col("nin"),
      address: col("residentialaddress", "address"),
      units: col("noofaltphone", "noofaltphones", "units", "quantity"),
      down: col("downpaymentamount", "downpayment"),
      downDate: col("downpaymentdate"),
      instalment: col("repaymentamount", "monthlyrepayment", "instalment"),
      start: col("repaymentstartdate"),
      end: col("repaymentenddate"),
      tenor: col("tenor", "tenure"),
      imei: col("imei2number", "imei", "imeinumber"),
      referrer: col("referredby", "referrer"),
      location: col("location"),
    };
    if (!kind || c.name < 0) {
      sheets.push({ name: t.name, kind, rows: Math.max(0, t.rows.length - 1), monthColumns: [], note: !kind ? "Sheet not recognised (expected Internal, External, Completed or Cancelled) — not read." : "No customer name column — not read." });
      continue;
    }
    const monthCols: { i: number; key: string }[] = [];
    let prev: string | null = null;
    t.rows[0].v.forEach((h, i) => {
      const k = monthKey(String(h ?? ""), prev, defaultYear);
      if (k) {
        monthCols.push({ i, key: k });
        prev = k;
      }
    });
    let count = 0;
    for (const { n, v } of t.rows.slice(1)) {
      const g = (i: number): Raw => (i >= 0 && i < v.length ? v[i] : null);
      const name = text(g(c.name));
      if (!name || /^total/i.test(name)) continue;
      count++;
      const issues: Issue[] = [];
      const add = (code: string, level: IssueLevel, message: string) => issues.push({ code, level, message });

      const unitsRaw = g(c.units);
      const unitsN = typeof unitsRaw === "number" ? unitsRaw : /^\s*\d+\s*$/.test(text(unitsRaw)) ? Number(text(unitsRaw)) : null;
      const units = unitsN !== null && Number.isInteger(unitsN) && unitsN >= 1 && unitsN <= 50 ? unitsN : null;
      const down = parseMoney(g(c.down));
      const inst = parseMoney(g(c.instalment));
      const tenor = parseTenor(g(c.tenor));
      const imei = parseImei(g(c.imei));
      const acct = parseAccount(g(c.account));
      const phone = parsePhone(g(c.phone));
      const bvn = parseId11(g(c.bvn));
      const nin = parseId11(g(c.nin));

      const shifted = (unitsRaw !== null && text(unitsRaw) !== "" && units === null && !/^\d+$/.test(text(unitsRaw))) || inst.looksLikeDate || (imei.state === "INVALID" && /month/i.test(text(g(c.imei))));
      if (shifted) add("SHIFTED_COLUMNS", "BLOCK", "Values appear to be in the wrong columns (for example an address under number of phones, or a date under repayment amount). Check the row in the register.");
      if (units === null && !shifted) add("UNITS_UNREADABLE", "BLOCK", "Number of phones is missing or unreadable.");
      if (units !== null && units > 1) add("MULTI_UNIT", "WARN", `${units} phones on one row.`);
      if (down.repaired) add("AMOUNT_REPAIRED", "WARN", "Down payment was stored as a date in Excel and has been converted back to a number.");
      if (down.kobo === null) add("DOWN_PAYMENT_UNREADABLE", "WARN", "Down payment is missing or unreadable.");
      else if (down.kobo < 100000) add("DOWN_PAYMENT_SUSPECT", "WARN", `Down payment of ₦${(down.kobo / 100).toLocaleString("en-NG")} looks wrong.`);
      if (inst.repaired) add("AMOUNT_REPAIRED", "WARN", "Repayment amount was stored as a date in Excel and has been converted back to a number.");
      if (kind !== "CANCELLED" && kind !== "COMPLETED" && inst.kobo === null && !shifted) add("INSTALMENT_UNREADABLE", "BLOCK", "Monthly repayment amount is missing or unreadable.");
      if (tenor.repaired) add("TENOR_REPAIRED", "WARN", "Tenor was stored as a date in Excel and has been converted back to months.");
      if (kind !== "CANCELLED" && kind !== "COMPLETED" && tenor.months === null) add("TENOR_UNREADABLE", "BLOCK", "Tenor is missing or unreadable.");
      else if (tenor.months !== null && ![3, 6, 12].includes(tenor.months) && !shifted) add("TENOR_UNUSUAL", "WARN", `Tenor of ${tenor.months} months is not one of the Altphones tenors (3, 6 or 12).`);
      if (imei.state === "MISSING") add("IMEI_MISSING", "WARN", "No IMEI recorded.");
      else if (imei.state === "INVALID" && !shifted) add("IMEI_INVALID", "WARN", `IMEI ${imei.value ?? ""}: ${imei.problem}`);
      if (!bvn.ok) add("BVN_INVALID", "WARN", bvn.value ? "BVN is not 11 digits." : "No BVN recorded.");
      if (!acct.ok) add("ACCOUNT_INVALID", "WARN", acct.value ? "Account number is not 10 digits." : "No account number recorded.");
      const startDate = parseDate(g(c.start));
      const endDate = parseDate(g(c.end));
      const downDate = parseDate(g(c.downDate));
      if (kind !== "CANCELLED" && !startDate && !shifted) add("START_DATE_UNREADABLE", "WARN", "Repayment start date is missing or unreadable.");

      const months: { m: string; s: "Y" | "N" }[] = [];
      let other = 0;
      for (const mc of monthCols) {
        const s = text(g(mc.i)).toLowerCase();
        if (!s) continue;
        if (/^y/.test(s)) months.push({ m: mc.key, s: "Y" });
        else if (/^n/.test(s)) months.push({ m: mc.key, s: "N" });
        else other++;
      }
      if (other) add("MONTH_VALUE_UNREADABLE", "WARN", `${other} month cell${other === 1 ? "" : "s"} not marked yes or no.`);
      const marks = monthCols.map((mc) => months.find((x) => x.m === mc.key)?.s ?? "_").join("");
      if (/[YN]_+[YN]/.test(marks)) add("GAP_IN_MONTHS", "WARN", "Some months between recorded months are blank.");

      out.push({
        sheet: t.name,
        kind,
        row: n,
        name,
        account: acct.value,
        phone: phone.value,
        bvn: bvn.value,
        nin: nin.ok ? nin.value : null,
        address: text(g(c.address)) || null,
        units,
        downPaymentKobo: down.kobo,
        downPaymentDate: downDate,
        instalmentKobo: inst.kobo,
        startDate,
        endDate,
        tenor: tenor.months,
        imei: imei.value,
        location: text(g(c.location)).toUpperCase() || null,
        referrer: text(g(c.referrer)).toUpperCase() || null,
        months,
        issues,
      });
    }
    sheets.push({ name: t.name, kind, rows: count, monthColumns: monthCols.map((m) => m.key) });
  }
  return { sheets, rows: out };
}
