/**
 * Staged migration of the Altphones historical sales register.
 *
 *   upload (Product Manager / Super Admin) → DRAFT: rows staged, classified, checked, reconciled
 *   map location labels and "Referred by" names, decide every blocked record → submit → SUBMITTED
 *   Unit Head who did not prepare it → approve (publish as verified historical accounts) or return with a reason.
 *
 * Classification is evidence-based: the COMPLETED REPAYMENT sheet is completed (the team's register is the evidence),
 * CANCELED REQUEST is cancelled, and INTERNAL / EXTERNAL rows are read month by month — "yes" is a paid instalment,
 * "no" a missed one — up to the batch's as-at date. Nothing is assumed complete. Publishing never moves stock.
 */
import type { Db, Tx } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { encryptField, hmac, sha256Hex } from "../crypto";
import { holdsRole } from "../domain/access";
import { enqueueEmail } from "../notify/outbox";
import { simpleEmail } from "../notify/templates";
import { config } from "../config";
import { currentSettings, isUuid, nextRef, PM_ROLE, roleHolders } from "./core";
import { poolModelId } from "./stock";
import { readRegister, type Issue, type SheetKind } from "./register";

export const PREPARER_ROLES = ["SUPER_ADMIN", PM_ROLE] as const;
export type Classification = "COMPLETED" | "CURRENT" | "IN_ARREARS" | "NOT_STARTED" | "NEEDS_REVIEW" | "CANCELLED";
export const CLASSIFICATION_LABEL: Record<Classification, string> = {
  COMPLETED: "Completed",
  CURRENT: "Current",
  IN_ARREARS: "In arrears",
  NOT_STARTED: "Not yet started",
  NEEDS_REVIEW: "Needs review",
  CANCELLED: "Cancelled",
};
const MAX_BYTES = 15 * 1024 * 1024;

const isPreparer = async (q: Db, staffId: string) => (await Promise.all(PREPARER_ROLES.map((r) => holdsRole(q, staffId, r)))).some(Boolean);
/** The approver is a Unit Head; when an Altphones Unit Head is configured, it must be that person. */
async function isApprover(q: Db, staffId: string) {
  if (!(await holdsRole(q, staffId, "UNIT_HEAD"))) return false;
  const uh = (await currentSettings(q)).unit_head_staff_id;
  return !uh || uh === staffId;
}
export async function migrationAccess(q: Db, staffId: string) {
  const [prepare, approve] = await Promise.all([isPreparer(q, staffId), isApprover(q, staffId)]);
  return { prepare, approve, view: prepare || approve };
}

const lagosToday = (now: Date) => new Date(now.getTime() + 3600_000).toISOString().slice(0, 10);
function checkAsAt(asAt: string, now: Date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asAt ?? "") || Number.isNaN(Date.parse(asAt))) throw invalid("Enter the date the register is correct to.", { asAt: "Enter a date." });
  if (asAt > lagosToday(now)) throw invalid("The as-at date cannot be in the future.", { asAt: "The as-at date cannot be in the future." });
  return asAt;
}
const enc = (v: string | null) => (v ? encryptField(v) : null);
const last4 = (v: string | null) => (v && v.length >= 4 ? v.slice(-4) : null);

/** Upload a register workbook as a new draft batch. */
export async function stageRegister(ctx: Ctx, p: { filename: string; data: Buffer; asAt: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!(await isPreparer(db, actor.staffId))) throw forbidden("Only the Altphones Product Manager or a Super Admin can prepare a migration batch.");
  const asAt = checkAsAt(p.asAt, ctx.now);
  if (!p.data?.length) throw invalid("Choose the register workbook.", { file: "Choose a file." });
  if (p.data.length > MAX_BYTES) throw invalid("The workbook is larger than 15 MB.", { file: "The file is too large." });
  if (p.data.subarray(0, 4).toString("binary") !== "PK\u0003\u0004") throw invalid("Upload the register as an Excel .xlsx workbook.", { file: "Upload an .xlsx file." });
  let parsed: Awaited<ReturnType<typeof readRegister>>;
  try {
    parsed = await readRegister(p.data);
  } catch {
    throw invalid("The workbook could not be read. Save it again from Excel as .xlsx.", { file: "The workbook could not be read." });
  }
  if (!parsed.rows.length) throw invalid("No customer rows were found. The register needs sheets named Internal, External, Completed or Cancelled with a Customer's name column.");
  const sha = sha256Hex(p.data);
  return withTx(async (tx) => {
    if (!(await isPreparer(tx, actor.staffId))) throw forbidden();
    const dup = (await tx.query<{ ref: string; status: string }>("SELECT ref, status FROM altphones_migration_batches WHERE sha256 = $1", [sha])).rows[0];
    if (dup) throw conflict(`This workbook was already uploaded as ${dup.ref} (${dup.status.toLowerCase()}).`);
    const open = (await tx.query<{ ref: string }>("SELECT ref FROM altphones_migration_batches WHERE status IN ('DRAFT','SUBMITTED')")).rows[0];
    if (open) throw conflict(`Batch ${open.ref} is still in progress. Publish or discard it before uploading another register.`);
    const ref = await nextRef(tx, "altphones_migration_seq", "MIG", ctx.now);
    const batch = (
      await tx.query<{ id: string }>(
        "INSERT INTO altphones_migration_batches (ref, filename, sha256, as_at, prepared_by, prepared_at, sheets) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [ref, p.filename.slice(0, 200), sha, asAt, actor.staffId, ctx.now, JSON.stringify(parsed.sheets)],
      )
    ).rows[0];
    const recs = parsed.rows.map((r) => ({
      sheet: r.sheet,
      sheet_kind: r.kind,
      row_no: r.row,
      customer_name: r.name.slice(0, 200),
      account_enc: enc(r.account),
      account_last4: last4(r.account),
      phone_enc: enc(r.phone),
      phone_last4: last4(r.phone),
      bvn_enc: enc(r.bvn),
      bvn_hash: r.bvn && /^\d{11}$/.test(r.bvn) ? hmac(`bvn:${r.bvn}`) : null,
      nin_enc: enc(r.nin),
      address_enc: enc(r.address),
      units: r.units,
      down_payment_kobo: r.downPaymentKobo,
      down_payment_date: r.downPaymentDate,
      instalment_kobo: r.instalmentKobo,
      start_date: r.startDate,
      end_date: r.endDate,
      tenor_months: r.tenor,
      imei: r.imei,
      location_label: r.location?.slice(0, 120) ?? null,
      referrer_label: r.referrer?.slice(0, 120) ?? null,
      months: r.months,
      parse_issues: r.issues,
    }));
    for (let i = 0; i < recs.length; i += 300) {
      await tx.query(
        `INSERT INTO altphones_migration_records (batch_id, sheet, sheet_kind, row_no, customer_name, account_enc, account_last4, phone_enc, phone_last4, bvn_enc, bvn_hash, nin_enc, address_enc,
                units, down_payment_kobo, down_payment_date, instalment_kobo, start_date, end_date, tenor_months, imei, location_label, referrer_label, months, parse_issues)
         SELECT $1, x.sheet, x.sheet_kind, x.row_no, x.customer_name, x.account_enc, x.account_last4, x.phone_enc, x.phone_last4, x.bvn_enc, x.bvn_hash, x.nin_enc, x.address_enc,
                x.units, x.down_payment_kobo, x.down_payment_date, x.instalment_kobo, x.start_date, x.end_date, x.tenor_months, x.imei, x.location_label, x.referrer_label, x.months, x.parse_issues
           FROM jsonb_to_recordset($2::jsonb) AS x(sheet text, sheet_kind text, row_no int, customer_name text, account_enc text, account_last4 text, phone_enc text, phone_last4 text, bvn_enc text, bvn_hash text,
                nin_enc text, address_enc text, units int, down_payment_kobo bigint, down_payment_date date, instalment_kobo bigint, start_date date, end_date date, tenor_months int, imei text,
                location_label text, referrer_label text, months jsonb, parse_issues jsonb)`,
        [batch.id, JSON.stringify(recs.slice(i, i + 300))],
      );
    }
    const summary = await evaluateBatch(tx, batch.id);
    await audit(tx, ctx, { action: "ALTPHONES_MIGRATION_STAGED", details: { ref, filename: p.filename, asAt, rows: recs.length, sheets: parsed.sheets.map((s) => ({ name: s.name, kind: s.kind, rows: s.rows })), blocked: summary.blockedOpen } });
    return { id: batch.id, ref, rows: recs.length, blocked: summary.blockedOpen };
  });
}

