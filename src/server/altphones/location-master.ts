/**
 * Altphones location master.
 *
 *  - The profiling workbook (DELIGHT OFFICERS = Branches, ALTBOX SAs, ALTSHOP SAs, BPMs) is the source of registered
 *    locations and addresses. Only location, state and address columns are read (and the BPM sheet's email and mapped
 *    states); no DO, SA or BPM profile is created. The original values are kept per import.
 *  - An upload is previewed and reconciled against existing locations, then applied by the PM or a Super Admin.
 *  - Missing or conflicting addresses are flagged. A new location, a missing address, or the choice between
 *    conflicting addresses goes through an address registration request that a Unit Head (not the requester) approves;
 *    approval registers the address and, for a new location, activates it.
 *  - Staff never type an address during origination: ARAF supplies it from the registered address.
 */
import ExcelJS from "exceljs";
import type { Db, Tx } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { sha256Hex } from "../crypto";
import { holdsRole } from "../domain/access";
import { normaliseNigerianState, REGIONS } from "../domain/roles";
import { enqueueEmail } from "../notify/outbox";
import { simpleEmail } from "../notify/templates";
import { config } from "../config";
import { BPM_ROLE, currentSettings, isUuid, nextRef, PM_ROLE, roleHolders } from "./core";

export type LocType = "BRANCH" | "ALTSHOP" | "ALTBOX";
export const TYPE_LABEL: Record<LocType, string> = { BRANCH: "Branch", ALTSHOP: "Altshop", ALTBOX: "Altbox" };
const MANAGERS = ["SUPER_ADMIN", PM_ROLE] as const;
const MAX_BYTES = 10 * 1024 * 1024;

const isManager = async (q: Db, staffId: string) => (await Promise.all(MANAGERS.map((r) => holdsRole(q, staffId, r)))).some(Boolean);
async function isApprover(q: Db, staffId: string) {
  if (!(await holdsRole(q, staffId, "UNIT_HEAD"))) return false;
  const uh = (await currentSettings(q)).unit_head_staff_id;
  return !uh || uh === staffId;
}
export async function locationAccess(q: Db, staffId: string) {
  const [manage, approve] = await Promise.all([isManager(q, staffId), isApprover(q, staffId)]);
  return { manage, approve, view: manage || approve };
}

const squash = (s: unknown) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
/** Words that do not identify a place ("STERLING BANK, IWO ROAD BRANCH" ≈ "IWO ROAD"). */
const NOISE = new Set(["BRANCH", "MINI", "ALTSHOP", "ALTBOX", "BOX", "SHOP", "STERLING", "BANK", "THE", "ALTERNATIVE", "ALT", "WAKEEL", "OFFICE", "HEAD", "MARKET", "ROAD", "RD", "STATE", "LGA"]);
export function placeKey(name: string, state?: string | null) {
  const stateWords = new Set((state ?? "").toUpperCase().split(/[^A-Z]+/).filter(Boolean));
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !NOISE.has(w) && !stateWords.has(w));
  return words.join(" ") || name.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}
const sameAddress = (a: string, b: string) => a.toUpperCase().replace(/[^A-Z0-9]+/g, "") === b.toUpperCase().replace(/[^A-Z0-9]+/g, "");

// ------------------------------------------------------------------ reading the workbook

export interface ProfilingEntry {
  type: LocType;
  sheet: string;
  sourceState: string;
  sourceName: string;
  labels: { state: string; name: string }[];
  state: string | null;
  rows: number;
  addresses: string[]; // distinct original values, as written (outer whitespace trimmed)
}
export interface ProfilingBpm {
  email: string;
  statesLabel: string;
  states: string[];
  unknown: string[];
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return cellText(o.result);
    if ("richText" in o) return (o.richText as { text: string }[]).map((x) => x.text).join("");
    if ("text" in o) return String(o.text ?? "");
    if ("hyperlink" in o) return String(o.hyperlink).replace(/^mailto:/i, "");
  }
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
}
const sheetType = (name: string, headers: string[]): LocType | "BPM" | null => {
  const n = name.toUpperCase();
  if (/BPM/.test(n)) return "BPM";
  if (/ALTBOX|\bBOX/.test(n)) return "ALTBOX";
  if (/ALTSHOP|SHOP/.test(n)) return "ALTSHOP";
  if (/DELIGHT|\bDO/.test(n) || headers.includes("dos")) return "BRANCH";
  return null;
};
const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, "");

/** BPM coverage such as "Abuja, Niger, Plateau and Nasarawa" or "Edo, Port Harcourt and Uyo". */
export function parseStatesList(label: string) {
  const parts = label
    .split(/,|\band\b|&|\//i)
    .map((x) => x.trim())
    .filter(Boolean);
  const states: string[] = [];
  const unknown: string[] = [];
  for (const p of parts) {
    const s = normaliseNigerianState(p);
    if (s) states.push(s);
    else unknown.push(p);
  }
  return { states: [...new Set(states)], unknown };
}

export async function readProfiling(data: Buffer): Promise<{ entries: ProfilingEntry[]; bpms: ProfilingBpm[]; sheets: { name: string; type: string | null; rows: number }[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const groups = new Map<string, ProfilingEntry>();
  const bpms: ProfilingBpm[] = [];
  const sheets: { name: string; type: string | null; rows: number }[] = [];
  for (const ws of wb.worksheets) {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const v: string[] = [];
      for (let i = 1; i <= r.cellCount; i++) v.push(cellText(r.getCell(i).value));
      if (v.some((x) => x.trim())) rows.push(v);
    });
    if (!rows.length) continue;
    const hdr = rows[0].map(norm);
    const type = sheetType(ws.name, hdr);
    sheets.push({ name: ws.name, type, rows: rows.length - 1 });
    if (type === "BPM") {
      const ei = hdr.findIndex((h) => h.includes("email"));
      const mi = hdr.findIndex((h) => h.includes("mapped") || h.includes("state"));
      if (ei < 0 || mi < 0) continue;
      for (const r of rows.slice(1)) {
        const email = squash(r[ei]).toLowerCase();
        const label = squash(r[mi]);
        if (!email || !label) continue;
        bpms.push({ email, statesLabel: label, ...parseStatesList(label) });
      }
      continue;
    }
    if (!type) continue;
    const li = hdr.indexOf("location");
    const si = hdr.indexOf("state");
    const ai = hdr.findIndex((h) => h.startsWith("address"));
    if (li < 0 || si < 0) continue;
    for (const r of rows.slice(1)) {
      const name = squash(r[li]).toUpperCase();
      const srcState = squash(r[si]).toUpperCase();
      if (!name) continue;
      const state = normaliseNigerianState(srcState);
      const key = `${type}|${state ?? srcState}|${placeKey(name, state)}`;
      const address = ai >= 0 ? String(r[ai] ?? "").trim() : "";
      const g = groups.get(key) ?? { type, sheet: ws.name, sourceState: srcState, sourceName: name, labels: [], state, rows: 0, addresses: [] };
      g.rows++;
      if (!g.labels.some((l) => l.state === srcState && l.name === name)) g.labels.push({ state: srcState, name });
      if (address && !g.addresses.some((a) => sameAddress(a, address))) g.addresses.push(address);
      groups.set(key, g);
    }
  }
  return { entries: [...groups.values()], bpms, sheets };
}

