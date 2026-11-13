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
import { REGIONS } from "../domain/roles";
import { isEmail, isImei, isTenure, normalisePhone } from "@/lib/altphones";
import { config } from "../config";
import { currentSettings, isUuid, nextRef } from "./core";
import { post } from "./stock";

export type ImportKind = "LOCATIONS" | "OFFICERS" | "OPENING_STOCK" | "TRANSACTIONS" | "STOCK";
export const IMPORT_LABELS: Record<ImportKind, string> = {
  LOCATIONS: "Branches, Shops and BOX locations",
  OFFICERS: "Delight Officers and Smile Associates",
  OPENING_STOCK: "Opening stock", TRANSACTIONS: "Historical sales and credit facilities", STOCK: "Historical stock movements" };
export const MAX_IMPORT_ROWS = 20_000;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const COLUMNS: Record<ImportKind, Record<string, string[]>> = {
  OFFICERS: {
    email: ["email", "emailaddress", "workemail"],
    fullName: ["fullname", "name", "staffname"],
    route: ["route", "role", "channel"],
    state: ["state", "region"],
    home: ["homelocation", "location", "branchorbox", "branch", "box"],
    active: ["active", "status"],
  },
  OPENING_STOCK: { location: ["location", "branchorshop"], model: ["phonemodel", "model", "phone"], quantity: ["quantity", "qty", "units"], imeis: ["imeis", "imei"], note: ["note", "notes", "source"] },
  LOCATIONS: { state: ["state"], city: ["city", "town", "towncity", "lga"], type: ["type", "locationtype", "outlettype"], name: ["name", "locationname", "outletname", "branch"], address: ["address"] },
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
  OFFICERS: ["email", "fullName", "route"],
  OPENING_STOCK: ["location", "model", "quantity"],
  LOCATIONS: ["state", "city", "type", "name"],
  TRANSACTIONS: ["reference", "type", "customerName", "model", "imei", "date", "origin", "supply"],
  STOCK: ["reference", "location", "model", "movement", "quantity", "date"],
};