interface Rec {
  id: string;
  sheet: string;
  sheet_kind: SheetKind;
  row_no: number;
  bvn_hash: string | null;
  units: number | null;
  instalment_kobo: string | null;
  start_date: string | null;
  tenor_months: number | null;
  imei: string | null;
  location_label: string | null;
  referrer_label: string | null;
  months: { m: string; s: "Y" | "N" }[];
  parse_issues: Issue[];
  decision: "INCLUDE" | "EXCLUDE" | null;
  override_classification: Classification | null;
}

/** Classify one record from the register evidence up to the as-at date. */
export function classify(r: { sheet_kind: SheetKind; months: { m: string; s: "Y" | "N" }[]; tenor_months: number | null; instalment_kobo: number | string | null; start_date: string | null }, asAt: string, override?: Classification | null) {
  const asAtMonth = asAt.slice(0, 7);
  const marks = r.months.filter((x) => x.m <= asAtMonth);
  const after = r.months.length - marks.length;
  const inst = Number(r.instalment_kobo ?? 0);
  const tenor = r.tenor_months;
  let paid = marks.filter((x) => x.s === "Y").length;
  const missed = marks.filter((x) => x.s === "N").length;
  let c: Classification;
  if (r.sheet_kind === "CANCELLED") c = "CANCELLED";
  else if (r.sheet_kind === "COMPLETED") {
    c = "COMPLETED";
    paid = tenor ?? paid;
  } else if (tenor && paid >= tenor) c = "COMPLETED";
  else if (missed > 0) c = "IN_ARREARS";
  else if (paid > 0) c = "CURRENT";
  else if (r.start_date && r.start_date > asAt) c = "NOT_STARTED";
  else c = "NEEDS_REVIEW";
  const computed = c;
  const eff: Classification = override ?? c;
  let outstanding = eff === "COMPLETED" || eff === "CANCELLED" ? 0 : Math.max((tenor ?? 0) - Math.min(paid, tenor ?? paid), 0) * inst;
  let arrears = eff === "IN_ARREARS" ? Math.min(missed * inst, outstanding || missed * inst) : 0;
  if (!Number.isFinite(outstanding)) outstanding = 0;
  if (!Number.isFinite(arrears)) arrears = 0;
  return { computed, effective: eff, paid, missed, outstanding, arrears, monthsAfterAsAt: after };
}

