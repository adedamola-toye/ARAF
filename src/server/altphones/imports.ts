/**
 * Altphones bulk imports (Super Admin): locations, historical transactions and historical stock movements.
 * Two steps: preview (parse and validate, nothing applied) and commit (re-validated inside the
 * transaction, applied only when there are no errors). The same file cannot be committed twice.
 *
 * Historical transactions are marked Legacy / Imported: they create no payments, approvals, emails or
 * stock movements (their IMEIs are recorded as issued). Stock positions are imported separately as
 * legacy ledger movements, each with a unique reference, so nothing is counted twice.
 */
import type { Db, Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { sha256Hex } from "../crypto";
import { holdsRole } from "../domain/access";
import { readSpreadsheet } from "../domain/directory";
import { normaliseNigerianState } from "../domain/roles";
import { imeiProblem, isEmail, isImei, isTenure, normalisePhone } from "@/lib/altphones";
import { currentSettings, isUuid, nextRef } from "./core";
import { post } from "./stock";
import { parseNairaToKobo } from "../money";

/** Officer (Delight Officer / Smile Associate) uploads were removed: officers are never created or assigned from a spreadsheet. */
export type ImportKind = "LOCATIONS" | "OPENING_STOCK" | "TRANSACTIONS" | "STOCK" | "STOCK_COUNT" | "BPM_STATES" | "BPM_LOCATIONS" | "HISTORICAL_REPAYMENTS";
export const IMPORT_LABELS: Record<ImportKind, string> = {
  LOCATIONS: "Branches, Shops and BOX locations",
  OPENING_STOCK: "Opening stock", TRANSACTIONS: "Historical sales and credit facilities", STOCK: "Historical stock movements",
  STOCK_COUNT: "Stock reconciliation (physical count)", BPM_STATES: "BPM register (states covered)", BPM_LOCATIONS: "Location-to-BPM mapping", HISTORICAL_REPAYMENTS: "Historical repayments (reconciliation)" };
export const MAX_IMPORT_ROWS = 20_000;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const COLUMNS: Record<ImportKind, Record<string, string[]>> = {
  HISTORICAL_REPAYMENTS: { account: ["historicalreference", "accountreference", "historicalaccount", "reference"], date: ["paymentdate", "datepaid", "date"], amount: ["amount", "amountpaid", "amountnaira"], paymentRef: ["paymentreference", "transactionreference", "bankreference", "evidencereference"], month: ["monthcovered", "month", "instalmentmonth"], note: ["note", "notes", "comment"] },
  STOCK_COUNT: { location: ["location", "branchorshop"], model: ["phonemodel", "model", "phone"], counted: ["countedquantity", "counted", "physicalcount", "quantity"], date: ["countdate", "date"], note: ["note", "notes", "reference"] },
  BPM_STATES: { name: ["name", "bpmname", "fullname"], email: ["email", "officialemail", "bpmemail"], states: ["statescovered", "states", "coverage", "mappedstates"] },
  BPM_LOCATIONS: { location: ["location", "locationname", "altshoporaltbox"], email: ["bpmemail", "email", "bpm"], note: ["note", "notes", "reason"] },
  OPENING_STOCK: { location: ["location", "branchorshop"], model: ["phonemodel", "model", "phone"], quantity: ["quantity", "qty", "units"], imeis: ["imeis", "imei"], note: ["note", "notes", "source"] },
  LOCATIONS: { state: ["state"], city: ["city", "town", "towncity", "lga"], type: ["type", "locationtype", "outlettype"], name: ["name", "locationname", "outletname", "branch", "locations", "location"], address: ["address"], sourceName: ["sourcename", "originalname", "listedname"], sourceType: ["sourcetype", "originaltype", "listedas"], aliases: ["aliases", "alsoknownas", "registerlabels", "otherlabels"] },
  TRANSACTIONS: {
    reference: ["reference", "ref", "transactionreference", "transactionref"],
    type: ["type", "transactiontype", "saletype"],
    customerName: ["customername", "customer", "name"],
    customerEmail: ["customeremail", "email"],
    customerPhone: ["customerphone", "phone", "phonenumber"],
    model: ["phonemodel", "model", "phone"],
    imei: ["imei"],
    date: ["transactiondate", "date"],
    officer: ["originatingofficer", "officer", "officeremail"],
    origin: ["originatinglocation", "origin"],
    supply: ["supplyinglocation", "supplyingbranchorshop", "supply"],
    tenure: ["tenure", "tenuremonths"],
  },
  STOCK: { reference: ["reference", "ref"], location: ["location", "branchorshop"], model: ["phonemodel", "model"], movement: ["movement", "movementtype", "type"], quantity: ["quantity", "qty", "units"], date: ["date", "movementdate"], note: ["note", "notes", "comment"] },
};
const REQUIRED: Record<ImportKind, string[]> = {
  OPENING_STOCK: ["location", "model", "quantity"],
  STOCK_COUNT: ["location", "model", "counted", "date"],
  HISTORICAL_REPAYMENTS: ["account", "date", "amount", "paymentRef"],
  BPM_STATES: ["email", "states"],
  BPM_LOCATIONS: ["location", "email"],
  LOCATIONS: ["state", "city", "type", "name"],
  TRANSACTIONS: ["reference", "type", "customerName", "model", "imei", "date", "origin", "supply"],
  STOCK: ["reference", "location", "model", "movement", "quantity", "date"],
};

export const TEMPLATES: Record<ImportKind, string> = {
  HISTORICAL_REPAYMENTS: "Historical reference,Payment date,Amount,Payment reference,Month covered,Note\r\nHIS-2026-000001,2026-10-28,9725.00,FT26301ABC123,2026-10,Bank statement line 14\r\n",
  STOCK_COUNT: "Location,Phone model,Counted quantity,Count date,Note\r\nIkeja Branch,Altphone L1 Series — colour not recorded,18,2026-11-14,Month-end count\r\n",
  BPM_STATES: "Name,Email,States covered\r\nFirstname Lastname,firstname.lastname@altbank.ng,LAGOS; OGUN\r\n",
  BPM_LOCATIONS: "Location,BPM email,Note\r\nYaba Altbox,firstname.lastname@altbank.ng,Nearest BPM\r\n",
  OPENING_STOCK: "Location,Phone model,Quantity,IMEIs,Note\r\nIkeja Branch,Altphone L1 Series — Black & Gold,20,,Opening count 2026-11-13\r\nYaba Altshop,Altphone L1 Series — Green,10,356938035643809;490154203237518,Delivery note 001\r\n",
  LOCATIONS: "State,City,Type,Name,Source name,Source type,Aliases\r\nLAGOS,Ikeja,Branch,Ikeja Branch,,,IKEJA\r\nLAGOS,Yaba,Shop,Yaba Altshop,,,\r\nABUJA,Abuja,Shop,Dei Dei Altshop,DEI DEI,ALTSHOP,\r\n",
  TRANSACTIONS:
    "Reference,Type,Customer name,Customer email,Customer phone,Phone model,IMEI,Transaction date,Originating officer,Originating location,Supplying location,Tenure\r\nLEG-0001,Outright,Customer Name,customer@example.com,08031234567,Model name,000000000000000,2026-01-15,officer@altbank.ng,Ikeja Branch,Ikeja Branch,\r\n",
  STOCK: "Reference,Location,Phone model,Movement,Quantity,Date,Note\r\nSTK-LEG-0001,Ikeja Branch,Model name,Opening,20,2026-01-01,Opening balance\r\n",
};

interface RowError {
  row: number;
  message: string;
}
type Row = Record<string, string> & { _row: string };

async function readRows(kind: ImportKind, filename: string, data: Buffer): Promise<{ rows: Row[]; errors: RowError[] }> {
  const table = await readSpreadsheet(filename, data);
  if (table.length < 2) throw invalid("The file needs a header row and at least one data row.");
  if (table.length - 1 > MAX_IMPORT_ROWS) throw invalid(`The file has more than ${MAX_IMPORT_ROWS.toLocaleString()} rows.`);
  const aliases = COLUMNS[kind];
  let headerIdx = -1;
  let map: Record<string, number> = {};
  for (let h = 0; h < Math.min(10, table.length); h++) {
    const heads = table[h].map(norm);
    const m: Record<string, number> = {};
    for (const [field, names] of Object.entries(aliases)) {
      const i = heads.findIndex((x) => names.includes(x));
      if (i >= 0) m[field] = i;
    }
    if (REQUIRED[kind].every((f) => m[f] !== undefined)) {
      headerIdx = h;
      map = m;
      break;
    }
  }
  if (headerIdx < 0) throw invalid(`Could not find the header row. Required columns: ${REQUIRED[kind].join(", ")}. Download the template for the exact layout.`);
  if (kind === "LOCATIONS" && map.address !== undefined)
    throw invalid("Addresses are not uploaded with locations. Remove the Address column: addresses come from the profiling workbook (Altphones → Locations) or an address registration approved by the Unit Head.");
  const rows: Row[] = [];
  for (let r = headerIdx + 1; r < table.length; r++) {
    const cells = table[r];
    const row: Row = { _row: String(r + 1) };
    for (const [f, i] of Object.entries(map)) row[f] = String(cells[i] ?? "").trim();
    if (Object.entries(row).every(([k, v]) => k === "_row" || !v)) continue;
    rows.push(row);
  }
  return { rows, errors: [] };
}

function parseDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t); // day/month/year (Nigerian convention)
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const TYPE_MAP: Record<string, string> = { branch: "BRANCH", shop: "ALTSHOP", altshop: "ALTSHOP", box: "ALTBOX", altbox: "ALTBOX" };