// ------------------------------------------------------------------ preview and apply

interface LocRow {
  id: string;
  name: string;
  state: string;
  outlet_type: LocType;
  address: string | null;
  address_status: string;
  labels: string[];
}
async function locationIndex(q: Db) {
  const rows = (
    await q.query<LocRow>(
      `SELECT l.id, l.name, l.state, l.outlet_type, l.address, l.address_status,
              array_remove(array_cat(ARRAY[upper(l.name), upper(coalesce(l.source_name, ''))], coalesce(array_agg(a.label) FILTER (WHERE a.label IS NOT NULL), '{}')), '') AS labels
         FROM locations l LEFT JOIN altphones_location_aliases a ON a.location_id = l.id GROUP BY l.id`,
    )
  ).rows;
  return (e: ProfilingEntry): { loc: LocRow | null; typeConflict: string | null } => {
    if (!e.state) return { loc: null, typeConflict: null };
    const key = placeKey(e.sourceName, e.state);
    const words = new Set(key.split(" "));
    const names = new Set(e.labels.map((l) => l.name));
    const inState = rows.filter((l) => l.state === e.state);
    const exact = inState.filter((l) => l.labels.some((x) => names.has(x)) || l.labels.some((x) => placeKey(x, l.state) === key));
    const same = exact.filter((l) => l.outlet_type === e.type);
    if (same.length === 1) return { loc: same[0], typeConflict: null };
    if (same.length > 1) return { loc: null, typeConflict: `Matches ${same.length} ${TYPE_LABEL[e.type]} locations: link the right one by hand.` };
    // Similar name: every word of the shorter name appears in the longer one ("EFFURUN" / "EFFURUN WARRI"); unique only.
    const similar = inState.filter((l) => l.outlet_type === e.type && l.labels.some((x) => {
      const w = placeKey(x, l.state).split(" ");
      const lw = new Set(w);
      return (w.length && w.every((t) => words.has(t))) || [...words].every((t) => lw.has(t));
    }));
    if (similar.length === 1) return { loc: similar[0], typeConflict: `Matched by similar name to ${similar[0].name}: check it is the same place.` };
    // The same place under another type is never merged automatically: it is created as new and flagged.
    const other = exact.filter((l) => l.outlet_type !== e.type);
    if (other.length) return { loc: null, typeConflict: `${other[0].outlet_type === "BRANCH" ? "A" : "An"} ${TYPE_LABEL[other[0].outlet_type]} with this name exists (${other[0].name}). Link it by hand if it is the same place.` };
    return { loc: null, typeConflict: null };
  };
}

function addressOutcome(e: ProfilingEntry, loc: LocRow | null) {
  if (loc && loc.address_status === "REGISTERED" && loc.address) return e.addresses.length === 1 && sameAddress(e.addresses[0], loc.address) ? "KEPT_EXISTING" : e.addresses.length ? "DIFFERS_FROM_EXISTING" : "KEPT_EXISTING";
  return e.addresses.length === 1 ? "REGISTERED" : e.addresses.length === 0 ? "MISSING" : "CONFLICT";
}

/** Upload the profiling workbook: stage every entry with its reconciliation outcome. Nothing changes yet. */
export async function previewProfiling(ctx: Ctx, p: { filename: string; data: Buffer }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!(await isManager(db, actor.staffId))) throw forbidden("Only the Altphones Product Manager or a Super Admin can import locations.");
  if (!p.data?.length) throw invalid("Choose the profiling workbook.", { file: "Choose a file." });
  if (p.data.length > MAX_BYTES) throw invalid("The workbook is larger than 10 MB.", { file: "The file is too large." });
  if (p.data.subarray(0, 4).toString("binary") !== "PK\u0003\u0004") throw invalid("Upload the profiling workbook as an Excel .xlsx file.", { file: "Upload an .xlsx file." });
  let parsed: Awaited<ReturnType<typeof readProfiling>>;
  try {
    parsed = await readProfiling(p.data);
  } catch {
    throw invalid("The workbook could not be read. Save it again from Excel as .xlsx.", { file: "The workbook could not be read." });
  }
  if (!parsed.entries.length) throw invalid("No locations were found. The workbook needs Delight Officer, Altbox and Altshop sheets with Location and State columns.");
  const sha = sha256Hex(p.data);
  return withTx(async (tx) => {
    const dup = (await tx.query<{ ref: string; status: string }>("SELECT ref, status FROM altphones_location_imports WHERE sha256 = $1", [sha])).rows[0];
    if (dup) throw conflict(`This workbook was already uploaded as ${dup.ref} (${dup.status.toLowerCase()}).`);
    const open = (await tx.query<{ ref: string }>("SELECT ref FROM altphones_location_imports WHERE status = 'PREVIEW'")).rows[0];
    if (open) throw conflict(`Import ${open.ref} is still being reviewed. Apply or discard it first.`);
    const ref = await nextRef(tx, "altphones_location_import_seq", "LOC", ctx.now);
    const imp = (await tx.query<{ id: string }>("INSERT INTO altphones_location_imports (ref, filename, sha256, created_by, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id", [ref, p.filename.slice(0, 200), sha, actor.staffId, ctx.now])).rows[0];
    for (const e of parsed.entries)
      await tx.query(
        `INSERT INTO altphones_location_sources (import_id, sheet, location_type, source_state, source_name, labels, state, rows, addresses, outcome, address_outcome)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'NEW','MISSING')`,
        [imp.id, e.sheet, e.type, e.sourceState, e.sourceName, JSON.stringify(e.labels), e.state, e.rows, JSON.stringify(e.addresses)],
      );
    const summary = await reconcileImport(tx, imp.id, parsed);
    await audit(tx, ctx, { action: "ALTPHONES_LOCATIONS_PREVIEWED", details: { ref, filename: p.filename, entries: parsed.entries.length, sheets: parsed.sheets } });
    return { id: imp.id, ref, summary };
  });
}