/** Re-resolve mappings, duplicates and classification for every record of a batch, and store the summary. */
export async function evaluateBatch(tx: Tx, batchId: string) {
  const batch = (await tx.query<{ as_at: string; ref: string }>("SELECT to_char(as_at, 'YYYY-MM-DD') AS as_at, ref FROM altphones_migration_batches WHERE id = $1", [batchId])).rows[0];
  const recs = (
    await tx.query<Rec>(
      `SELECT id, sheet, sheet_kind, row_no, bvn_hash, units, instalment_kobo, to_char(start_date, 'YYYY-MM-DD') AS start_date, tenor_months, imei, location_label, referrer_label, months, parse_issues, decision, override_classification
         FROM altphones_migration_records WHERE batch_id = $1 ORDER BY sheet, row_no`,
      [batchId],
    )
  ).rows;
  // Location labels → location (by alias, name or original name); "Referred by" → staff (by alias or full name).
  const locRows = (
    await tx.query<{ id: string; labels: string[] }>(
      `SELECT l.id, array_remove(array_cat(ARRAY[upper(l.name), upper(coalesce(l.source_name, ''))], coalesce(array_agg(a.label) FILTER (WHERE a.label IS NOT NULL), '{}')), '') AS labels
         FROM locations l LEFT JOIN altphones_location_aliases a ON a.location_id = l.id WHERE l.active GROUP BY l.id`,
    )
  ).rows;
  const locBy = new Map<string, Set<string>>();
  for (const l of locRows) for (const k of l.labels) locBy.set(k, (locBy.get(k) ?? new Set()).add(l.id));
  const aliasLoc = new Map((await tx.query<{ label: string; location_id: string }>("SELECT label, location_id FROM altphones_location_aliases")).rows.map((a) => [a.label, a.location_id]));
  const staffBy = new Map<string, Set<string>>();
  for (const s of (await tx.query<{ id: string; n: string }>("SELECT id, upper(regexp_replace(btrim(full_name), '\\s+', ' ', 'g')) AS n FROM staff WHERE status = 'ACTIVE'")).rows) staffBy.set(s.n, (staffBy.get(s.n) ?? new Set()).add(s.id));
  const officerAlias = new Map((await tx.query<{ label: string; staff_id: string }>("SELECT label, staff_id FROM altphones_officer_aliases")).rows.map((a) => [a.label, a.staff_id]));

  const live = recs.filter((r) => r.decision !== "EXCLUDE");
  const byImei = new Map<string, Rec[]>();
  const byBvn = new Map<string, Rec[]>();
  for (const r of live) {
    if (r.imei && r.imei.length >= 14) byImei.set(r.imei, [...(byImei.get(r.imei) ?? []), r]);
    if (r.bvn_hash) byBvn.set(r.bvn_hash, [...(byBvn.get(r.bvn_hash) ?? []), r]);
  }
  const imeis = [...byImei.keys()];
  const known = new Set(
    imeis.length
      ? (await tx.query<{ imei: string }>("SELECT imei FROM altphones_devices WHERE imei = ANY($1) UNION SELECT imei FROM altphones_historical_accounts WHERE imei = ANY($1)", [imeis])).rows.map((x) => x.imei)
      : [],
  );
  const bvns = [...byBvn.keys()];
  const migratedBefore = new Set(bvns.length ? (await tx.query<{ bvn_hash: string }>("SELECT DISTINCT bvn_hash FROM altphones_historical_accounts WHERE bvn_hash = ANY($1)", [bvns])).rows.map((x) => x.bvn_hash) : []);
  const soldInAraf = new Set(bvns.length ? (await tx.query<{ bvn_hash: string }>("SELECT DISTINCT bvn_hash FROM altphones_applications WHERE bvn_hash = ANY($1) AND NOT legacy", [bvns])).rows.map((x) => x.bvn_hash) : []);
  const where = (o: Rec) => `${o.sheet} row ${o.row_no}`;

  const updates = recs.map((r) => {
    const issues: Issue[] = [...r.parse_issues];
    const add = (code: string, level: Issue["level"], message: string) => issues.push({ code, level, message });
    let locationId: string | null = null;
    if (r.location_label) {
      const alias = aliasLoc.get(r.location_label);
      const hits = alias ? new Set([alias]) : (locBy.get(r.location_label) ?? new Set());
      if (hits.size === 1) locationId = [...hits][0];
      else if (hits.size > 1) add("LOCATION_AMBIGUOUS", "WARN", `Location "${r.location_label}" matches more than one location. Link the label to one location.`);
      else add("LOCATION_UNMAPPED", "WARN", `Location "${r.location_label}" is not linked to a location yet.`);
    }
    let officerId: string | null = null;
    if (r.referrer_label) {
      const a = officerAlias.get(r.referrer_label);
      const hits = a ? new Set([a]) : (staffBy.get(r.referrer_label) ?? new Set());
      if (hits.size === 1) officerId = [...hits][0];
      else add("REFERRER_UNMAPPED", "WARN", `"Referred by" ${r.referrer_label} is not linked to a staff member.`);
    }
    if (r.decision !== "EXCLUDE") {
      const sameImei = r.imei ? (byImei.get(r.imei) ?? []).filter((o) => o.id !== r.id) : [];
      if (sameImei.length) add("DUPLICATE_IMEI", "BLOCK", `The same IMEI is also on ${sameImei.map(where).join(", ")}. Keep one record and exclude the other, or include both with a reason.`);
      if (r.imei && known.has(r.imei)) add("IMEI_ALREADY_REGISTERED", "BLOCK", "This IMEI is already registered in ARAF (stock, a sale, or an earlier migration).");
      if (r.bvn_hash) {
        const same = (byBvn.get(r.bvn_hash) ?? []).filter((o) => o.id !== r.id);
        const otherSheets = same.filter((o) => o.sheet !== r.sheet);
        if (otherSheets.length) add("CUSTOMER_IN_OTHER_SHEET", "BLOCK", `The same BVN is also on ${otherSheets.map(where).join(", ")}. Check whether this is the same sale listed twice.`);
        else if (same.length) add("REPEAT_CUSTOMER", "WARN", `The same BVN is on ${same.length} other row${same.length === 1 ? "" : "s"} of this sheet.`);
        if (migratedBefore.has(r.bvn_hash)) add("ALREADY_MIGRATED_CUSTOMER", "WARN", "This customer already has a migrated historical account.");
        if (soldInAraf.has(r.bvn_hash)) add("ARAF_CUSTOMER", "WARN", "This customer has also bought through ARAF.");
      }
    }
    const k = classify(r, batch.as_at, r.override_classification);
    if (k.computed === "NEEDS_REVIEW") add("NO_EVIDENCE", "BLOCK", "No monthly repayment marks up to the as-at date. Decide the status from the team's records, or exclude the record.");
    if (k.monthsAfterAsAt) add("MONTHS_AFTER_AS_AT", "WARN", `${k.monthsAfterAsAt} month mark${k.monthsAfterAsAt === 1 ? " is" : "s are"} after the as-at date and not counted.`);
    return { id: r.id, location_id: locationId, officer_id: officerId, paid: k.paid, missed: k.missed, classification: k.computed, arrears: k.arrears, outstanding: k.outstanding, issues };
  });
  for (let i = 0; i < updates.length; i += 500) {
    await tx.query(
      `UPDATE altphones_migration_records r SET location_id = x.location_id, officer_id = x.officer_id, paid_count = x.paid, missed_count = x.missed, classification = x.classification,
              arrears_kobo = x.arrears, outstanding_kobo = x.outstanding, issues = x.issues
         FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, location_id uuid, officer_id uuid, paid int, missed int, classification text, arrears bigint, outstanding bigint, issues jsonb)
        WHERE r.id = x.id`,
      [JSON.stringify(updates.slice(i, i + 500))],
    );
  }
  const summary = await reconciliation(tx, batchId);
  await tx.query("UPDATE altphones_migration_batches SET summary = $2 WHERE id = $1", [batchId, JSON.stringify(summary)]);
  return summary;
}