export const TEMPLATES: Record<ImportKind, string> = {
  OFFICERS: "Email,Full name,Route,State,Home location,Active\r\nfirstname.lastname@altbank.ng,Firstname Lastname,Delight Officer,LAGOS,Ikeja Branch,Yes\r\nother.person@altbank.ng,Other Person,Smile Associate,LAGOS,Yaba Altbox,Yes\r\n",
  OPENING_STOCK: "Location,Phone model,Quantity,IMEIs,Note\r\nIkeja Branch,Altphone L1 Series — Black & Gold,20,,Opening count 2026-11-13\r\nYaba Altshop,Altphone L1 Series — Green,10,356938035643809;490154203237518,Delivery note 001\r\n",
  LOCATIONS: "State,City,Type,Name,Address\r\nLAGOS,Ikeja,Branch,Ikeja Branch,1 Example Road\r\nLAGOS,Yaba,Shop,Yaba Altshop,\r\nLAGOS,Yaba,BOX,Yaba Altbox,\r\n",
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

async function locationIndex(q: Db) {
  const all = (await q.query<{ id: string; name: string; outlet_type: string; state: string; city: string }>("SELECT id, name, outlet_type, state, city FROM locations WHERE active")).rows;
  const byName = new Map<string, typeof all>();
  for (const l of all) byName.set(l.name.toLowerCase(), [...(byName.get(l.name.toLowerCase()) ?? []), l]);
  return (name: string) => byName.get(name.trim().toLowerCase()) ?? [];
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
      const state = r.state.toUpperCase();
      const type = TYPE_MAP[norm(r.type)];
      if (!(REGIONS as readonly string[]).includes(state)) { err(r, `"${r.state}" is not a Nigerian state (use e.g. LAGOS, FCT (ABUJA)).`); continue; }
      if (!type) { err(r, `Type "${r.type}" must be Branch, Shop or BOX.`); continue; }
      if (r.city.length < 2 || r.name.length < 2) { err(r, "City and name are required."); continue; }
      const key = `${state}|${r.city.toLowerCase()}|${type}|${r.name.toLowerCase()}`;
      if (seen.has(key)) { err(r, `${r.name} appears more than once in the file.`); continue; }
      seen.add(key);
      const exists = (await q.query("SELECT 1 FROM locations WHERE state = $1 AND lower(city) = lower($2) AND outlet_type = $3 AND lower(name) = lower($4)", [state, r.city, type, r.name])).rowCount;
      if (exists) { skipped.push({ row: Number(r._row), message: `${r.name} already exists — skipped.` }); continue; }
      const sameName = (await q.query("SELECT state, city FROM locations WHERE lower(name) = lower($1)", [r.name])).rows[0];
      if (sameName) { err(r, `A location named "${r.name}" already exists in ${sameName.city}, ${sameName.state}. Use a distinct name.`); continue; }
      ok.push({ row: Number(r._row), state, city: r.city, type, name: r.name, address: r.address || null });
    }
  } else if (kind === "OFFICERS") {
    const loc = await locationIndex(q);
    const seen = new Set<string>();
    for (const r of rows) {
      const email = r.email.toLowerCase().replace(/^mailto:/, "");
      const routeN = norm(r.route);
      const role = ["do", "delightofficer", "delight"].includes(routeN) ? "DELIGHT_OFFICER" : ["sa", "smileassociate", "smile"].includes(routeN) ? "SMILE_ASSOCIATE" : null;
      const activeN = norm(r.active ?? "");
      const active = activeN === "" || ["yes", "y", "true", "active", "1"].includes(activeN) ? true : ["no", "n", "false", "inactive", "0"].includes(activeN) ? false : null;
      const state = (r.state ?? "").toUpperCase();
      const problems: string[] = [];
      if (!/^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) problems.push("email is not valid");
      else if (!email.endsWith(`@${config.staffEmailDomain}`)) problems.push(`email must be an @${config.staffEmailDomain} address`);
      if (r.fullName.length < 3) problems.push("full name is missing");
      if (!role) problems.push(`route "${r.route}" must be Delight Officer (DO) or Smile Associate (SA)`);
      if (active === null) problems.push("active must be Yes or No");
      if (state && !(REGIONS as readonly string[]).includes(state)) problems.push(`"${r.state}" is not a Nigerian state`);
      if (seen.has(email)) problems.push("email appears more than once in the file");
      let home: { id: string; outlet_type: string; name: string } | null = null;
      if (r.home) {
        const m = loc(r.home);
        if (m.length !== 1) problems.push(m.length ? `home location "${r.home}" matches more than one location` : `home location "${r.home}" was not found`);
        else {
          home = m[0];
          if (role === "DELIGHT_OFFICER" && home.outlet_type !== "BRANCH") problems.push("a Delight Officer's home location must be a Branch");
          if (role === "SMILE_ASSOCIATE" && home.outlet_type !== "ALTBOX") problems.push("a Smile Associate's home location must be a BOX");
        }
      }
      const staff = email ? (await q.query<{ id: string; status: string }>("SELECT id, status FROM staff WHERE email = $1", [email])).rows[0] : undefined;
      if (!staff && active) {
        const dir = (await q.query<{ active: boolean; is_group_mailbox: boolean }>("SELECT active, is_group_mailbox FROM bank_directory WHERE email = $1", [email])).rows[0];
        if (!dir || !dir.active) problems.push("not in the bank directory — staff can only be provisioned from the directory");
        else if (dir.is_group_mailbox) problems.push("group mailboxes cannot be officers");
      }
      if (staff && staff.status !== "ACTIVE" && active) problems.push("the staff record is suspended; reactivate it in Users & roles first");
      if (problems.length) {
        err(r, `${email || "Row"}: ${problems.join("; ")}.`);
        continue;
      }
      seen.add(email);
      ok.push({ row: Number(r._row), email, fullName: r.fullName.replace(/\s+/g, " ").trim(), role, active, state: state || null, homeId: home?.id ?? null, staffId: staff?.id ?? null });
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
      const bad = imeis.filter((i) => !isImei(i));
      if (bad.length) problems.push(`not 15-digit IMEIs: ${bad.slice(0, 3).join(", ")}`);
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
      if (!isImei(imei)) problems.push("IMEI must be 15 digits");
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

export async function commitImport(ctx: Ctx, id: string) {
  return withTx(async (tx) => {
    const actor = await requireAdmin(tx, ctx);
    if (!isUuid(id)) throw notFound("Import not found.");
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('altphones_import'))");
    const imp = (await tx.query("SELECT * FROM altphones_imports WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!imp) throw notFound("Import not found.");
    if (imp.status !== "PREVIEW") throw conflict("This import has already been committed or discarded.");
    const kind = imp.kind as ImportKind;
    const v = await validate(tx, kind, imp.rows as Row[]);
    if (v.errors.length) throw invalid(`The file still has ${v.errors.length} error${v.errors.length === 1 ? "" : "s"} (records may have changed since the preview). Correct the file and upload it again.`);
    const settings = await currentSettings(tx);
    let applied = 0;
    for (const o of v.ok) {
      if (kind === "LOCATIONS") {
        await tx.query("INSERT INTO locations (state, city, outlet_type, name, address, active, updated_at) VALUES ($1,$2,$3,$4,$5,true,$6)", [o.state, o.city, o.type, o.name, o.address, ctx.now]);
      } else if (kind === "OFFICERS") {
        await applyOfficer(tx, ctx, o);
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
    const summary = { ...imp.summary, applied, skipped: v.skipped.length };
    await tx.query("UPDATE altphones_imports SET status = 'COMMITTED', committed_by = $2, committed_at = $3, summary = $4 WHERE id = $1", [id, actor.staffId, ctx.now, JSON.stringify(summary)]);
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
    const r = await tx.query("UPDATE altphones_imports SET status = 'DISCARDED' WHERE id = $1 AND status = 'PREVIEW'", [id]);
    if (!r.rowCount) throw conflict("This import cannot be discarded.");
    return { ok: true };
  });
}

export async function listImports(q: Db, limit = 20) {
  return (
    await q.query(
      `SELECT i.id, i.kind, i.filename, i.status, i.summary, i.errors, i.created_at, i.committed_at, s.full_name AS by_name
         FROM altphones_imports i LEFT JOIN staff s ON s.id = i.created_by ORDER BY i.created_at DESC LIMIT $1`,
      [limit],
    )
  ).rows;
}

const ROUTE_ROLES = ["DELIGHT_OFFICER", "SMILE_ASSOCIATE"];

/** Create or update a Delight Officer / Smile Associate: the route decides which of the two roles they hold. */
async function applyOfficer(tx: Tx, ctx: Ctx, o: Record<string, unknown>) {
  let staffId = o.staffId as string | null;
  const role = o.role as string;
  if (!staffId) {
    staffId = (
      await tx.query<{ id: string }>("INSERT INTO staff (email, full_name, region, business_unit, created_by, created_at, updated_at) VALUES ($1,$2,$3,'Retail',$4,$5,$5) RETURNING id", [o.email, o.fullName, o.state, ctx.actor!.staffId, ctx.now])
    ).rows[0].id;
    await audit(tx, ctx, { action: "STAFF_PROVISIONED", actorRole: "SUPER_ADMIN", details: { staffId, email: o.email, via: "ALTPHONES_OFFICER_UPLOAD" } });
  } else if (o.state) {
    await tx.query("UPDATE staff SET region = coalesce(region, $2), updated_at = $3 WHERE id = $1", [staffId, o.state, ctx.now]);
  }
  if (staffId === ctx.actor!.staffId) throw invalid("You cannot change your own role assignments in an upload.");
  const held = (await tx.query<{ role: string }>("SELECT role FROM role_assignments WHERE staff_id = $1 AND active AND role = ANY($2)", [staffId, ROUTE_ROLES])).rows.map((r) => r.role);
  const revoke = o.active ? held.filter((r) => r !== role) : held;
  for (const r of revoke) {
    await tx.query("UPDATE role_assignments SET active = false, revoked_by = $3, revoked_at = $4 WHERE staff_id = $1 AND role = $2 AND active", [staffId, r, ctx.actor!.staffId, ctx.now]);
    await audit(tx, ctx, { action: "ROLE_REVOKED", actorRole: "SUPER_ADMIN", details: { staffId, role: r, via: "ALTPHONES_OFFICER_UPLOAD" } });
  }
  if (o.active && !held.includes(role)) {
    await tx.query("INSERT INTO role_assignments (staff_id, role, region, business_unit, granted_by, granted_at) VALUES ($1,$2,$3,'Retail',$4,$5)", [staffId, role, o.state, ctx.actor!.staffId, ctx.now]);
    await audit(tx, ctx, { action: "ROLE_GRANTED", actorRole: "SUPER_ADMIN", details: { staffId, role, via: "ALTPHONES_OFFICER_UPLOAD" } });
  }
  if (o.active && o.homeId) {
    await tx.query(
      "INSERT INTO altphones_officer_homes (staff_id, location_id, updated_by, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (staff_id) DO UPDATE SET location_id = EXCLUDED.location_id, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at",
      [staffId, o.homeId, ctx.actor!.staffId, ctx.now],
    );
  }
}