type Parsed = Awaited<ReturnType<typeof readProfiling>>;
/** Recompute every entry's outcome against current locations (re-run after the PM links an entry by hand). */
async function reconcileImport(tx: Tx, importId: string, parsed?: Parsed) {
  const find = await locationIndex(tx);
  const sources = (await tx.query("SELECT * FROM altphones_location_sources WHERE import_id = $1", [importId])).rows;
  const byId = new Map((await tx.query<LocRow>("SELECT id, name, state, outlet_type, address, address_status, ARRAY[]::text[] AS labels FROM locations")).rows.map((l) => [l.id, l]));
  for (const s of sources) {
    const e: ProfilingEntry = { type: s.location_type, sheet: s.sheet, sourceState: s.source_state, sourceName: s.source_name, labels: s.labels, state: s.state, rows: s.rows, addresses: s.addresses };
    const manual = s.location_id && s.outcome === "MATCHED" && s.type_conflict === "linked by hand";
    const m = manual ? { loc: byId.get(s.location_id) ?? null, typeConflict: "linked by hand" } : find(e);
    const outcome = !e.state ? "UNKNOWN_STATE" : m.loc ? "MATCHED" : "NEW";
    await tx.query("UPDATE altphones_location_sources SET outcome = $2, location_id = $3, type_conflict = $4, address_outcome = $5 WHERE id = $1", [s.id, outcome, m.loc?.id ?? null, m.typeConflict, addressOutcome(e, m.loc)]);
  }
  const summary = await importSummary(tx, importId, parsed?.bpms);
  await tx.query("UPDATE altphones_location_imports SET summary = $2 WHERE id = $1", [importId, JSON.stringify(summary)]);
  return summary;
}

export interface ImportSummary {
  byType: { type: LocType; entries: number; matched: number; new: number; unknownState: number; registered: number; missing: number; conflict: number; differs: number; typeConflicts: number }[];
  bpms: { email: string; statesLabel: string; states: string[]; unknown: string[]; staff: string | null; ready: boolean; problem: string | null }[];
  statesWithoutBpm: string[];
}

async function importSummary(q: Db, importId: string, bpmsIn?: ProfilingBpm[]): Promise<ImportSummary> {
  const prev = (await q.query<{ summary: ImportSummary | null }>("SELECT summary FROM altphones_location_imports WHERE id = $1", [importId])).rows[0]?.summary;
  const byType = (
    await q.query(
      `SELECT location_type AS type, count(*)::int AS entries,
              count(*) FILTER (WHERE outcome = 'MATCHED')::int AS matched, count(*) FILTER (WHERE outcome = 'NEW')::int AS new, count(*) FILTER (WHERE outcome = 'UNKNOWN_STATE')::int AS unknown_state,
              count(*) FILTER (WHERE address_outcome = 'REGISTERED')::int AS registered, count(*) FILTER (WHERE address_outcome = 'MISSING')::int AS missing,
              count(*) FILTER (WHERE address_outcome = 'CONFLICT')::int AS conflict, count(*) FILTER (WHERE address_outcome = 'DIFFERS_FROM_EXISTING')::int AS differs,
              count(*) FILTER (WHERE type_conflict IS NOT NULL AND type_conflict <> 'linked by hand')::int AS type_conflicts
         FROM altphones_location_sources WHERE import_id = $1 GROUP BY 1 ORDER BY array_position(ARRAY['BRANCH','ALTSHOP','ALTBOX'], location_type)`,
      [importId],
    )
  ).rows.map((r) => ({ type: r.type, entries: r.entries, matched: r.matched, new: r.new, unknownState: r.unknown_state, registered: r.registered, missing: r.missing, conflict: r.conflict, differs: r.differs, typeConflicts: r.type_conflicts }));
  const raw = bpmsIn ?? prev?.bpms ?? [];
  const bpms = [];
  for (const b of raw) {
    const st = (await q.query<{ id: string; full_name: string }>("SELECT id, full_name FROM staff WHERE lower(email) = $1 AND status = 'ACTIVE'", [b.email])).rows[0];
    const role = st ? await holdsRole(q, st.id, BPM_ROLE) : false;
    bpms.push({ email: b.email, statesLabel: b.statesLabel, states: b.states, unknown: b.unknown, staff: st?.full_name ?? null, ready: Boolean(st && role), problem: !st ? "Not set up in ARAF yet (no staff record with this email)." : !role ? "Has no Business Performance Manager role." : null });
  }
  const covered = new Set(bpms.flatMap((b) => b.states));
  const saStates = (await q.query<{ state: string }>("SELECT DISTINCT state FROM altphones_location_sources WHERE import_id = $1 AND location_type IN ('ALTSHOP','ALTBOX') AND state IS NOT NULL ORDER BY 1", [importId])).rows.map((r) => r.state);
  return { byType, bpms, statesWithoutBpm: saStates.filter((s) => !covered.has(s)) };
}

/** Link a workbook entry to an existing location by hand (or clear the link so it is created as new). */
export async function linkSource(ctx: Ctx, sourceId: string, locationId: string | null) {
  if (!isUuid(sourceId)) throw notFound();
  return withTx(async (tx) => {
    const s = (await tx.query("SELECT s.*, i.status, i.ref FROM altphones_location_sources s JOIN altphones_location_imports i ON i.id = s.import_id WHERE s.id = $1", [sourceId])).rows[0];
    if (!s) throw notFound();
    if (!(await isManager(tx, ctx.actor!.staffId))) throw forbidden();
    if (s.status !== "PREVIEW") throw conflict(`${s.ref} has already been ${s.status.toLowerCase()}.`);
    if (locationId) {
      if (!isUuid(locationId)) throw invalid("Choose a location.");
      const l = (await tx.query("SELECT id, state FROM locations WHERE id = $1", [locationId])).rows[0];
      if (!l) throw invalid("Choose a location.");
      await tx.query("UPDATE altphones_location_sources SET outcome = 'MATCHED', location_id = $2, type_conflict = 'linked by hand' WHERE id = $1", [sourceId, locationId]);
    } else await tx.query("UPDATE altphones_location_sources SET outcome = 'NEW', location_id = NULL, type_conflict = NULL WHERE id = $1", [sourceId]);
    await audit(tx, ctx, { action: "ALTPHONES_LOCATION_SOURCE_LINKED", details: { ref: s.ref, entry: `${s.source_state} / ${s.source_name}`, locationId } });
    return reconcileImport(tx, s.import_id);
  });
}