/** SQL fragment: does this record still have a blocking issue without a decision? */
const BLOCKED_OPEN = `(r.decision IS NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.issues) i WHERE i->>'level' = 'BLOCK'))`;
const EFFECTIVE = `coalesce(r.override_classification, r.classification)`;

export interface Reconciliation {
  sheets: { name: string; kind: string | null; read: number; staged: number; units: number; note?: string }[];
  records: number;
  units: number;
  included: number;
  excluded: number;
  blockedOpen: number;
  byStatus: { status: Classification; records: number; units: number; outstandingKobo: number; arrearsKobo: number }[];
  money: { downPaymentsKobo: number; collectedKobo: number; outstandingKobo: number; arrearsKobo: number };
  issues: { code: string; level: string; records: number }[];
  locations: { labels: number; mapped: number; unmappedRecords: number };
  referrers: { labels: number; mapped: number; unmappedRecords: number };
  ninKept: number;
  ninDropped: number;
}

export async function reconciliation(q: Db, batchId: string): Promise<Reconciliation> {
  const b = (await q.query<{ sheets: { name: string; kind: string | null; rows: number; note?: string }[] }>("SELECT sheets FROM altphones_migration_batches WHERE id = $1", [batchId])).rows[0];
  if (!b) throw notFound();
  const staged = (await q.query<{ sheet: string; n: number; units: number }>("SELECT sheet, count(*)::int AS n, coalesce(sum(units),0)::int AS units FROM altphones_migration_records WHERE batch_id = $1 GROUP BY sheet", [batchId])).rows;
  const t = (
    await q.query(
      `SELECT count(*)::int AS records, coalesce(sum(units),0)::int AS units,
              count(*) FILTER (WHERE decision IS DISTINCT FROM 'EXCLUDE')::int AS included,
              count(*) FILTER (WHERE decision = 'EXCLUDE')::int AS excluded,
              count(*) FILTER (WHERE ${BLOCKED_OPEN})::int AS blocked,
              coalesce(sum(down_payment_kobo) FILTER (WHERE decision IS DISTINCT FROM 'EXCLUDE'),0)::bigint AS down,
              coalesce(sum(coalesce(down_payment_kobo,0) + paid_count * coalesce(instalment_kobo,0)) FILTER (WHERE decision IS DISTINCT FROM 'EXCLUDE' AND ${EFFECTIVE} <> 'CANCELLED'),0)::bigint AS collected,
              coalesce(sum(outstanding_kobo) FILTER (WHERE decision IS DISTINCT FROM 'EXCLUDE'),0)::bigint AS outstanding,
              coalesce(sum(arrears_kobo) FILTER (WHERE decision IS DISTINCT FROM 'EXCLUDE'),0)::bigint AS arrears,
              count(*) FILTER (WHERE decision IS DISTINCT FROM 'EXCLUDE' AND nin_enc IS NOT NULL AND ${EFFECTIVE} <> 'COMPLETED')::int AS nin_kept,
              count(*) FILTER (WHERE nin_enc IS NOT NULL AND ${EFFECTIVE} = 'COMPLETED')::int AS nin_dropped
         FROM altphones_migration_records r WHERE batch_id = $1`,
      [batchId],
    )
  ).rows[0];
  const byStatus = (
    await q.query(
      `SELECT ${EFFECTIVE} AS status, count(*)::int AS records, coalesce(sum(units),0)::int AS units, coalesce(sum(outstanding_kobo),0)::bigint AS outstanding, coalesce(sum(arrears_kobo),0)::bigint AS arrears
         FROM altphones_migration_records r WHERE batch_id = $1 AND decision IS DISTINCT FROM 'EXCLUDE' GROUP BY 1`,
      [batchId],
    )
  ).rows;
  const order: Classification[] = ["CURRENT", "IN_ARREARS", "NOT_STARTED", "COMPLETED", "CANCELLED", "NEEDS_REVIEW"];
  const issues = (
    await q.query<{ code: string; level: string; records: number }>(
      `SELECT i->>'code' AS code, i->>'level' AS level, count(DISTINCT r.id)::int AS records
         FROM altphones_migration_records r, jsonb_array_elements(r.issues) i WHERE r.batch_id = $1 AND r.decision IS DISTINCT FROM 'EXCLUDE' GROUP BY 1, 2 ORDER BY (i->>'level') = 'WARN', 3 DESC`,
      [batchId],
    )
  ).rows;
  const labels = (
    await q.query(
      `SELECT count(DISTINCT location_label)::int AS labels, count(DISTINCT location_label) FILTER (WHERE location_id IS NOT NULL)::int AS mapped,
              count(*) FILTER (WHERE location_label IS NOT NULL AND location_id IS NULL)::int AS unmapped,
              count(DISTINCT referrer_label)::int AS rlabels, count(DISTINCT referrer_label) FILTER (WHERE officer_id IS NOT NULL)::int AS rmapped,
              count(*) FILTER (WHERE referrer_label IS NOT NULL AND officer_id IS NULL)::int AS runmapped
         FROM altphones_migration_records WHERE batch_id = $1`,
      [batchId],
    )
  ).rows[0];
  return {
    sheets: b.sheets.map((s) => ({ name: s.name, kind: s.kind, read: s.rows, staged: staged.find((x) => x.sheet === s.name)?.n ?? 0, units: staged.find((x) => x.sheet === s.name)?.units ?? 0, note: s.note })),
    records: t.records,
    units: t.units,
    included: t.included,
    excluded: t.excluded,
    blockedOpen: t.blocked,
    byStatus: order
      .map((s) => byStatus.find((x) => x.status === s))
      .filter(Boolean)
      .map((x) => ({ status: x.status, records: x.records, units: x.units, outstandingKobo: Number(x.outstanding), arrearsKobo: Number(x.arrears) })),
    money: { downPaymentsKobo: Number(t.down), collectedKobo: Number(t.collected), outstandingKobo: Number(t.outstanding), arrearsKobo: Number(t.arrears) },
    issues,
    locations: { labels: labels.labels, mapped: labels.mapped, unmappedRecords: labels.unmapped },
    referrers: { labels: labels.rlabels, mapped: labels.rmapped, unmappedRecords: labels.runmapped },
    ninKept: t.nin_kept,
    ninDropped: t.nin_dropped,
  };
}