/** Find a location by its name, its original (source) name, or a recorded alias. */
async function locationIndex(q: Db) {
  const all = (
    await q.query<{ id: string; name: string; outlet_type: string; state: string; city: string; labels: string[] }>(
      `SELECT l.id, l.name, l.outlet_type, l.state, l.city,
              array_remove(array_cat(ARRAY[lower(l.name), lower(coalesce(l.source_name, ''))], coalesce(array_agg(lower(a.label)) FILTER (WHERE a.label IS NOT NULL), '{}')), '') AS labels
         FROM locations l LEFT JOIN altphones_location_aliases a ON a.location_id = l.id
        WHERE l.active GROUP BY l.id`,
    )
  ).rows;
  const byLabel = new Map<string, (typeof all)[number][]>();
  for (const l of all) for (const k of new Set(l.labels)) byLabel.set(k, [...(byLabel.get(k) ?? []), l]);
  return (name: string) => byLabel.get(name.replace(/\s+/g, " ").trim().toLowerCase()) ?? [];
}
async function modelIndex(q: Db) {
  const all = (await q.query<{ id: string; name: string }>("SELECT id, name FROM altphones_models")).rows;
  return (name: string) => all.find((m) => m.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

/** Validate rows against the database as it is now. Returns per-row errors and normalised rows. */
async function validate(q: Db, kind: ImportKind, rows: Row[]): Promise<{ ok: Record<string, unknown>[]; errors: RowError[]; skipped: RowError[] }> {
  const errors: RowError[] = [];
  const skipped: RowError[] = [];
  const ok: Record<string, unknown>[] = [];
  const err = (r: Row, m: string) => errors.push({ row: Number(r._row), message: m });
  if (kind === "LOCATIONS") {
    const seen = new Set<string>();
    for (const r of rows) {
      const state = normaliseNigerianState(r.state);
      const type = TYPE_MAP[norm(r.type)];
      if (!state) { err(r, `"${r.state}" is not a Nigerian state (use e.g. LAGOS, FCT (ABUJA)).`); continue; }
      if (!type) { err(r, `Type "${r.type}" must be Branch, Shop or BOX.`); continue; }
      if (r.city.length < 2 || r.name.length < 2) { err(r, "City and name are required."); continue; }
      const key = `${state}|${r.city.toLowerCase()}|${type}|${r.name.toLowerCase()}`;
      if (seen.has(key)) { err(r, `${r.name} appears more than once in the file.`); continue; }
      seen.add(key);
      const exists = (await q.query("SELECT 1 FROM locations WHERE state = $1 AND lower(city) = lower($2) AND outlet_type = $3 AND lower(name) = lower($4)", [state, r.city, type, r.name])).rowCount;
      if (exists) { skipped.push({ row: Number(r._row), message: `${r.name} already exists — skipped.` }); continue; }
      const sameName = (await q.query("SELECT state, city FROM locations WHERE lower(name) = lower($1)", [r.name])).rows[0];
      if (sameName) { err(r, `A location named "${r.name}" already exists in ${sameName.city}, ${sameName.state}. Use a distinct name.`); continue; }
      const aliases = [...new Set((r.aliases ?? "").split(/[;|]/).map((a) => a.replace(/\s+/g, " ").trim().toUpperCase()).filter((a) => a.length >= 2 && a !== r.name.toUpperCase()))];
      const taken = aliases.length ? (await q.query<{ label: string }>("SELECT label FROM altphones_location_aliases WHERE label = ANY($1)", [aliases])).rows.map((x) => x.label) : [];
      if (taken.length) { err(r, `${r.name}: alias already used by another location: ${taken.join(", ")}.`); continue; }
      ok.push({ row: Number(r._row), state, city: r.city, type, name: r.name, sourceName: (r.sourceName || r.name).trim(), sourceState: r.state.trim(), sourceType: (r.sourceType || r.type).trim(), aliases });
    }
  } else if (kind === "HISTORICAL_REPAYMENTS") {
    // Every repayment needs evidence (a payment reference). Overpayments are refused, never absorbed.
    const today = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
    const seen = new Set<string>();
    const runningPaid = new Map<string, number>();
    for (const r of rows) {
      const problems: string[] = [];
      const ref = (r.account ?? "").trim().toUpperCase();
      const acc = ref ? (await q.query<{ id: string; ref: string; status: string; total_obligation_kobo: string | null; amount_repaid_kobo: string }>("SELECT id, ref, status, total_obligation_kobo, amount_repaid_kobo FROM altphones_historical_accounts WHERE upper(ref) = $1", [ref])).rows[0] : undefined;
      if (!acc) problems.push(`historical account "${r.account}" was not found (use the HIS- reference shown in ARAF)`);
      else if (acc.status === "CANCELLED") problems.push("this account was cancelled; no repayment can be recorded");
      const day = parseDate(r.date ?? "");
      if (!day) problems.push("payment date must be YYYY-MM-DD");
      else if (day > today) problems.push("payment date cannot be in the future");
      const amt = parseNairaToKobo(r.amount ?? "");
      if (amt === null || amt <= 0) problems.push("amount must be a positive naira amount (e.g. 9725.00)");
      const pref = (r.paymentRef ?? "").trim();
      if (pref.length < 3) problems.push("payment reference (evidence) is required");
      const month = (r.month ?? "").trim();
      if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) problems.push("month covered must be YYYY-MM");
      else if (month && acc && (await q.query("SELECT 1 FROM altphones_historical_instalments WHERE account_id = $1 AND month = $2 AND status = 'PAID'", [acc.id, `${month}-01`])).rowCount) problems.push(`${month} is already recorded as paid for this account`);
      if (acc && pref) {
        const key = `${acc.id}|${pref.toUpperCase()}`;
        if (seen.has(key)) problems.push("this payment reference appears twice for the account in the file");
        else if ((await q.query("SELECT 1 FROM altphones_historical_repayments WHERE account_id = $1 AND upper(reference) = upper($2)", [acc.id, pref])).rowCount) problems.push("this payment reference is already recorded for the account");
        seen.add(key);
      }
      if (acc && amt && acc.total_obligation_kobo !== null) {
        const before = runningPaid.get(acc.id) ?? Number(acc.amount_repaid_kobo);
        if (before + amt > Number(acc.total_obligation_kobo)) problems.push(`amount exceeds the outstanding balance (₦${((Number(acc.total_obligation_kobo) - before) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}): record overpayments as an exception outside this file`);
        else runningPaid.set(acc.id, before + amt);
      }
      if (problems.length) { err(r, `${r.account || "Row"}: ${problems.join("; ")}.`); continue; }
      ok.push({ row: Number(r._row), accountId: acc!.id, accountRef: acc!.ref, date: day, amountKobo: amt, paymentRef: pref, month: month || null, note: r.note || null });
    }
  } else if (kind === "STOCK_COUNT") {
    const loc = await locationIndex(q);
    const model = await modelIndex(q);
    const seenPair = new Set<string>();
    const today = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
    for (const r of rows) {
      const l = loc(r.location);
      const m = model(r.model);
      const counted = Number(r.counted);
      const day = parseDate(r.date);
      const problems: string[] = [];
      if (l.length !== 1) problems.push(l.length ? `location "${r.location}" matches more than one location` : `location "${r.location}" was not found`);
      else if (!["BRANCH", "ALTSHOP"].includes(l[0].outlet_type)) problems.push("BOX locations do not hold stock");
      if (!m) problems.push(`phone model "${r.model}" is not in the catalogue`);
      if (!Number.isInteger(counted) || counted < 0 || counted > 100000) problems.push("counted quantity must be a whole number (0 or more)");
      if (!day) problems.push("count date must be YYYY-MM-DD");
      else if (day > today) problems.push("count date cannot be in the future");
      const pair = l.length === 1 && m ? `${l[0].id}|${m.id}` : null;
      if (pair && seenPair.has(pair)) problems.push("this location and phone appear more than once");
      if (pair && Number.isInteger(counted)) {
        const bal = (await q.query<{ reserved: number }>("SELECT reserved FROM altphones_stock WHERE location_id = $1 AND model_id = $2", [l[0].id, m!.id])).rows[0];
        if (bal && counted < bal.reserved) problems.push(`${bal.reserved} units are reserved for paid customers, so the count cannot be lower`);
      }
      if (problems.length) { err(r, `${r.location || "Row"} / ${r.model || "?"}: ${problems.join("; ")}.`); continue; }
      seenPair.add(pair!);
      ok.push({ row: Number(r._row), locationId: l[0].id, locationName: l[0].name, modelId: m!.id, counted, date: day, note: r.note || null });
    }
  } else if (kind === "BPM_STATES" || kind === "BPM_LOCATIONS") {
    // BPMs are matched to existing, verified staff only: no profile is ever created from a file.
    const loc = await locationIndex(q);
    const seen = new Set<string>();
    for (const r of rows) {
      const email = (r.email ?? "").trim().toLowerCase();
      const problems: string[] = [];
      const st = (await q.query<{ id: string }>("SELECT id FROM staff WHERE lower(email) = $1 AND status = 'ACTIVE'", [email])).rows[0];
      if (!st || !(await holdsRole(q, st.id, "BUSINESS_PERFORMANCE_MANAGER"))) problems.push(`${email || "email"} is not an active, verified Business Performance Manager in ARAF (no profile is created from a file)`);
      if (kind === "BPM_STATES") {
        const states = (r.states ?? "").split(/[;,|]/).map((x) => x.trim()).filter(Boolean).map((x) => ({ raw: x, state: normaliseNigerianState(x) }));
        const bad = states.filter((x) => !x.state).map((x) => x.raw);
        if (!states.length) problems.push("list at least one state");
        if (bad.length) problems.push(`not a Nigerian state: ${bad.join(", ")}`);
        const dup = states.filter((x) => x.state && seen.has(x.state)).map((x) => x.state);
        if (dup.length) problems.push(`state already given to another BPM in this file: ${dup.join(", ")}`);
        if (problems.length) { err(r, `${email || "Row"}: ${problems.join("; ")}.`); continue; }
        states.forEach((x) => seen.add(x.state!));
        ok.push({ row: Number(r._row), email, states: [...new Set(states.map((x) => x.state!))] });
      } else {
        const l = loc(r.location);
        if (l.length !== 1) problems.push(l.length ? `location "${r.location}" matches more than one location` : `location "${r.location}" was not found`);
        else if (!["ALTSHOP", "ALTBOX"].includes(l[0].outlet_type)) problems.push("only Altshops and Altboxes are routed to a BPM");
        else if (seen.has(l[0].id)) problems.push("this location appears more than once");
        if (problems.length) { err(r, `${r.location || "Row"}: ${problems.join("; ")}.`); continue; }
        seen.add(l[0].id);
        ok.push({ row: Number(r._row), email, locationId: l[0].id, locationName: l[0].name });
      }
    }
  } else if (kind === "OPENING_STOCK") {
    const loc = await locationIndex(q);
    const model = await modelIndex(q);
    const seenImei = new Set<string>();
    const seenPair = new Set<string>();
    for (const r of rows) {
      const l = loc(r.location);
      const m = model(r.model);
      const qty = Number(r.quantity);
      const imeis = (r.imeis ?? "").split(/[\s,;|]+/).map((s) => s.trim()).filter(Boolean);
      const problems: string[] = [];
      if (l.length !== 1) problems.push(l.length ? `location "${r.location}" matches more than one location` : `location "${r.location}" was not found`);
      else if (!["BRANCH", "ALTSHOP"].includes(l[0].outlet_type)) problems.push("BOX locations cannot hold stock");
      if (!m) problems.push(`phone model "${r.model}" is not in the catalogue`);
      if (!Number.isInteger(qty) || qty < 1 || qty > 100000) problems.push("quantity must be a whole number of units");
      const bad = imeis.map((i) => [i, imeiProblem(i)] as const).filter(([, p]) => p);
      if (bad.length) problems.push(`IMEI${bad.length === 1 ? "" : "s"} not valid: ${bad.slice(0, 3).map(([i, p]) => `${i} (${p})`).join("; ")}${bad.length > 3 ? ` and ${bad.length - 3} more` : ""}`);
      if (Number.isInteger(qty) && imeis.length > qty) problems.push(`${imeis.length} IMEIs listed for ${qty} units`);
      const dupInFile = imeis.filter((i) => seenImei.has(i));
      if (dupInFile.length) problems.push(`IMEIs listed twice in the file: ${dupInFile.slice(0, 3).join(", ")}`);
      if (imeis.length) {
        const known = (await q.query<{ imei: string }>("SELECT imei FROM altphones_devices WHERE imei = ANY($1)", [imeis])).rows.map((x) => x.imei);
        if (known.length) problems.push(`IMEIs already registered: ${known.slice(0, 3).join(", ")}`);
      }
      const pair = l.length === 1 && m ? `${l[0].id}|${m.id}` : null;
      if (pair && seenPair.has(pair)) problems.push("this location and phone appear more than once; combine them into one row");
      if (problems.length) {
        err(r, `${r.location || "Row"} / ${r.model || "?"}: ${problems.join("; ")}.`);
        continue;
      }
      imeis.forEach((i) => seenImei.add(i));
      seenPair.add(pair!);
      ok.push({ row: Number(r._row), locationId: l[0].id, locationName: l[0].name, modelId: m!.id, modelName: m!.name, quantity: qty, imeis, note: r.note || null });
    }
  } else if (kind === "TRANSACTIONS") {
    const loc = await locationIndex(q);
    const model = await modelIndex(q);
    const seenRef = new Set<string>();
    const seenImei = new Set<string>();
    for (const r of rows) {
      const kindT = norm(r.type) === "outright" ? "OUTRIGHT" : norm(r.type) === "credit" ? "CREDIT" : null;
      const imei = r.imei.replace(/\s/g, "");
      const date = parseDate(r.date);
      const m = model(r.model);
      const origin = loc(r.origin);
      const supply = loc(r.supply);
      const problems: string[] = [];
      if (!r.reference) problems.push("reference is missing");
      if (!kindT) problems.push(`type "${r.type}" must be Outright or Credit`);
      if (r.customerName.length < 2) problems.push("customer name is missing");
      if (r.customerEmail && !isEmail(r.customerEmail)) problems.push("customer email is not valid");
      if (r.customerPhone && !normalisePhone(r.customerPhone)) problems.push("customer phone is not a Nigerian mobile number");
      if (!m) problems.push(`phone model "${r.model}" is not in the catalogue`);
      const imeiIssue = imeiProblem(imei);
      if (imeiIssue) problems.push(`IMEI ${imei || "(blank)"}: ${imeiIssue}`);
      if (!date) problems.push(`date "${r.date}" is not a date`);
      else if (date > new Date().toISOString().slice(0, 10)) problems.push("the date is in the future");
      if (origin.length !== 1) problems.push(origin.length ? `originating location "${r.origin}" matches more than one location` : `originating location "${r.origin}" was not found`);
      if (supply.length !== 1) problems.push(supply.length ? `supplying location "${r.supply}" matches more than one location` : `supplying location "${r.supply}" was not found`);
      else if (!["BRANCH", "ALTSHOP"].includes(supply[0].outlet_type)) problems.push("the supplying location must be a Branch or Shop");
      if (origin.length === 1 && origin[0].outlet_type === "ALTSHOP") problems.push("a Shop cannot originate sales (use the Branch or BOX)");
      if (kindT === "CREDIT" && r.tenure && !isTenure(r.tenure)) problems.push("tenure must be 3, 6 or 12");
      if (r.reference && seenRef.has(r.reference.toLowerCase())) problems.push("reference appears more than once in the file");
      if (isImei(imei) && seenImei.has(imei)) problems.push("IMEI appears more than once in the file");
      if (r.reference && (await q.query("SELECT 1 FROM altphones_applications WHERE lower(legacy_ref) = lower($1)", [r.reference])).rowCount) problems.push("this reference was already imported");
      if (isImei(imei) && (await q.query("SELECT 1 FROM altphones_devices WHERE imei = $1", [imei])).rowCount) problems.push("this IMEI is already recorded");
      if (problems.length) { err(r, `${r.reference || "Row"}: ${problems.join("; ")}.`); continue; }
      seenRef.add(r.reference.toLowerCase());
      seenImei.add(imei);
      const officer = r.officer ? (await q.query<{ id: string }>("SELECT id FROM staff WHERE lower(email) = lower($1)", [r.officer])).rows[0]?.id ?? null : null;
      ok.push({
        row: Number(r._row),
        reference: r.reference,
        kind: kindT,
        customerName: r.customerName,
        customerEmail: r.customerEmail.toLowerCase() || null,
        customerPhone: r.customerPhone ? normalisePhone(r.customerPhone) : null,
        modelId: m!.id,
        modelName: m!.name,
        imei,
        date,
        officerText: r.officer || null,
        officerId: officer,
        originId: origin[0].id,
        originType: origin[0].outlet_type,
        supplyId: supply[0].id,
        tenure: kindT === "CREDIT" && r.tenure ? Number(r.tenure) : null,
      });
    }
  } else {
    const loc = await locationIndex(q);
    const model = await modelIndex(q);
    const seenRef = new Set<string>();
    const MOVES: Record<string, { movement: string; sign: number }> = {
      opening: { movement: "OPENING", sign: 1 },
      receipt: { movement: "RECEIPT", sign: 1 },
      received: { movement: "RECEIPT", sign: 1 },
      sale: { movement: "SALE", sign: -1 },
      disbursement: { movement: "DISBURSEMENT", sign: -1 },
      adjustment: { movement: "LEGACY_ADJUSTMENT", sign: 0 },
    };
    for (const r of rows) {
      const l = loc(r.location);
      const m = model(r.model);
      const mv = MOVES[norm(r.movement)];
      const qty = Number(r.quantity);
      const date = parseDate(r.date);
      const problems: string[] = [];
      if (!r.reference) problems.push("reference is missing");
      if (l.length !== 1) problems.push(l.length ? `location "${r.location}" matches more than one location` : `location "${r.location}" was not found`);
      else if (!["BRANCH", "ALTSHOP"].includes(l[0].outlet_type)) problems.push("BOX locations cannot hold stock");
      if (!m) problems.push(`phone model "${r.model}" is not in the catalogue`);
      if (!mv) problems.push(`movement "${r.movement}" must be Opening, Receipt, Sale, Disbursement or Adjustment`);
      if (!Number.isInteger(qty) || qty === 0 || (mv && mv.sign !== 0 && qty < 0)) problems.push("quantity must be a whole number (positive; adjustments may be negative)");
      if (!date) problems.push(`date "${r.date}" is not a date`);
      if (r.reference && seenRef.has(r.reference.toLowerCase())) problems.push("reference appears more than once in the file");
      if (r.reference && (await q.query("SELECT 1 FROM altphones_stock_ledger WHERE import_id IS NOT NULL AND lower(reference) = lower($1)", [r.reference])).rowCount) problems.push("this reference was already imported");
      if (problems.length) { err(r, `${r.reference || "Row"}: ${problems.join("; ")}.`); continue; }
      seenRef.add(r.reference.toLowerCase());
      ok.push({ row: Number(r._row), reference: r.reference, locationId: l[0].id, locationName: l[0].name, modelId: m!.id, modelName: m!.name, movement: mv.movement, physical: mv.sign === 0 ? qty : mv.sign * qty, date, note: r.note || null });
    }
    // The stock position after the import must stay valid at every location.
    if (!errors.length) {
      const delta = new Map<string, number>();
      for (const o of ok) delta.set(`${o.locationId}|${o.modelId}`, (delta.get(`${o.locationId}|${o.modelId}`) ?? 0) + (o.physical as number));
      for (const [k, d] of delta) {
        const [lid, mid] = k.split("|");
        const bal = (await q.query<{ physical: number; reserved: number }>("SELECT physical, reserved FROM altphones_stock WHERE location_id = $1 AND model_id = $2", [lid, mid])).rows[0] ?? { physical: 0, reserved: 0 };
        if (bal.physical + d < bal.reserved) {
          const o = ok.find((x) => `${x.locationId}|${x.modelId}` === k)!;
          errors.push({ row: o.row as number, message: `${o.locationName} / ${o.modelName}: the imported movements would leave ${bal.physical + d} units, fewer than the ${bal.reserved} reserved or needed. Check the quantities.` });
        }
      }
    }
  }
  return { ok, errors, skipped };
}

async function requireAdmin(q: Db, ctx: Ctx) {
  if (!ctx.actor) throw forbidden();
  if (!(await holdsRole(q, ctx.actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can import Altphones records.");
  return ctx.actor;
}

export async function previewImport(ctx: Ctx, kind: string, filename: string, data: Buffer) {
  if (!(kind in IMPORT_LABELS)) throw invalid("Choose what you are importing.");
  return withTx(async (tx) => {
    const actor = await requireAdmin(tx, ctx);
    const k = kind as ImportKind;
    const sha = sha256Hex(data);
    const done = (await tx.query("SELECT committed_at FROM altphones_imports WHERE kind = $1 AND sha256 = $2 AND status = 'COMMITTED'", [k, sha])).rows[0];
    if (done) throw conflict("This exact file has already been imported.");
    const { rows } = await readRows(k, filename, data);
    const v = await validate(tx, k, rows);
    const summary = { rows: rows.length, valid: v.ok.length, errors: v.errors.length, skipped: v.skipped.length };
    const imp = (
      await tx.query<{ id: string }>("INSERT INTO altphones_imports (kind, filename, sha256, rows, errors, summary, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id", [
        k,
        filename.slice(0, 200),
        sha,
        JSON.stringify(rows),
        JSON.stringify([...v.errors, ...v.skipped.map((s) => ({ ...s, skipped: true }))]),
        JSON.stringify(summary),
        actor.staffId,
        ctx.now,
      ])
    ).rows[0];
    await audit(tx, ctx, { action: "ALTPHONES_IMPORT_PREVIEWED", details: { kind: k, importId: imp.id, ...summary } });
    return { id: imp.id, summary };
  });
}

/**
 * Submit a checked file for approval. With invalid rows it can go forward only as an explicit partial
 * import (the invalid rows are left out and listed in the error report) with a note explaining why.
 */
export async function submitImport(ctx: Ctx, id: string, p: { partial?: boolean; note?: string } = {}) {
  return withTx(async (tx) => {
    const actor = await requireAdmin(tx, ctx);
    if (!isUuid(id)) throw notFound("Import not found.");
    const imp = (await tx.query("SELECT * FROM altphones_imports WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!imp) throw notFound("Import not found.");
    if (imp.status !== "PREVIEW") throw conflict("This import has already been submitted, committed or discarded.");
    const sum = imp.summary as { valid: number; errors: number };
    if (!sum.valid) throw invalid("Nothing in this file is ready to import.");
    const note = (p.note ?? "").trim();
    if (sum.errors > 0) {
      if (!p.partial) throw invalid(`The file has ${sum.errors} invalid row${sum.errors === 1 ? "" : "s"}. Correct the file and upload it again, or submit a partial import that leaves them out.`);
      if (note.length < 10) throw invalid("Explain why the invalid rows are being left out (at least 10 characters).", { note: "Give a reason for the partial import." });
    }
    if ((await tx.query("SELECT 1 FROM altphones_imports WHERE kind = $1 AND sha256 = $2 AND status = 'SUBMITTED'", [imp.kind, imp.sha256])).rowCount) throw conflict("This file is already waiting for approval.");
    await tx.query("UPDATE altphones_imports SET status = 'SUBMITTED', submitted_by = $2, submitted_at = $3, partial = $4, submit_note = $5 WHERE id = $1", [id, actor.staffId, ctx.now, sum.errors > 0, note || null]);
    await audit(tx, ctx, { action: "ALTPHONES_IMPORT_SUBMITTED", reason: note || null, details: { importId: id, kind: imp.kind, partial: sum.errors > 0, ...sum } });
    return { ok: true };
  });
}

async function requireImportApprover(q: Db, ctx: Ctx, imp: { created_by: string; submitted_by: string | null }) {
  if (!ctx.actor) throw forbidden();
  const { isApprover } = await import("./location-master");
  if (!(await isApprover(q, ctx.actor.staffId))) throw forbidden("Only the Altphones Unit Head can approve an Altphones import.");
  if (ctx.actor.staffId === imp.created_by || ctx.actor.staffId === imp.submitted_by) throw forbidden("You cannot approve an import you uploaded or submitted.");
  return ctx.actor;
}

export async function rejectImport(ctx: Ctx, id: string, note: string) {
  return withTx(async (tx) => {
    if (!isUuid(id)) throw notFound("Import not found.");
    const imp = (await tx.query("SELECT * FROM altphones_imports WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!imp) throw notFound("Import not found.");
    const actor = await requireImportApprover(tx, ctx, imp);
    if (imp.status !== "SUBMITTED") throw conflict("This import is not waiting for approval.");
    if ((note ?? "").trim().length < 5) throw invalid("Give the reason for rejecting the import.", { note: "Reason required." });
    await tx.query("UPDATE altphones_imports SET status = 'REJECTED', decided_by = $2, decided_at = $3, decision_note = $4 WHERE id = $1", [id, actor.staffId, ctx.now, note.trim()]);
    await audit(tx, ctx, { action: "ALTPHONES_IMPORT_REJECTED", reason: note.trim(), details: { importId: id, kind: imp.kind } });
    return { ok: true };
  });
}

/** Unit Head approval: re-validates against the database and applies the valid rows in one transaction. */
export async function commitImport(ctx: Ctx, id: string) {
  return withTx(async (tx) => {
    if (!isUuid(id)) throw notFound("Import not found.");
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('altphones_import'))");
    const imp = (await tx.query("SELECT * FROM altphones_imports WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!imp) throw notFound("Import not found.");
    const actor = await requireImportApprover(tx, ctx, imp);
    if (imp.status !== "SUBMITTED") throw conflict(imp.status === "PREVIEW" ? "This import has not been submitted for approval yet." : "This import has already been decided.");
    const kind = imp.kind as ImportKind;
    const v = await validate(tx, kind, imp.rows as Row[]);
    if (v.errors.length && !imp.partial) throw invalid(`The file now has ${v.errors.length} error${v.errors.length === 1 ? "" : "s"} (records changed since the preview). Reject it and ask for a corrected file.`);
    if (!v.ok.length) throw invalid("No row in this file can be imported any more. Reject it.");
    const settings = await currentSettings(tx);
    let applied = 0;
    for (const o of v.ok) {
      if (kind === "LOCATIONS") {
        // The original labels are kept exactly as supplied alongside the normalised state and type.
        const lid = (
          await tx.query<{ id: string }>(
            "INSERT INTO locations (state, city, outlet_type, name, active, updated_at, source_name, source_state, source_type, created_by) VALUES ($1,$2,$3,$4,true,$5,$9,$6,$7,$8) RETURNING id",
            [o.state, o.city, o.type, o.name, ctx.now, o.sourceState, o.sourceType, ctx.actor!.staffId, o.sourceName],
          )
        ).rows[0].id;
        for (const a of o.aliases as string[]) await tx.query("INSERT INTO altphones_location_aliases (label, location_id, created_by, created_at) VALUES ($1,$2,$3,$4)", [a, lid, ctx.actor!.staffId, ctx.now]);
      } else if (kind === "HISTORICAL_REPAYMENTS") {
        await tx.query(
          "INSERT INTO altphones_historical_repayments (account_id, paid_on, amount_kobo, reference, month_covered, note, import_id, recorded_by, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [o.accountId, o.date, o.amountKobo, o.paymentRef, o.month ? `${o.month}-01` : null, o.note, id, actor.staffId, ctx.now],
        );
        if (o.month)
          await tx.query(
            "INSERT INTO altphones_historical_instalments (account_id, month, status, source, recorded_at) VALUES ($1,$2,'PAID','RECONCILIATION',$3) ON CONFLICT (account_id, month) DO UPDATE SET status = 'PAID', source = 'RECONCILIATION', recorded_at = EXCLUDED.recorded_at",
            [o.accountId, `${o.month}-01`, ctx.now],
          );
        await recomputeHistorical(tx, o.accountId as string, ctx.now);
      } else if (kind === "STOCK_COUNT") {
        const bal = (await tx.query<{ physical: number }>("SELECT physical FROM altphones_stock WHERE location_id = $1 AND model_id = $2", [o.locationId, o.modelId])).rows[0];
        const variance = (o.counted as number) - (bal?.physical ?? 0);
        if (variance !== 0) await post(tx, ctx, { locationId: o.locationId as string, modelId: o.modelId as string, movement: "COUNT_ADJUSTMENT", physical: variance, reserved: 0, importId: id, reference: `CNT-${id.slice(0, 8)}-${o.row}`, note: `Stock reconciliation of ${o.date}${o.note ? ` — ${o.note}` : ""}` });
      } else if (kind === "BPM_STATES") {
        for (const st of o.states as string[])
          await tx.query(
            `INSERT INTO altphones_bpm_states (state, bpm_email, source, updated_by, approved_by, updated_at) VALUES ($1,$2,'MANUAL',$3,$4,$5)
             ON CONFLICT (state) DO UPDATE SET bpm_email = EXCLUDED.bpm_email, source = 'MANUAL', updated_by = EXCLUDED.updated_by, approved_by = EXCLUDED.approved_by, updated_at = EXCLUDED.updated_at`,
            [st, o.email, imp.created_by, actor.staffId, ctx.now],
          );
      } else if (kind === "BPM_LOCATIONS") {
        await tx.query(
          `INSERT INTO altphones_bpm_locations (location_id, bpm_email, updated_by, approved_by, updated_at) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (location_id) DO UPDATE SET bpm_email = EXCLUDED.bpm_email, updated_by = EXCLUDED.updated_by, approved_by = EXCLUDED.approved_by, updated_at = EXCLUDED.updated_at`,
          [o.locationId, o.email, imp.created_by, actor.staffId, ctx.now],
        );
      } else if (kind === "OPENING_STOCK") {
        const imeis = o.imeis as string[];
        if (imeis.length) {
          await tx.query(`INSERT INTO altphones_devices (imei, model_id, location_id, status, registered_by, registered_at) SELECT x, $2, $3, 'IN_STOCK', $4, $5 FROM unnest($1::text[]) AS x`, [imeis, o.modelId, o.locationId, ctx.actor!.staffId, ctx.now]);
        }
        await post(tx, ctx, { locationId: o.locationId as string, modelId: o.modelId as string, movement: "OPENING", physical: o.quantity as number, reserved: 0, importId: id, reference: `OPEN-${id.slice(0, 8)}-${o.row}`, note: (o.note as string | null) ?? "Opening stock (setup upload)" });
      } else if (kind === "TRANSACTIONS") {
        await insertLegacyTransaction(tx, ctx, id, settings.id, o);
      } else {
        await post(tx, ctx, { locationId: o.locationId as string, modelId: o.modelId as string, movement: o.movement as "OPENING", physical: o.physical as number, reserved: 0, importId: id, reference: o.reference as string, legacy: true, note: o.note as string | null, occurredAt: new Date(`${o.date}T12:00:00+01:00`) });
      }
      applied++;
    }
    const summary = { ...imp.summary, applied, skipped: v.skipped.length, invalidLeftOut: v.errors.length };
    await tx.query("UPDATE altphones_imports SET status = 'COMMITTED', committed_by = $2, committed_at = $3, summary = $4, decided_by = $2, decided_at = $3, skipped_invalid = $5 WHERE id = $1", [id, actor.staffId, ctx.now, JSON.stringify(summary), v.errors.length]);
    await audit(tx, ctx, { action: "ALTPHONES_IMPORT_COMMITTED", details: { kind, importId: id, ...summary } });
    return summary;
  });
}

async function insertLegacyTransaction(tx: Tx, ctx: Ctx, importId: string, settingsId: string, o: Record<string, unknown>) {
  const ref = await nextRef(tx, "altphones_ref_seq", "ALP", ctx.now);
  const at = new Date(`${o.date}T12:00:00+01:00`);
  const channel = o.originType === "ALTBOX" ? "SA" : "DO";
  const app = (
    await tx.query<{ id: string }>(
      `INSERT INTO altphones_applications (ref, kind, channel, status, settings_id, originator_id, originator_role, origin_location_id, supply_location_id, model_id, model_name,
          customer_name, customer_email, customer_phone, tenure_months, imei, completed_at, handed_over_at, legacy, legacy_ref, legacy_import_id, legacy_officer, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,true,$18,$19,$20,$21,$21) RETURNING id`,
      [
        ref,
        o.kind,
        channel,
        o.kind === "OUTRIGHT" ? "COMPLETED" : "DISBURSED",
        settingsId,
        o.officerId,
        channel === "SA" ? "SMILE_ASSOCIATE" : "DELIGHT_OFFICER",
        o.originId,
        o.supplyId,
        o.modelId,
        o.modelName,
        o.customerName,
        o.customerEmail,
        o.customerPhone,
        o.tenure,
        o.imei,
        at,
        o.reference,
        importId,
        o.officerText,
        ctx.now,
      ],
    )
  ).rows[0];
  await tx.query("INSERT INTO altphones_devices (imei, model_id, location_id, status, application_id, legacy, registered_by, registered_at, issued_at) VALUES ($1,$2,$3,'ISSUED',$4,true,$5,$6,$7)", [
    o.imei,
    o.modelId,
    o.supplyId,
    app.id,
    ctx.actor?.staffId ?? null,
    ctx.now,
    at,
  ]);
  await tx.query("INSERT INTO altphones_events (application_id, action, to_status, actor_id, details, occurred_at) VALUES ($1,'LEGACY_IMPORTED',$2,$3,$4,$5)", [
    app.id,
    o.kind === "OUTRIGHT" ? "COMPLETED" : "DISBURSED",
    ctx.actor?.staffId ?? null,
    JSON.stringify({ importId, legacyRef: o.reference }),
    ctx.now,
  ]);
}

export async function discardImport(ctx: Ctx, id: string) {
  return withTx(async (tx) => {
    await requireAdmin(tx, ctx);
    if (!isUuid(id)) throw notFound("Import not found.");
    const r = await tx.query("UPDATE altphones_imports SET status = 'DISCARDED' WHERE id = $1 AND status IN ('PREVIEW','SUBMITTED')", [id]);
    if (!r.rowCount) throw conflict("This import cannot be discarded.");
    return { ok: true };
  });
}

export async function listImports(q: Db, limit = 20) {
  return (
    await q.query(
      `SELECT i.id, i.kind, i.filename, i.status, i.summary, i.errors, i.created_at, i.committed_at, i.created_by, i.submitted_by, i.submitted_at, i.partial, i.submit_note, i.decision_note,
              s.full_name AS by_name, d.full_name AS decided_by_name
         FROM altphones_imports i LEFT JOIN staff s ON s.id = i.created_by LEFT JOIN staff d ON d.id = i.decided_by ORDER BY i.created_at DESC LIMIT $1`,
      [limit],
    )
  ).rows;
}


/** The error report for an import (row, field, error, suggested correction) as CSV. */
export async function importErrorReport(q: Db, ctx: Ctx, id: string): Promise<{ filename: string; csv: string }> {
  if (!ctx.actor) throw forbidden();
  const ok = (await holdsRole(q, ctx.actor.staffId, "SUPER_ADMIN")) || (await holdsRole(q, ctx.actor.staffId, "UNIT_HEAD"));
  if (!ok) throw forbidden();
  if (!isUuid(id)) throw notFound("Import not found.");
  const imp = (await q.query<{ filename: string; errors: { row: number; message: string; field?: string; skipped?: boolean }[] }>("SELECT filename, errors FROM altphones_imports WHERE id = $1", [id])).rows[0];
  if (!imp) throw notFound("Import not found.");
  const { errorReportCsv } = await import("@/lib/csv");
  const rows = imp.errors.map((e) => ({ row: e.row, field: e.field ?? null, message: e.skipped ? `Skipped: ${e.message}` : e.message, suggestion: e.skipped ? "No action needed: the record already exists." : null }));
  return { filename: `${imp.filename.replace(/\.[^.]+$/, "")}-errors.csv`, csv: errorReportCsv(rows) };
}

/**
 * Recompute a historical account after reconciled repayments: amount repaid, outstanding, arrears and the two
 * statuses. Fully repaid only when evidenced repayments reach the total obligation; never because a date passed.
 */
export async function recomputeHistorical(tx: Tx, accountId: string, now: Date) {
  const a = (await tx.query("SELECT * FROM altphones_historical_accounts WHERE id = $1 FOR UPDATE", [accountId])).rows[0];
  if (!a) return;
  const reconciled = Number((await tx.query<{ s: string }>("SELECT coalesce(sum(amount_kobo),0)::text AS s FROM altphones_historical_repayments WHERE account_id = $1", [accountId])).rows[0].s);
  const registerPaid = Number(a.register_repaid_kobo ?? 0);
  const repaid = registerPaid + reconciled;
  const total = a.total_obligation_kobo === null ? null : Number(a.total_obligation_kobo);
  let outstanding = total === null ? Number(a.outstanding_kobo) : Math.max(0, total - repaid);
  let arrears = 0;
  let repayment: string = a.repayment_status;
  let application: string = a.application_status;
  let status: string = a.status;
  if (total !== null && a.status !== "CANCELLED") {
    const inst = Number(a.instalment_kobo ?? 0);
    const tenor = Number(a.tenor_months ?? 0);
    let due = 0;
    if (a.start_date && inst && tenor) {
      const start = new Date(a.start_date);
      const months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth()) + 1;
      due = Math.min(Math.max(months, 0), tenor) * inst;
    }
    arrears = Math.max(0, due - repaid);
    if (repaid >= total) {
      repayment = "FULLY_REPAID";
      application = "COMPLETED";
      status = "COMPLETED";
      outstanding = 0;
    } else if (arrears > 0) {
      repayment = "OVERDUE";
      status = "IN_ARREARS";
      if (application === "UNCONFIRMED") application = "ISSUED";
    } else if (repaid > 0) {
      repayment = "ACTIVE";
      status = "CURRENT";
      if (application === "UNCONFIRMED") application = "ISSUED";
    }
  }
  await tx.query(
    `UPDATE altphones_historical_accounts SET amount_repaid_kobo = $2, outstanding_kobo = $3, arrears_kobo = $4, repayment_status = $5, application_status = $6, status = $7,
            repayment_evidence = 'RECONCILED', reconciled_at = $8, nin_enc = CASE WHEN $7 = 'COMPLETED' THEN NULL ELSE nin_enc END WHERE id = $1`,
    [accountId, repaid, outstanding, arrears, repayment, application, status, now],
  );
}