export async function discardProfiling(ctx: Ctx, importId: string) {
  if (!isUuid(importId)) throw notFound();
  return withTx(async (tx) => {
    if (!(await isManager(tx, ctx.actor!.staffId))) throw forbidden();
    const imp = (await tx.query("SELECT ref, status FROM altphones_location_imports WHERE id = $1 FOR UPDATE", [importId])).rows[0];
    if (!imp) throw notFound();
    if (imp.status !== "PREVIEW") throw conflict(`${imp.ref} has already been ${imp.status.toLowerCase()}.`);
    await tx.query("UPDATE altphones_location_imports SET status = 'DISCARDED' WHERE id = $1", [importId]);
    await audit(tx, ctx, { action: "ALTPHONES_LOCATIONS_DISCARDED", details: { ref: imp.ref } });
    return { ref: imp.ref };
  });
}

/**
 * Apply a previewed import: register addresses on matched locations that have none, create new locations (active only
 * when exactly one address was supplied), keep every original label as a register label, and record the BPM map.
 * Locations with a missing or conflicting address are flagged for an address registration request.
 */
export async function applyProfiling(ctx: Ctx, importId: string) {
  if (!isUuid(importId)) throw notFound();
  return withTx(async (tx) => {
    const actor = ctx.actor!;
    if (!(await isManager(tx, actor.staffId))) throw forbidden("Only the Altphones Product Manager or a Super Admin can import locations.");
    const imp = (await tx.query("SELECT * FROM altphones_location_imports WHERE id = $1 FOR UPDATE", [importId])).rows[0];
    if (!imp) throw notFound();
    if (imp.status !== "PREVIEW") throw conflict(`${imp.ref} has already been ${imp.status.toLowerCase()}.`);
    const summary = await reconcileImport(tx, importId);
    const sources = (await tx.query("SELECT * FROM altphones_location_sources WHERE import_id = $1 AND outcome <> 'UNKNOWN_STATE' ORDER BY location_type, state, source_name", [importId])).rows;
    let created = 0;
    let registered = 0;
    let flagged = 0;
    for (const s of sources) {
      let locId: string = s.location_id;
      const single: string | null = s.addresses.length === 1 ? s.addresses[0] : null;
      if (s.outcome === "NEW") {
        const status = single ? "REGISTERED" : s.addresses.length ? "REVIEW" : "MISSING";
        const ins = await tx.query<{ id: string }>(
          `INSERT INTO locations (state, city, outlet_type, name, address, active, source_name, source_state, source_type, address_status, address_source, address_registered_at, address_registered_by, created_by, created_at, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$4,$7,$8,$9,$10,$11,$12,$12,$11,$12,$11)
           ON CONFLICT (state, city, outlet_type, name) DO NOTHING RETURNING id`,
          [s.state, titleCase(s.source_state) || titleCase(s.state), s.location_type, s.source_name, single, Boolean(single), s.source_state, s.sheet, status, single ? "PROFILING_WORKBOOK" : null, ctx.now, actor.staffId],
        );
        if (!ins.rows[0]) continue; // created by an earlier entry with the same name
        locId = ins.rows[0].id;
        created++;
        if (single) registered++;
        else flagged++;
        await tx.query("UPDATE altphones_location_sources SET location_id = $2 WHERE id = $1", [s.id, locId]);
      } else if (s.address_outcome === "REGISTERED") {
        await tx.query("UPDATE locations SET address = $2, address_status = 'REGISTERED', address_source = 'PROFILING_WORKBOOK', address_registered_at = $3, address_registered_by = $4, updated_by = $4, updated_at = $3 WHERE id = $1", [locId, single, ctx.now, actor.staffId]);
        registered++;
      } else if (s.address_outcome === "CONFLICT" || s.address_outcome === "MISSING") {
        await tx.query("UPDATE locations SET address_status = $2 WHERE id = $1 AND address_status <> 'REGISTERED'", [locId, s.address_outcome === "CONFLICT" ? "REVIEW" : "MISSING"]);
        flagged++;
      }
      // Keep every original label so registers and later files match this location.
      for (const l of s.labels as { name: string }[])
        await tx.query("INSERT INTO altphones_location_aliases (label, location_id, created_by, created_at) SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM locations WHERE id = $2 AND upper(name) = $1) ON CONFLICT (label) DO NOTHING", [l.name.toUpperCase(), locId, actor.staffId, ctx.now]);
    }
    // BPM map by state (first BPM listed for a state wins; duplicates are reported in the summary).
    let bpmStates = 0;
    const seen = new Set<string>();
    for (const b of summary.bpms)
      for (const st of b.states) {
        if (seen.has(st)) continue;
        seen.add(st);
        await tx.query(
          `INSERT INTO altphones_bpm_states (state, bpm_email, source, updated_by, updated_at) VALUES ($1,$2,'PROFILING_WORKBOOK',$3,$4)
           ON CONFLICT (state) DO UPDATE SET bpm_email = EXCLUDED.bpm_email, source = EXCLUDED.source, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
          [st, b.email, actor.staffId, ctx.now],
        );
        bpmStates++;
      }
    await tx.query("UPDATE altphones_location_imports SET status = 'APPLIED', applied_by = $2, applied_at = $3 WHERE id = $1", [importId, actor.staffId, ctx.now]);
    await audit(tx, ctx, { action: "ALTPHONES_LOCATIONS_IMPORTED", details: { ref: imp.ref, created, registered, flagged, bpmStates } });
    return { ref: imp.ref, created, registered, flagged, bpmStates };
  });
}

// ------------------------------------------------------------------ BPM mapping

export interface BpmRoute {
  id: string | null;
  name: string | null;
  email: string | null;
  problem: string | null;
}
/** The BPM mapped to a location (through its state). */
export async function bpmForLocation(q: Db, locationId: string | null): Promise<BpmRoute> {
  if (!locationId) return { id: null, name: null, email: null, problem: "No operating location is selected." };
  const l = (await q.query<{ state: string; name: string }>("SELECT state, name FROM locations WHERE id = $1", [locationId])).rows[0];
  if (!l) return { id: null, name: null, email: null, problem: "The location was not found." };
  // A mapping for the location itself takes precedence over the state's.
  const m =
    (await q.query<{ bpm_email: string }>("SELECT bpm_email FROM altphones_bpm_locations WHERE location_id = $1", [locationId])).rows[0] ??
    (await q.query<{ bpm_email: string }>("SELECT bpm_email FROM altphones_bpm_states WHERE state = $1", [l.state])).rows[0];
  if (!m) return { id: null, name: null, email: null, problem: `No Business Performance Manager is mapped to ${l.name} (${l.state}). The Altphones Product Manager must request a mapping and the Unit Head approve it before sales here can be submitted.` };
  const st = (await q.query<{ id: string; full_name: string }>("SELECT id, full_name FROM staff WHERE lower(email) = $1 AND status = 'ACTIVE'", [m.bpm_email])).rows[0];
  if (!st) return { id: null, name: null, email: m.bpm_email, problem: `The Business Performance Manager mapped to ${l.state} (${m.bpm_email}) is not set up in ARAF.` };
  if (!(await holdsRole(q, st.id, BPM_ROLE))) return { id: null, name: st.full_name, email: m.bpm_email, problem: `${st.full_name}, mapped to ${l.state}, does not hold the Business Performance Manager role.` };
  return { id: st.id, name: st.full_name, email: m.bpm_email, problem: null };
}

/** Request a BPM mapping for a state or one location (or its removal: email blank). Takes effect when a Unit Head approves. */
export async function requestBpmMapping(ctx: Ctx, p: { scope: string; state?: string; locationId?: string; email: string; note?: string }) {
  return withTx(async (tx) => {
    if (!(await isManager(tx, ctx.actor!.staffId))) throw forbidden("Only the Altphones Product Manager or a Super Admin can request a BPM mapping.");
    const e: Record<string, string> = {};
    let state: string | null = null;
    let loc: { id: string; name: string; state: string; outlet_type: string } | null = null;
    if (p.scope === "STATE") {
      state = normaliseNigerianState(p.state ?? "");
      if (!state) e.state = "Choose a state.";
    } else if (p.scope === "LOCATION") {
      loc = isUuid(p.locationId ?? "") ? ((await tx.query("SELECT id, name, state, outlet_type FROM locations WHERE id = $1", [p.locationId])).rows[0] ?? null) : null;
      if (!loc) e.locationId = "Choose a location.";
      else if (!["ALTSHOP", "ALTBOX"].includes(loc.outlet_type)) e.locationId = "Only Altshops and Altboxes are routed to a BPM; Branch sales go to the Product Manager.";
    } else e.scope = "Choose a state or a location.";
    const email = (p.email ?? "").trim().toLowerCase();
    let bpmName: string | null = null;
    if (email) {
      const st = (await tx.query<{ id: string; full_name: string }>("SELECT id, full_name FROM staff WHERE lower(email) = $1 AND status = 'ACTIVE'", [email])).rows[0];
      if (!st || !(await holdsRole(tx, st.id, BPM_ROLE))) e.email = "Choose an active Business Performance Manager.";
      else bpmName = st.full_name;
    }
    const note = (p.note ?? "").trim().slice(0, 500);
    if (note.length < 5) e.note = "Say why (shown to the Unit Head).";
    if (Object.keys(e).length) throw invalid("Check the BPM mapping.", e);
    const open = (
      await tx.query<{ ref: string }>(
        loc ? "SELECT ref FROM altphones_bpm_requests WHERE status = 'PENDING' AND scope = 'LOCATION' AND location_id = $1" : "SELECT ref FROM altphones_bpm_requests WHERE status = 'PENDING' AND scope = 'STATE' AND state = $1",
        [loc ? loc.id : state],
      )
    ).rows[0];
    if (open) throw conflict(`Mapping request ${open.ref} for ${loc ? loc.name : state} is still awaiting the Unit Head.`);
    const ref = await nextRef(tx, "altphones_bpm_request_seq", "BPM", ctx.now);
    await tx.query("INSERT INTO altphones_bpm_requests (ref, scope, state, location_id, bpm_email, note, requested_by, requested_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
      ref,
      p.scope,
      loc ? loc.state : state,
      loc?.id ?? null,
      email || null,
      note,
      ctx.actor!.staffId,
      ctx.now,
    ]);
    const what = loc ? `${loc.name} (${loc.state})` : `all Altshops and Altboxes in ${state}`;
    await audit(tx, ctx, { action: "ALTPHONES_BPM_MAPPING_REQUESTED", details: { ref, scope: p.scope, target: what, bpm: email || null, note } });
    const uh = (await currentSettings(tx)).unit_head_staff_id;
    const to = (await roleHolders(tx, ["UNIT_HEAD"])).filter((a) => (!uh || a.id === uh) && a.id !== ctx.actor!.staffId);
    if (to.length)
      await enqueueEmail(tx, ctx.now, {
        kind: "ALTPHONES_BPM_MAPPING_REQUESTED",
        dedupeKey: `altphones:bpm-map:${ref}`,
        to: to.map((a) => a.email),
        subject: `[${ref}] Altphones BPM mapping awaiting your approval`,
        text: simpleEmail([`${ctx.actor!.name} asked to ${email ? `route ${what} to ${bpmName} (${email})` : `remove the BPM mapping for ${what}`}.`, `Reason: ${note}`, "", `Approve or reject it (sign-in required): ${config.appUrl}/altphones/locations?tab=requests`]),
      });
    return { ref };
  });
}

export async function decideBpmRequest(ctx: Ctx, id: string, p: { decision: string; note?: string }) {
  if (!isUuid(id)) throw notFound();
  return withTx(async (tx) => {
    const actor = ctx.actor!;
    if (!(await isApprover(tx, actor.staffId))) throw forbidden("Only the Altphones Unit Head can approve a BPM mapping.");
    const r = (await tx.query("SELECT * FROM altphones_bpm_requests WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!r) throw notFound();
    if (r.status !== "PENDING") throw conflict(`${r.ref} has already been decided.`);
    if (r.requested_by === actor.staffId) throw forbidden("You requested this mapping, so another approver must decide it.");
    const note = (p.note ?? "").trim().slice(0, 500);
    if (p.decision === "REJECT") {
      if (note.length < 5) throw invalid("Say why the mapping is rejected.", { note: "Give a reason." });
      await tx.query("UPDATE altphones_bpm_requests SET status = 'REJECTED', decided_by = $2, decided_at = $3, decision_note = $4 WHERE id = $1", [id, actor.staffId, ctx.now, note]);
      await audit(tx, ctx, { action: "ALTPHONES_BPM_MAPPING_REJECTED", details: { ref: r.ref, note } });
      return { ref: r.ref, approved: false };
    }
    if (p.decision !== "APPROVE") throw invalid("Choose approve or reject.");
    if (r.bpm_email) {
      // Re-check the BPM is still an active BPM at approval time.
      const st = (await tx.query<{ id: string }>("SELECT id FROM staff WHERE lower(email) = $1 AND status = 'ACTIVE'", [r.bpm_email])).rows[0];
      if (!st || !(await holdsRole(tx, st.id, BPM_ROLE))) throw conflict(`${r.bpm_email} is no longer an active Business Performance Manager. Reject this request.`);
    }
    if (r.scope === "STATE") {
      if (r.bpm_email)
        await tx.query(
          `INSERT INTO altphones_bpm_states (state, bpm_email, source, updated_by, approved_by, updated_at) VALUES ($1,$2,'MANUAL',$3,$4,$5)
           ON CONFLICT (state) DO UPDATE SET bpm_email = EXCLUDED.bpm_email, source = 'MANUAL', updated_by = EXCLUDED.updated_by, approved_by = EXCLUDED.approved_by, updated_at = EXCLUDED.updated_at`,
          [r.state, r.bpm_email, r.requested_by, actor.staffId, ctx.now],
        );
      else await tx.query("DELETE FROM altphones_bpm_states WHERE state = $1", [r.state]);
    } else if (r.bpm_email)
      await tx.query(
        `INSERT INTO altphones_bpm_locations (location_id, bpm_email, updated_by, approved_by, updated_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (location_id) DO UPDATE SET bpm_email = EXCLUDED.bpm_email, updated_by = EXCLUDED.updated_by, approved_by = EXCLUDED.approved_by, updated_at = EXCLUDED.updated_at`,
        [r.location_id, r.bpm_email, r.requested_by, actor.staffId, ctx.now],
      );
    else await tx.query("DELETE FROM altphones_bpm_locations WHERE location_id = $1", [r.location_id]);
    await tx.query("UPDATE altphones_bpm_requests SET status = 'APPROVED', decided_by = $2, decided_at = $3, decision_note = $4 WHERE id = $1", [id, actor.staffId, ctx.now, note || null]);
    await audit(tx, ctx, { action: "ALTPHONES_BPM_MAPPING_APPROVED", details: { ref: r.ref, scope: r.scope, state: r.state, locationId: r.location_id, bpm: r.bpm_email } });
    return { ref: r.ref, approved: true };
  });
}

export async function bpmRequests(q: Db, status = "PENDING") {
  return (
    await q.query(
      `SELECT r.*, l.name AS location_name, l.outlet_type, s.full_name AS requested_by_name, d.full_name AS decided_by_name, b.full_name AS bpm_name
         FROM altphones_bpm_requests r LEFT JOIN locations l ON l.id = r.location_id JOIN staff s ON s.id = r.requested_by
         LEFT JOIN staff d ON d.id = r.decided_by LEFT JOIN staff b ON lower(b.email) = r.bpm_email
        WHERE ($1 = 'ALL' OR r.status = $1) ORDER BY r.requested_at DESC LIMIT 200`,
      [status],
    )
  ).rows;
}

// ------------------------------------------------------------------ address registration

export type AddressBasis = "NEW_LOCATION" | "MISSING_ADDRESS" | "CONFLICT_CHOICE" | "CORRECTION";

async function notifyApprovers(tx: Tx, ctx: Ctx, ref: string, lines: string[]) {
  const uh = (await currentSettings(tx)).unit_head_staff_id;
  const to = (await roleHolders(tx, ["UNIT_HEAD"])).filter((a) => (!uh || a.id === uh) && a.id !== ctx.actor!.staffId);
  if (to.length) await enqueueEmail(tx, ctx.now, { kind: "ALTPHONES_ADDRESS_REQUESTED", dedupeKey: `altphones:address:${ref}`, to: to.map((a) => a.email), subject: `[${ref}] Altphones location address awaiting your approval`, text: simpleEmail([...lines, "", `Approve or reject it (sign-in required): ${config.appUrl}/altphones/locations?tab=requests`]) });
}

/** Original workbook addresses recorded for a location (for choosing between conflicting values). */
export async function recordedAddresses(q: Db, locationId: string): Promise<string[]> {
  const rows = (await q.query<{ addresses: string[] }>("SELECT s.addresses FROM altphones_location_sources s JOIN altphones_location_imports i ON i.id = s.import_id WHERE s.location_id = $1 AND i.status = 'APPLIED' ORDER BY i.applied_at DESC", [locationId])).rows;
  const out: string[] = [];
  for (const r of rows) for (const a of r.addresses) if (!out.some((x) => sameAddress(x, a))) out.push(a);
  return out;
}

export async function requestAddress(ctx: Ctx, p: { locationId: string; address?: string; choice?: string; note?: string }) {
  if (!isUuid(p.locationId)) throw notFound("Location not found.");
  return withTx(async (tx) => {
    if (!(await isManager(tx, ctx.actor!.staffId))) throw forbidden("Only the Altphones Product Manager or a Super Admin can request an address registration.");
    const l = (await tx.query("SELECT id, name, state, outlet_type, address, address_status, active FROM locations WHERE id = $1 FOR UPDATE", [p.locationId])).rows[0];
    if (!l) throw notFound("Location not found.");
    const recorded = await recordedAddresses(tx, l.id);
    let address = "";
    let basis: AddressBasis;
    if (p.choice !== undefined && p.choice !== "") {
      const i = Number(p.choice);
      if (!Number.isInteger(i) || !recorded[i]) throw invalid("Choose one of the recorded addresses.", { choice: "Choose an address." });
      address = recorded[i];
      basis = "CONFLICT_CHOICE";
    } else {
      address = (p.address ?? "").replace(/\s+/g, " ").trim();
      if (address.length < 10) throw invalid("Enter the full registered address (at least 10 characters).", { address: "Enter the full address." });
      basis = l.address_status === "REGISTERED" ? "CORRECTION" : l.active ? "MISSING_ADDRESS" : "NEW_LOCATION";
    }
    const note = (p.note ?? "").trim().slice(0, 500);
    if ((basis === "CORRECTION" || basis === "CONFLICT_CHOICE") && note.length < 5) throw invalid("Say why this address is the right one.", { note: "Give a reason." });
    const open = (await tx.query("SELECT ref FROM altphones_address_requests WHERE location_id = $1 AND status = 'PENDING'", [l.id])).rows[0];
    if (open) throw conflict(`Address request ${open.ref} for ${l.name} is still awaiting the Unit Head.`);
    const ref = await nextRef(tx, "altphones_address_request_seq", "ADR", ctx.now);
    await tx.query("INSERT INTO altphones_address_requests (ref, location_id, address, basis, activate, note, requested_by, requested_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
      ref,
      l.id,
      address,
      basis,
      !l.active,
      note || null,
      ctx.actor!.staffId,
      ctx.now,
    ]);
    await audit(tx, ctx, { action: "ALTPHONES_ADDRESS_REQUESTED", details: { ref, location: l.name, state: l.state, basis, activate: !l.active } });
    await notifyApprovers(tx, ctx, ref, [`${ctx.actor!.name} asked to register the address of ${l.name} (${l.state}):`, address]);
    return { ref };
  });
}

/** A new location: created inactive, with an address registration request; it is activated when a Unit Head approves. */
export async function proposeLocation(ctx: Ctx, p: { state: string; type: string; name: string; address: string; note?: string }) {
  return withTx(async (tx) => {
    if (!(await isManager(tx, ctx.actor!.staffId))) throw forbidden("Only the Altphones Product Manager or a Super Admin can add a location.");
    const e: Record<string, string> = {};
    const state = (REGIONS as readonly string[]).includes(p.state) ? p.state : null;
    if (!state) e.state = "Choose a state.";
    if (!["BRANCH", "ALTSHOP", "ALTBOX"].includes(p.type)) e.type = "Choose the location type.";
    const name = (p.name ?? "").replace(/\s+/g, " ").trim().toUpperCase();
    if (name.length < 3) e.name = "Enter the location name.";
    const address = (p.address ?? "").replace(/\s+/g, " ").trim();
    if (address.length < 10) e.address = "Enter the full address to be registered (at least 10 characters).";
    if (Object.keys(e).length) throw invalid("Check the new location.", e);
    const dupe = (await tx.query("SELECT name FROM locations WHERE state = $1 AND upper(name) = $2", [state, name])).rows[0];
    if (dupe) throw conflict(`${dupe.name} already exists in ${state}.`);
    const loc = (
      await tx.query<{ id: string }>(
        "INSERT INTO locations (state, city, outlet_type, name, active, address_status, created_by, created_at, updated_by, updated_at) VALUES ($1,$2,$3,$4,false,'MISSING',$5,$6,$5,$6) RETURNING id",
        [state, titleCase(state!), p.type, name, ctx.actor!.staffId, ctx.now],
      )
    ).rows[0];
    const ref = await nextRef(tx, "altphones_address_request_seq", "ADR", ctx.now);
    await tx.query("INSERT INTO altphones_address_requests (ref, location_id, address, basis, activate, note, requested_by, requested_at) VALUES ($1,$2,$3,'NEW_LOCATION',true,$4,$5,$6)", [ref, loc.id, address, (p.note ?? "").trim().slice(0, 500) || null, ctx.actor!.staffId, ctx.now]);
    await audit(tx, ctx, { action: "ALTPHONES_LOCATION_PROPOSED", details: { ref, state, type: p.type, name } });
    await notifyApprovers(tx, ctx, ref, [`${ctx.actor!.name} proposed a new ${TYPE_LABEL[p.type as LocType]}: ${name} (${state}).`, `Address: ${address}`, "It stays inactive until you approve the address."]);
    return { ref, locationId: loc.id };
  });
}

export async function decideAddressRequest(ctx: Ctx, id: string, p: { decision: string; note?: string }) {
  if (!isUuid(id)) throw notFound();
  return withTx(async (tx) => {
    const actor = ctx.actor!;
    if (!(await isApprover(tx, actor.staffId))) throw forbidden("Only the Altphones Unit Head can approve a location address.");
    const r = (await tx.query("SELECT r.*, l.name, l.state FROM altphones_address_requests r JOIN locations l ON l.id = r.location_id WHERE r.id = $1 FOR UPDATE OF r", [id])).rows[0];
    if (!r) throw notFound();
    if (r.status !== "PENDING") throw conflict(`${r.ref} has already been decided.`);
    if (r.requested_by === actor.staffId) throw forbidden("You requested this address, so another approver must decide it.");
    const note = (p.note ?? "").trim().slice(0, 500);
    if (p.decision === "REJECT") {
      if (note.length < 5) throw invalid("Say why the address is rejected.", { note: "Give a reason." });
      await tx.query("UPDATE altphones_address_requests SET status = 'REJECTED', decided_by = $2, decided_at = $3, decision_note = $4 WHERE id = $1", [id, actor.staffId, ctx.now, note]);
      await audit(tx, ctx, { action: "ALTPHONES_ADDRESS_REJECTED", details: { ref: r.ref, location: r.name, note } });
      return { ref: r.ref, approved: false };
    }
    if (p.decision !== "APPROVE") throw invalid("Choose approve or reject.");
    await tx.query(
      `UPDATE locations SET address = $2, address_status = 'REGISTERED', address_source = 'REGISTRATION_REQUEST', address_registered_at = $3, address_registered_by = $4,
              active = active OR $5, updated_by = $4, updated_at = $3 WHERE id = $1`,
      [r.location_id, r.address, ctx.now, actor.staffId, r.activate],
    );
    await tx.query("UPDATE altphones_address_requests SET status = 'APPROVED', decided_by = $2, decided_at = $3, decision_note = $4 WHERE id = $1", [id, actor.staffId, ctx.now, note || null]);
    await audit(tx, ctx, { action: "ALTPHONES_ADDRESS_APPROVED", details: { ref: r.ref, location: r.name, state: r.state, basis: r.basis, activated: r.activate } });
    return { ref: r.ref, approved: true, activated: r.activate };
  });
}

// ------------------------------------------------------------------ views

export interface PickerLocation {
  id: string;
  name: string;
  state: string;
  type: LocType;
  address: string;
}
/** Active locations with a registered address, for the State → Type → Location pickers. */
export async function pickerLocations(q: Db, types: LocType[]): Promise<PickerLocation[]> {
  return (
    await q.query<PickerLocation>(
      "SELECT id, name, state, outlet_type AS type, address FROM locations WHERE active AND address_status = 'REGISTERED' AND outlet_type = ANY($1) ORDER BY state, outlet_type, name",
      [types],
    )
  ).rows;
}

/** A location usable in origination, or why not. Enforced on the server whatever the browser sends. */
export async function originLocation(q: Db, id: string, types: LocType[]) {
  if (!isUuid(id)) return { loc: null, problem: "Choose your operating location." };
  const l = (await q.query<{ id: string; name: string; state: string; city: string; outlet_type: LocType; active: boolean; address: string | null; address_status: string }>("SELECT id, name, state, city, outlet_type, active, address, address_status FROM locations WHERE id = $1", [id])).rows[0];
  if (!l) return { loc: null, problem: "Choose your operating location." };
  if (!types.includes(l.outlet_type)) return { loc: null, problem: `Choose ${types.map((t) => `an ${TYPE_LABEL[t]}`.replace("an Branch", "a Branch")).join(" or ")}.` };
  if (!l.active) return { loc: null, problem: `${l.name} is not active.` };
  if (l.address_status !== "REGISTERED" || !l.address) return { loc: null, problem: `${l.name} has no registered address yet, so it cannot be used. The Altphones Product Manager must register it.` };
  return { loc: l, problem: null };
}

export async function listImports(q: Db) {
  return (await q.query("SELECT i.*, s.full_name AS created_by_name, a.full_name AS applied_by_name FROM altphones_location_imports i JOIN staff s ON s.id = i.created_by LEFT JOIN staff a ON a.id = i.applied_by ORDER BY i.created_at DESC LIMIT 20")).rows;
}
export async function importSources(q: Db, importId: string, f: { type?: string; outcome?: string }) {
  const where = ["s.import_id = $1"];
  const args: unknown[] = [importId];
  if (f.type) where.push(`s.location_type = $${args.push(f.type)}`);
  if (f.outcome === "attention") where.push("(s.outcome <> 'MATCHED' OR s.address_outcome IN ('MISSING','CONFLICT','DIFFERS_FROM_EXISTING') OR (s.type_conflict IS NOT NULL AND s.type_conflict <> 'linked by hand'))");
  else if (f.outcome) where.push(`(s.outcome = $${args.push(f.outcome)} OR s.address_outcome = $${args.length})`);
  return (
    await q.query(
      `SELECT s.*, l.name AS location_name, l.outlet_type AS location_type_now, l.address AS location_address
         FROM altphones_location_sources s LEFT JOIN locations l ON l.id = s.location_id WHERE ${where.join(" AND ")}
        ORDER BY (s.outcome = 'MATCHED' AND s.address_outcome IN ('REGISTERED','KEPT_EXISTING') AND s.type_conflict IS NULL), array_position(ARRAY['BRANCH','ALTSHOP','ALTBOX'], s.location_type), s.state, s.source_name`,
      args,
    )
  ).rows;
}

export interface MasterFilter {
  state?: string;
  type?: string;
  address?: string; // REGISTERED | MISSING | REVIEW
  q?: string;
}
export async function locationMaster(q: Db, f: MasterFilter) {
  const where = ["true"];
  const args: unknown[] = [];
  if (f.state) where.push(`l.state = $${args.push(f.state)}`);
  if (f.type) where.push(`l.outlet_type = $${args.push(f.type)}`);
  if (f.address) where.push(`l.address_status = $${args.push(f.address)}`);
  if (f.q) where.push(`(l.name ILIKE $${args.push(`%${f.q}%`)} OR l.address ILIKE $${args.length})`);
  return (
    await q.query(
      `SELECT l.id, l.name, l.state, l.outlet_type, l.active, l.address, l.address_status, l.address_source, l.source_name,
              coalesce(bl.bpm_email, b.bpm_email) AS bpm_email, bs.full_name AS bpm_name, (bl.location_id IS NOT NULL) AS bpm_for_location,
              (SELECT r.ref FROM altphones_address_requests r WHERE r.location_id = l.id AND r.status = 'PENDING') AS pending_ref
         FROM locations l LEFT JOIN altphones_bpm_locations bl ON bl.location_id = l.id LEFT JOIN altphones_bpm_states b ON b.state = l.state
         LEFT JOIN staff bs ON lower(bs.email) = coalesce(bl.bpm_email, b.bpm_email) AND bs.status = 'ACTIVE'
        WHERE ${where.join(" AND ")} ORDER BY l.state, array_position(ARRAY['BRANCH','ALTSHOP','ALTBOX'], l.outlet_type), l.name LIMIT 600`,
      args,
    )
  ).rows;
}
export async function addressRequests(q: Db, status = "PENDING") {
  return (
    await q.query(
      `SELECT r.*, l.name AS location_name, l.state, l.outlet_type, l.active, l.address AS current_address, s.full_name AS requested_by_name, d.full_name AS decided_by_name
         FROM altphones_address_requests r JOIN locations l ON l.id = r.location_id JOIN staff s ON s.id = r.requested_by LEFT JOIN staff d ON d.id = r.decided_by
        WHERE ($1 = 'ALL' OR r.status = $1) ORDER BY r.requested_at DESC LIMIT 200`,
      [status],
    )
  ).rows;
}
export async function bpmStates(q: Db) {
  return (
    await q.query(
      `SELECT b.state, b.bpm_email, b.source, s.full_name, s.id AS staff_id,
              EXISTS (SELECT 1 FROM role_assignments ra WHERE ra.staff_id = s.id AND ra.role = $1 AND ra.active) AS has_role,
              (SELECT count(*)::int FROM locations l WHERE l.state = b.state AND l.outlet_type IN ('ALTSHOP','ALTBOX') AND l.active) AS sa_locations
         FROM altphones_bpm_states b LEFT JOIN staff s ON lower(s.email) = b.bpm_email AND s.status = 'ACTIVE' ORDER BY b.state`,
      [BPM_ROLE],
    )
  ).rows;
}
/** Active Altshops/Altboxes with no usable BPM (by location or state), grouped by state: SA sales there cannot be submitted. */
export async function unroutedStates(q: Db) {
  return (
    await q.query<{ state: string; locations: number }>(
      `SELECT l.state, count(*)::int AS locations FROM locations l
         LEFT JOIN altphones_bpm_locations bl ON bl.location_id = l.id LEFT JOIN altphones_bpm_states b ON b.state = l.state
        WHERE l.active AND l.outlet_type IN ('ALTSHOP','ALTBOX')
          AND NOT EXISTS (SELECT 1 FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.role = $1 AND ra.active
                           WHERE lower(s.email) = coalesce(bl.bpm_email, b.bpm_email) AND s.status = 'ACTIVE')
        GROUP BY l.state ORDER BY l.state`,
      [BPM_ROLE],
    )
  ).rows;
}
/** The individual locations not routed to a BPM (for requesting a location mapping). */
export async function unroutedLocations(q: Db) {
  return (
    await q.query<{ id: string; name: string; state: string; outlet_type: string }>(
      `SELECT l.id, l.name, l.state, l.outlet_type FROM locations l
         LEFT JOIN altphones_bpm_locations bl ON bl.location_id = l.id LEFT JOIN altphones_bpm_states b ON b.state = l.state
        WHERE l.active AND l.outlet_type IN ('ALTSHOP','ALTBOX')
          AND NOT EXISTS (SELECT 1 FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.role = $1 AND ra.active
                           WHERE lower(s.email) = coalesce(bl.bpm_email, b.bpm_email) AND s.status = 'ACTIVE')
        ORDER BY l.state, l.name`,
      [BPM_ROLE],
    )
  ).rows;
}