async function lockDraft(tx: Tx, ctx: Ctx, batchId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!isUuid(batchId)) throw notFound("Migration batch not found.");
  if (!(await isPreparer(tx, actor.staffId))) throw forbidden("Only the Altphones Product Manager or a Super Admin can change a migration batch.");
  const b = (await tx.query<{ id: string; ref: string; status: string; prepared_by: string }>("SELECT id, ref, status, prepared_by FROM altphones_migration_batches WHERE id = $1 FOR UPDATE", [batchId])).rows[0];
  if (!b) throw notFound("Migration batch not found.");
  if (b.status !== "DRAFT") throw conflict(`${b.ref} is ${b.status.toLowerCase()} and can no longer be changed.`);
  return b;
}

export async function setAsAt(ctx: Ctx, batchId: string, asAt: string) {
  return withTx(async (tx) => {
    const b = await lockDraft(tx, ctx, batchId);
    const d = checkAsAt(asAt, ctx.now);
    await tx.query("UPDATE altphones_migration_batches SET as_at = $2 WHERE id = $1", [b.id, d]);
    const s = await evaluateBatch(tx, b.id);
    await audit(tx, ctx, { action: "ALTPHONES_MIGRATION_AS_AT_SET", details: { ref: b.ref, asAt: d } });
    return { ref: b.ref, blocked: s.blockedOpen };
  });
}

/** Link register location labels to locations (saved as aliases, so later files match too). */
export async function mapLocations(ctx: Ctx, batchId: string, maps: { label: string; locationId: string }[]) {
  return withTx(async (tx) => {
    const b = await lockDraft(tx, ctx, batchId);
    let saved = 0;
    for (const m of maps) {
      const label = (m.label ?? "").replace(/\s+/g, " ").trim().toUpperCase();
      if (!label || !m.locationId) continue;
      if (!isUuid(m.locationId)) throw invalid(`Choose a location for ${label}.`);
      const loc = (await tx.query<{ id: string; name: string }>("SELECT id, name FROM locations WHERE id = $1 AND active", [m.locationId])).rows[0];
      if (!loc) throw invalid(`The location chosen for ${label} was not found.`);
      if (label === loc.name.toUpperCase()) continue;
      await tx.query(
        `INSERT INTO altphones_location_aliases (label, location_id, created_by, created_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (label) DO UPDATE SET location_id = EXCLUDED.location_id, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at`,
        [label, loc.id, ctx.actor!.staffId, ctx.now],
      );
      await audit(tx, ctx, { action: "ALTPHONES_LOCATION_LABEL_LINKED", details: { ref: b.ref, label, location: loc.name } });
      saved++;
    }
    if (!saved) throw invalid("Choose a location for at least one label.");
    await evaluateBatch(tx, b.id);
    return { saved };
  });
}

/** Link "Referred by" names to staff. */
export async function mapReferrers(ctx: Ctx, batchId: string, maps: { label: string; staffId: string }[]) {
  return withTx(async (tx) => {
    const b = await lockDraft(tx, ctx, batchId);
    let saved = 0;
    for (const m of maps) {
      const label = (m.label ?? "").replace(/\s+/g, " ").trim().toUpperCase();
      if (!label || !m.staffId) continue;
      if (!isUuid(m.staffId)) throw invalid(`Choose a staff member for ${label}.`);
      const st = (await tx.query<{ id: string; full_name: string }>("SELECT id, full_name FROM staff WHERE id = $1", [m.staffId])).rows[0];
      if (!st) throw invalid(`The staff member chosen for ${label} was not found.`);
      await tx.query(
        `INSERT INTO altphones_officer_aliases (label, staff_id, created_by, created_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (label) DO UPDATE SET staff_id = EXCLUDED.staff_id, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at`,
        [label, st.id, ctx.actor!.staffId, ctx.now],
      );
      await audit(tx, ctx, { action: "ALTPHONES_REFERRER_LINKED", details: { ref: b.ref, label, staff: st.full_name } });
      saved++;
    }
    if (!saved) throw invalid("Choose a staff member for at least one name.");
    await evaluateBatch(tx, b.id);
    return { saved };
  });
}

/** The preparer's decision on one record: include (optionally with a status decided from the team's records) or exclude. */
export async function decideRecord(ctx: Ctx, recordId: string, p: { decision: string; classification?: string; note?: string }) {
  if (!isUuid(recordId)) throw notFound("Record not found.");
  return withTx(async (tx) => {
    const r = (await tx.query<{ batch_id: string; classification: Classification; issues: Issue[]; sheet: string; row_no: number }>("SELECT batch_id, classification, issues, sheet, row_no FROM altphones_migration_records WHERE id = $1", [recordId])).rows[0];
    if (!r) throw notFound("Record not found.");
    const b = await lockDraft(tx, ctx, r.batch_id);
    const note = (p.note ?? "").trim().slice(0, 500);
    const decision = p.decision === "CLEAR" ? null : p.decision;
    if (decision !== null && decision !== "INCLUDE" && decision !== "EXCLUDE") throw invalid("Choose include or exclude.");
    const override = (p.classification ?? "").trim() || null;
    const allowed: Classification[] = ["COMPLETED", "CURRENT", "IN_ARREARS", "NOT_STARTED", "CANCELLED"];
    if (override && !allowed.includes(override as Classification)) throw invalid("Choose a valid status.", { classification: "Choose a valid status." });
    const blocked = r.issues.some((i) => i.level === "BLOCK");
    const e: Record<string, string> = {};
    if (decision === "INCLUDE" && r.classification === "NEEDS_REVIEW" && !override) e.classification = "There are no repayment marks: choose the status shown by the team's records.";
    if (decision && (decision === "EXCLUDE" || blocked || override) && note.length < 5) e.note = "Give a short reason (it is kept with the record and shown to the Unit Head).";
    if (Object.keys(e).length) throw invalid("Check the decision.", e);
    await tx.query(
      "UPDATE altphones_migration_records SET decision = $2, override_classification = $3, decision_note = $4, decided_by = $5, decided_at = $6 WHERE id = $1",
      [recordId, decision, decision ? override : null, decision ? note || null : null, decision ? ctx.actor!.staffId : null, decision ? ctx.now : null],
    );
    await audit(tx, ctx, { action: "ALTPHONES_MIGRATION_RECORD_DECIDED", details: { ref: b.ref, sheet: r.sheet, row: r.row_no, decision: decision ?? "CLEARED", status: override, note: note || null } });
    const s = await evaluateBatch(tx, b.id);
    return { ref: b.ref, blocked: s.blockedOpen };
  });
}

/** One decision for every undecided record matching a filter (e.g. all records without repayment marks). */
export async function decideMatching(ctx: Ctx, batchId: string, f: RecordFilter, p: { decision: string; classification?: string; note?: string }) {
  return withTx(async (tx) => {
    const b = await lockDraft(tx, ctx, batchId);
    const note = (p.note ?? "").trim().slice(0, 500);
    const override = (p.classification ?? "").trim() || null;
    const allowed: Classification[] = ["COMPLETED", "CURRENT", "IN_ARREARS", "NOT_STARTED", "CANCELLED"];
    const e: Record<string, string> = {};
    if (p.decision !== "INCLUDE" && p.decision !== "EXCLUDE") e.decision = "Choose include or exclude.";
    if (override && !allowed.includes(override as Classification)) e.classification = "Choose a valid status.";
    if (note.length < 5) e.note = "Give a short reason (it is kept with every record and shown to the Unit Head).";
    if (Object.keys(e).length) throw invalid("Check the decision.", e);
    const { w, args } = recordWhere(b.id, { ...f, decision: "NONE", page: undefined });
    const ids = (await tx.query<{ id: string; classification: Classification }>(`SELECT r.id, r.classification FROM altphones_migration_records r WHERE ${w}`, args)).rows;
    if (!ids.length) throw invalid("No undecided records match the filter.");
    if (p.decision === "INCLUDE" && !override && ids.some((r) => r.classification === "NEEDS_REVIEW")) throw invalid("Some of these records have no repayment marks: choose the status shown by the team's records.", { classification: "Choose a status." });
    await tx.query(
      "UPDATE altphones_migration_records SET decision = $2, override_classification = $3, decision_note = $4, decided_by = $5, decided_at = $6 WHERE id = ANY($1)",
      [ids.map((r) => r.id), p.decision, override, note, ctx.actor!.staffId, ctx.now],
    );
    await audit(tx, ctx, { action: "ALTPHONES_MIGRATION_RECORDS_DECIDED", details: { ref: b.ref, records: ids.length, decision: p.decision, status: override, note, filter: { sheet: f.sheet || null, status: f.status || null, issue: f.issue || null, q: f.q ? "(search)" : null } } });
    const s = await evaluateBatch(tx, b.id);
    return { ref: b.ref, decided: ids.length, blocked: s.blockedOpen };
  });
}

export async function submitBatch(ctx: Ctx, batchId: string, note?: string) {
  return withTx(async (tx) => {
    const b = await lockDraft(tx, ctx, batchId);
    const s = await evaluateBatch(tx, b.id);
    if (s.blockedOpen) throw invalid(`${s.blockedOpen} record${s.blockedOpen === 1 ? " needs" : "s need"} a decision before the batch can be submitted.`);
    if (!s.included) throw invalid("Every record is excluded; there is nothing to publish.");
    await tx.query("UPDATE altphones_migration_batches SET status = 'SUBMITTED', submitted_by = $2, submitted_at = $3, returned_note = NULL, decision_note = $4 WHERE id = $1", [b.id, ctx.actor!.staffId, ctx.now, (note ?? "").trim().slice(0, 1000) || null]);
    await audit(tx, ctx, { action: "ALTPHONES_MIGRATION_SUBMITTED", details: { ref: b.ref, included: s.included, excluded: s.excluded, byStatus: s.byStatus.map((x) => ({ status: x.status, records: x.records })) } });
    const uh = (await currentSettings(tx)).unit_head_staff_id;
    const approvers = (await roleHolders(tx, ["UNIT_HEAD"])).filter((a) => (!uh || a.id === uh) && a.id !== ctx.actor!.staffId);
    if (approvers.length)
      await enqueueEmail(tx, ctx.now, {
        kind: "ALTPHONES_MIGRATION_SUBMITTED",
        dedupeKey: `altphones:migration:submitted:${b.id}:${ctx.now.getTime()}`,
        to: approvers.map((a) => a.email),
        subject: `[${b.ref}] Altphones historical migration awaiting your approval`,
        text: simpleEmail([`${ctx.actor!.name} submitted ${b.ref}: ${s.included} records to publish, ${s.excluded} excluded.`, "", `Review the reconciliation and approve or return it (sign-in required): ${config.appUrl}/altphones/migration/${b.id}`]),
      });
    return { ref: b.ref };
  });
}

export async function discardBatch(ctx: Ctx, batchId: string, reason: string) {
  return withTx(async (tx) => {
    const b = await lockDraft(tx, ctx, batchId);
    if ((reason ?? "").trim().length < 5) throw invalid("Give a reason for discarding the batch.", { reason: "Give a reason." });
    await tx.query("UPDATE altphones_migration_records SET account_enc = NULL, phone_enc = NULL, bvn_enc = NULL, nin_enc = NULL, address_enc = NULL WHERE batch_id = $1", [b.id]);
    await tx.query("UPDATE altphones_migration_batches SET status = 'DISCARDED', decision_note = $2 WHERE id = $1", [b.id, reason.trim().slice(0, 500)]);
    await audit(tx, ctx, { action: "ALTPHONES_MIGRATION_DISCARDED", details: { ref: b.ref, reason: reason.trim() } });
    return { ref: b.ref };
  });
}

/** Unit Head decision. Approve publishes the batch as verified historical accounts; return sends it back to the preparer. */
export async function decideBatch(ctx: Ctx, batchId: string, p: { decision: string; comment?: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!isUuid(batchId)) throw notFound("Migration batch not found.");
  return withTx(async (tx) => {
    if (!(await isApprover(tx, actor.staffId))) throw forbidden("Only the Altphones Unit Head can approve a historical migration.");
    const b = (
      await tx.query<{ id: string; ref: string; status: string; prepared_by: string; submitted_by: string | null; as_at: string }>(
        "SELECT id, ref, status, prepared_by, submitted_by, to_char(as_at, 'YYYY-MM-DD') AS as_at FROM altphones_migration_batches WHERE id = $1 FOR UPDATE",
        [batchId],
      )
    ).rows[0];
    if (!b) throw notFound("Migration batch not found.");
    if (b.status !== "SUBMITTED") throw conflict(`${b.ref} is not awaiting approval.`);
    if (b.prepared_by === actor.staffId || b.submitted_by === actor.staffId) throw forbidden("You prepared this batch, so another approver must decide it.");
    const comment = (p.comment ?? "").trim().slice(0, 1000);
    const preparer = (await tx.query<{ email: string }>("SELECT email FROM staff WHERE id = $1", [b.submitted_by ?? b.prepared_by])).rows[0];
    if (p.decision === "RETURN") {
      if (comment.length < 5) throw invalid("Say what needs to change.", { comment: "Say what needs to change." });
      await tx.query("UPDATE altphones_migration_batches SET status = 'DRAFT', returned_note = $2, submitted_by = NULL, submitted_at = NULL WHERE id = $1", [b.id, comment]);
      await audit(tx, ctx, { action: "ALTPHONES_MIGRATION_RETURNED", details: { ref: b.ref, comment } });
      if (preparer)
        await enqueueEmail(tx, ctx.now, {
          kind: "ALTPHONES_MIGRATION_RETURNED",
          dedupeKey: `altphones:migration:returned:${b.id}:${ctx.now.getTime()}`,
          to: [preparer.email],
          subject: `[${b.ref}] Historical migration returned for changes`,
          text: simpleEmail([`${actor.name} returned ${b.ref}:`, comment, "", `${config.appUrl}/altphones/migration/${b.id}`]),
        });
      return { ref: b.ref, published: 0 };
    }
    if (p.decision !== "APPROVE") throw invalid("Choose approve or return.");
    // Re-check against the database as it is now (e.g. an IMEI sold through ARAF since the batch was submitted).
    const s = await evaluateBatch(tx, b.id);
    if (s.blockedOpen) throw conflict(`${s.blockedOpen} record${s.blockedOpen === 1 ? " has" : "s have"} a new blocking issue since submission. Return the batch so the preparer can resolve it.`);
    const recs = (
      await tx.query(
        `SELECT r.*, coalesce(r.override_classification, r.classification) AS status FROM altphones_migration_records r
          WHERE r.batch_id = $1 AND r.decision IS DISTINCT FROM 'EXCLUDE' ORDER BY r.sheet, r.row_no`,
        [b.id],
      )
    ).rows;
    const pool = await poolModelId(tx);
    let published = 0;
    for (const r of recs) {
      const ref = await nextRef(tx, "altphones_historical_seq", "HIS", ctx.now);
      const acc = (
        await tx.query<{ id: string }>(
          `INSERT INTO altphones_historical_accounts (ref, batch_id, record_id, source_sheet, source_row, customer_name, account_enc, account_last4, phone_enc, phone_last4, bvn_enc, bvn_hash, nin_enc, address_enc,
                  units, down_payment_kobo, down_payment_date, instalment_kobo, start_date, end_date, tenor_months, imei, location_id, location_label, officer_id, referrer_label,
                  status, paid_count, missed_count, arrears_kobo, outstanding_kobo, as_at, decision_note, published_by, published_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35) RETURNING id`,
          [
            ref, b.id, r.id, r.sheet, r.row_no, r.customer_name, r.account_enc, r.account_last4, r.phone_enc, r.phone_last4, r.bvn_enc, r.bvn_hash,
            r.status === "COMPLETED" ? null : r.nin_enc, // NIN is kept only while repayment is not complete
            r.address_enc, r.units, r.down_payment_kobo, r.down_payment_date, r.instalment_kobo, r.start_date, r.end_date, r.tenor_months, r.imei, r.location_id, r.location_label, r.officer_id, r.referrer_label,
            r.status, r.paid_count, r.missed_count, r.arrears_kobo, r.outstanding_kobo, b.as_at, r.decision_note, actor.staffId, ctx.now,
          ],
        )
      ).rows[0];
      const marks = (r.months as { m: string; s: "Y" | "N" }[]).filter((m) => m.m <= b.as_at.slice(0, 7));
      if (marks.length)
        await tx.query(
          `INSERT INTO altphones_historical_instalments (account_id, month, status, recorded_at)
           SELECT $1, (x.m || '-01')::date, CASE x.s WHEN 'Y' THEN 'PAID' ELSE 'MISSED' END, $3 FROM jsonb_to_recordset($2::jsonb) AS x(m text, s text) ON CONFLICT DO NOTHING`,
          [acc.id, JSON.stringify(marks), ctx.now],
        );
      // Register the IMEI as an issued legacy device so it can never be sold or migrated again. No stock moves.
      if (pool && r.imei && /^\d{15}$/.test(r.imei))
        await tx.query("INSERT INTO altphones_devices (imei, model_id, status, legacy, registered_by, registered_at, issued_at) VALUES ($1,$2,'ISSUED',true,$3,$4,$5) ON CONFLICT (imei) DO NOTHING", [
          r.imei, pool, actor.staffId, ctx.now, r.down_payment_date ?? ctx.now,
        ]);
      published++;
    }
    // The verified accounts now hold the personal data; clear the staging copies.
    await tx.query("UPDATE altphones_migration_records SET account_enc = NULL, phone_enc = NULL, bvn_enc = NULL, nin_enc = NULL, address_enc = NULL WHERE batch_id = $1", [b.id]);
    await tx.query("UPDATE altphones_migration_batches SET status = 'PUBLISHED', decided_by = $2, decided_at = $3, decision_note = coalesce($4, decision_note), summary = $5 WHERE id = $1", [b.id, actor.staffId, ctx.now, comment || null, JSON.stringify(s)]);
    await audit(tx, ctx, { action: "ALTPHONES_MIGRATION_PUBLISHED", details: { ref: b.ref, published, excluded: s.excluded, byStatus: s.byStatus.map((x) => ({ status: x.status, records: x.records })), comment: comment || null } });
    if (preparer)
      await enqueueEmail(tx, ctx.now, {
        kind: "ALTPHONES_MIGRATION_PUBLISHED",
        dedupeKey: `altphones:migration:published:${b.id}`,
        to: [preparer.email],
        subject: `[${b.ref}] Historical migration approved and published`,
        text: simpleEmail([`${actor.name} approved ${b.ref}. ${published} historical accounts are now published as verified.`, "", `${config.appUrl}/altphones/migration/${b.id}`]),
      });
    return { ref: b.ref, published };
  });
}

// ---------- views ----------

export async function listBatches(q: Db) {
  return (
    await q.query(
      `SELECT b.id, b.ref, b.filename, to_char(b.as_at, 'YYYY-MM-DD') AS as_at, b.status, b.prepared_at, b.submitted_at, b.decided_at, b.summary,
              p.full_name AS prepared_by_name, d.full_name AS decided_by_name
         FROM altphones_migration_batches b JOIN staff p ON p.id = b.prepared_by LEFT JOIN staff d ON d.id = b.decided_by
        ORDER BY b.prepared_at DESC LIMIT 50`,
    )
  ).rows;
}

export async function getBatch(q: Db, id: string) {
  if (!isUuid(id)) return null;
  return (
    (
      await q.query(
        `SELECT b.*, to_char(b.as_at, 'YYYY-MM-DD') AS as_at_text, p.full_name AS prepared_by_name, s.full_name AS submitted_by_name, d.full_name AS decided_by_name
           FROM altphones_migration_batches b JOIN staff p ON p.id = b.prepared_by LEFT JOIN staff s ON s.id = b.submitted_by LEFT JOIN staff d ON d.id = b.decided_by
          WHERE b.id = $1`,
        [id],
      )
    ).rows[0] ?? null
  );
}

export async function locationLabels(q: Db, batchId: string) {
  return (
    await q.query<{ label: string; records: number; units: number; location_id: string | null; location_name: string | null }>(
      `SELECT r.location_label AS label, count(*)::int AS records, coalesce(sum(r.units),0)::int AS units, min(r.location_id::text)::uuid AS location_id, min(l.name) AS location_name
         FROM altphones_migration_records r LEFT JOIN locations l ON l.id = r.location_id
        WHERE r.batch_id = $1 AND r.location_label IS NOT NULL GROUP BY r.location_label ORDER BY (min(r.location_id::text) IS NOT NULL), count(*) DESC, r.location_label`,
      [batchId],
    )
  ).rows;
}

export async function referrerLabels(q: Db, batchId: string) {
  return (
    await q.query<{ label: string; records: number; staff_id: string | null; staff_name: string | null }>(
      `SELECT r.referrer_label AS label, count(*)::int AS records, min(r.officer_id::text)::uuid AS staff_id, min(s.full_name) AS staff_name
         FROM altphones_migration_records r LEFT JOIN staff s ON s.id = r.officer_id
        WHERE r.batch_id = $1 AND r.referrer_label IS NOT NULL GROUP BY r.referrer_label ORDER BY (min(r.officer_id::text) IS NOT NULL), count(*) DESC, r.referrer_label`,
      [batchId],
    )
  ).rows;
}

export interface RecordFilter {
  sheet?: string;
  status?: string;
  issue?: string; // 'blocked' | 'warn' | an issue code
  decision?: string; // 'INCLUDE' | 'EXCLUDE' | 'NONE'
  q?: string;
  page?: number;
}
export const RECORDS_PAGE = 50;
function recordWhere(batchId: string, f: RecordFilter) {
  const where = ["r.batch_id = $1"];
  const args: unknown[] = [batchId];
  const arg = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };
  if (f.sheet) where.push(`r.sheet = ${arg(f.sheet)}`);
  if (f.status) where.push(`${EFFECTIVE} = ${arg(f.status)}`);
  if (f.issue === "blocked") where.push(BLOCKED_OPEN);
  else if (f.issue === "warn") where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(r.issues) i WHERE i->>'level' = 'WARN')`);
  else if (f.issue) where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(r.issues) i WHERE i->>'code' = ${arg(f.issue)})`);
  if (f.decision === "NONE") where.push("r.decision IS NULL");
  else if (f.decision === "INCLUDE" || f.decision === "EXCLUDE") where.push(`r.decision = ${arg(f.decision)}`);
  if (f.q) where.push(`(r.customer_name ILIKE ${arg(`%${f.q}%`)} OR r.imei = ${arg(f.q.replace(/\D/g, "") || "-")} OR r.account_last4 = ${arg(f.q.replace(/\D/g, "").slice(-4) || "-")})`);
  return { w: where.join(" AND "), args };
}
export async function listRecords(q: Db, batchId: string, f: RecordFilter) {
  const { w, args } = recordWhere(batchId, f);
  const total = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM altphones_migration_records r WHERE ${w}`, args)).rows[0].n;
  const page = Math.max(1, Math.min(f.page ?? 1, Math.max(1, Math.ceil(total / RECORDS_PAGE))));
  const rows = (
    await q.query(
      `SELECT r.id, r.sheet, r.sheet_kind, r.row_no, r.customer_name, r.account_last4, r.phone_last4, r.units, r.down_payment_kobo, to_char(r.down_payment_date,'YYYY-MM-DD') AS down_payment_date,
              r.instalment_kobo, to_char(r.start_date,'YYYY-MM-DD') AS start_date, r.tenor_months, r.imei, r.location_label, l.name AS location_name, r.referrer_label, s.full_name AS officer_name,
              r.months, r.paid_count, r.missed_count, r.classification, r.override_classification, ${EFFECTIVE} AS status, r.arrears_kobo, r.outstanding_kobo, r.issues,
              r.decision, r.decision_note, d.full_name AS decided_by_name, ${BLOCKED_OPEN} AS blocked
         FROM altphones_migration_records r LEFT JOIN locations l ON l.id = r.location_id LEFT JOIN staff s ON s.id = r.officer_id LEFT JOIN staff d ON d.id = r.decided_by
        WHERE ${w} ORDER BY ${BLOCKED_OPEN} DESC, r.sheet, r.row_no LIMIT ${RECORDS_PAGE} OFFSET ${(page - 1) * RECORDS_PAGE}`,
      args,
    )
  ).rows;
  return { total, page, pages: Math.max(1, Math.ceil(total / RECORDS_PAGE)), rows };
}

export async function historicalTotals(q: Db) {
  return (
    await q.query<{ status: string; accounts: number; units: number; outstanding: string; arrears: string }>(
      "SELECT status, count(*)::int AS accounts, coalesce(sum(units),0)::int AS units, coalesce(sum(outstanding_kobo),0) AS outstanding, coalesce(sum(arrears_kobo),0) AS arrears FROM altphones_historical_accounts GROUP BY status",
    )
  ).rows;
}
