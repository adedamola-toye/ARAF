/**
 * Bank directory import (Super Admin).
 *
 * The bank directory is the allowlist that staff provisioning and Legal/Shariah recipient groups are
 * validated against. It is loaded from the bank's staff export as CSV or Excel (.xlsx):
 *   required columns: email, full name        optional: department, group mailbox (yes/no), active (yes/no)
 * Column headers are matched case-insensitively with common aliases ("Email Address", "Staff Name", …).
 *
 * Two modes:
 *   MERGE   - add new people and update existing ones; nobody is removed.
 *   REPLACE - the file is the complete directory: entries missing from it are marked inactive
 *             (never deleted). Provisioned staff no longer in the directory are listed for the Super
 *             Admin to review; their access is not changed automatically.
 * Every import can be previewed (dry run) first and is audited (counts, file name and fingerprint).
 */
import ExcelJS from "exceljs";
import type { Db } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { config } from "../config";
import { sha256Hex } from "../crypto";
import { DomainError, forbidden, invalid } from "../errors";
import { holdsRole } from "./access";

export const MAX_DIRECTORY_BYTES = 10 * 1024 * 1024;
export const MAX_DIRECTORY_ROWS = 100_000;

export interface DirectoryRow {
  email: string;
  fullName: string;
  department: string | null;
  isGroupMailbox: boolean;
  active: boolean;
}
export interface RowError {
  row: number;
  message: string;
}

const ALIASES: Record<keyof DirectoryRow, string[]> = {
  email: ["email", "e-mail", "email address", "e-mail address", "work email", "official email", "mail", "staff email", "emailaddress"],
  fullName: ["full name", "name", "staff name", "employee name", "display name", "fullname", "names"],
  department: ["department", "dept", "unit", "business unit", "division", "branch"],
  isGroupMailbox: ["group mailbox", "is group mailbox", "group", "mailbox type", "type", "shared mailbox"],
  active: ["active", "status", "employment status", "is active"],
};
const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, " ").trim();

function yes(v: string, dflt: boolean): boolean | null {
  const s = norm(v);
  if (!s) return dflt;
  if (["yes", "y", "true", "1", "active", "group", "shared", "group mailbox"].includes(s)) return true;
  if (["no", "n", "false", "0", "inactive", "exited", "terminated", "resigned", "person", "individual", "user"].includes(s)) return false;
  return null;
}

/** Split CSV text into rows (handles quotes, embedded commas/newlines, BOM, ; or , separators). */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const firstLine = t.split(/\r?\n/, 1)[0] ?? "";
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export async function parseXlsx(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets.find((w) => w.rowCount > 0);
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const vals: string[] = [];
    for (let i = 1; i <= r.cellCount; i++) {
      const v = r.getCell(i).value as unknown;
      let s = "";
      if (v === null || v === undefined) s = "";
      else if (typeof v === "object" && v && "text" in (v as object)) s = String((v as { text: unknown }).text ?? "");
      else if (typeof v === "object" && v && "hyperlink" in (v as object)) s = String((v as { hyperlink: string }).hyperlink).replace(/^mailto:/i, "");
      else if (typeof v === "object" && v && "result" in (v as object)) s = String((v as { result: unknown }).result ?? "");
      else if (typeof v === "object" && v && "richText" in (v as object)) s = (v as { richText: { text: string }[] }).richText.map((x) => x.text).join("");
      else s = String(v);
      vals.push(s);
    }
    rows.push(vals);
  });
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Parse and validate a directory file. Never writes anything. */
export async function parseDirectoryFile(filename: string, data: Buffer): Promise<{ rows: DirectoryRow[]; errors: RowError[]; columns: Record<string, string> }> {
  if (data.length === 0) throw invalid("The file is empty.");
  if (data.length > MAX_DIRECTORY_BYTES) throw invalid("The file is larger than 10 MB. Split it or remove unused columns.");
  const ext = filename.toLowerCase().split(".").pop();
  const isZip = data.subarray(0, 4).toString("binary") === "PK\u0003\u0004";
  let table: string[][];
  if (ext === "xlsx" || isZip) {
    if (!isZip) throw invalid("The .xlsx file could not be read. Save it again from Excel as .xlsx, or export it as CSV.");
    try {
      table = await parseXlsx(data);
    } catch {
      throw invalid("The Excel file could not be read. Save it as .xlsx (not .xls) or export it as CSV.");
    }
  } else if (ext === "csv" || ext === "txt") {
    table = parseCsv(data.toString("utf8"));
  } else {
    throw invalid("Upload the directory as an Excel .xlsx or a .csv file.");
  }
  if (table.length < 2) throw invalid("The file needs a header row and at least one person.");
  if (table.length - 1 > MAX_DIRECTORY_ROWS) throw invalid(`The file has more than ${MAX_DIRECTORY_ROWS.toLocaleString()} rows.`);

  // Find the header row within the first 10 rows (exports sometimes start with a title line).
  let headerIdx = -1;
  let map: Partial<Record<keyof DirectoryRow, number>> = {};
  for (let h = 0; h < Math.min(10, table.length); h++) {
    const heads = table[h].map(norm);
    const m: Partial<Record<keyof DirectoryRow, number>> = {};
    for (const [field, aliases] of Object.entries(ALIASES) as [keyof DirectoryRow, string[]][]) {
      const i = heads.findIndex((x) => aliases.includes(x));
      if (i >= 0) m[field] = i;
    }
    if (m.email !== undefined && m.fullName !== undefined) {
      headerIdx = h;
      map = m;
      break;
    }
  }
  if (headerIdx < 0) throw invalid('Could not find the header row. The file needs columns named "Email" and "Full name" (other names such as "Email Address" or "Staff Name" also work).');

  const domain = `@${config.staffEmailDomain}`;
  const rows: DirectoryRow[] = [];
  const errors: RowError[] = [];
  const seen = new Map<string, number>();
  for (let r = headerIdx + 1; r < table.length; r++) {
    const cells = table[r];
    const rowNo = r + 1; // spreadsheet row number
    const get = (k: keyof DirectoryRow) => (map[k] === undefined ? "" : String(cells[map[k]!] ?? "").trim());
    const email = get("email").toLowerCase().replace(/^mailto:/, "");
    const fullName = get("fullName").replace(/\s+/g, " ");
    if (!email && !fullName) continue;
    if (!/^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
      errors.push({ row: rowNo, message: `"${email || "(blank)"}" is not a valid email address.` });
      continue;
    }
    if (!email.endsWith(domain)) {
      errors.push({ row: rowNo, message: `${email} is not an ${domain} address.` });
      continue;
    }
    if (!fullName) {
      errors.push({ row: rowNo, message: `${email}: full name is missing.` });
      continue;
    }
    if (fullName.length > 200) {
      errors.push({ row: rowNo, message: `${email}: full name is too long.` });
      continue;
    }
    const grp = yes(get("isGroupMailbox"), false);
    const act = yes(get("active"), true);
    if (grp === null) errors.push({ row: rowNo, message: `${email}: group mailbox must be yes or no.` });
    if (act === null) errors.push({ row: rowNo, message: `${email}: active must be yes or no (or Active/Inactive).` });
    if (grp === null || act === null) continue;
    if (seen.has(email)) {
      errors.push({ row: rowNo, message: `${email} appears more than once (also row ${seen.get(email)}).` });
      continue;
    }
    seen.set(email, rowNo);
    rows.push({ email, fullName, department: get("department") || null, isGroupMailbox: grp, active: act });
  }
  const columns = Object.fromEntries(Object.entries(map).map(([k, i]) => [k, table[headerIdx][i!]]));
  return { rows, errors, columns };
}

export type ImportMode = "MERGE" | "REPLACE";

export interface ImportSummary {
  mode: ImportMode;
  filename: string;
  fingerprint: string;
  totalRows: number;
  added: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  reactivated: number;
  errors: RowError[];
  columns: Record<string, string>;
  /** Provisioned, active staff whose directory entry is missing or inactive after this import. */
  staffNotInDirectory: { email: string; fullName: string; reason: string }[];
  applied: boolean;
}

/**
 * Preview (dryRun) or apply a directory import. Rows with errors are never imported; when any row has
 * an error the import is refused so the file can be corrected (nothing partial is written).
 */
export async function importDirectory(ctx: Ctx, p: { filename: string; data: Buffer; mode: ImportMode; dryRun: boolean }): Promise<ImportSummary> {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  try {
    const parsed = await parseDirectoryFile(p.filename, p.data);
    return await withTx(async (tx) => {
      if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only the Super Admin can upload the bank directory.");
      if (p.mode !== "MERGE" && p.mode !== "REPLACE") throw invalid("Choose how to import: add and update, or full replace.");
      if (p.mode === "REPLACE" && parsed.rows.length === 0) throw invalid("A full replace needs at least one valid person in the file.");
      const existing = new Map(
        (await tx.query<{ email: string; full_name: string; department: string | null; is_group_mailbox: boolean; active: boolean }>("SELECT * FROM bank_directory")).rows.map((r) => [r.email, r]),
      );
      const fileEmails = new Set(parsed.rows.map((r) => r.email));
      let added = 0;
      let updated = 0;
      let unchanged = 0;
      let reactivated = 0;
      for (const r of parsed.rows) {
        const e = existing.get(r.email);
        if (!e) added++;
        else if (e.full_name === r.fullName && (e.department ?? null) === r.department && e.is_group_mailbox === r.isGroupMailbox && e.active === r.active) unchanged++;
        else {
          updated++;
          if (!e.active && r.active) reactivated++;
        }
      }
      const toDeactivate = p.mode === "REPLACE" ? [...existing.values()].filter((e) => e.active && !fileEmails.has(e.email)).map((e) => e.email) : [];
      const summary: ImportSummary = {
        mode: p.mode,
        filename: p.filename,
        fingerprint: sha256Hex(p.data).slice(0, 16),
        totalRows: parsed.rows.length + parsed.errors.length,
        added,
        updated,
        unchanged,
        deactivated: toDeactivate.length,
        reactivated,
        errors: parsed.errors,
        columns: parsed.columns,
        staffNotInDirectory: [],
        applied: false,
      };
      // Staff whose directory status would be missing/inactive after the import.
      const afterActive = (email: string) => {
        const f = parsed.rows.find((r) => r.email === email);
        if (f) return f.active;
        if (toDeactivate.includes(email)) return false;
        return existing.get(email)?.active ?? false;
      };
      const staff = (await tx.query<{ email: string; full_name: string }>("SELECT email, full_name FROM staff WHERE status = 'ACTIVE' ORDER BY full_name")).rows;
      summary.staffNotInDirectory = staff
        .filter((s) => !afterActive(s.email))
        .map((s) => ({ email: s.email, fullName: s.full_name, reason: existing.has(s.email) || fileEmails.has(s.email) ? "Inactive in the directory" : "Not in the directory" }));

      if (p.dryRun) return summary;
      if (parsed.errors.length) throw invalid(`The file has ${parsed.errors.length} row(s) with errors. Correct them and upload again; nothing was imported.`);

      const source = `import:${p.filename.slice(0, 80)}`;
      for (const r of parsed.rows) {
        await tx.query(
          `INSERT INTO bank_directory (email, full_name, department, is_group_mailbox, active, source, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name, department = EXCLUDED.department, is_group_mailbox = EXCLUDED.is_group_mailbox,
             active = EXCLUDED.active, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at`,
          [r.email, r.fullName, r.department, r.isGroupMailbox, r.active, source, ctx.now],
        );
      }
      if (toDeactivate.length) {
        await tx.query("UPDATE bank_directory SET active = false, source = $2, updated_at = $3 WHERE email = ANY($1::text[])", [toDeactivate, source, ctx.now]);
      }
      summary.applied = true;
      await audit(tx, ctx, {
        action: "DIRECTORY_IMPORTED",
        actorRole: "SUPER_ADMIN",
        details: {
          mode: p.mode,
          filename: p.filename,
          fingerprint: summary.fingerprint,
          rows: summary.totalRows,
          added,
          updated,
          unchanged,
          deactivated: toDeactivate.length,
          reactivated,
          staffNotInDirectory: summary.staffNotInDirectory.length,
        },
      });
      return summary;
    });
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") await auditOutsideTx(ctx, { action: "DIRECTORY_IMPORTED", outcome: "DENIED", reason: e.message });
    throw e;
  }
}

export async function directoryStats(q: Db) {
  return (
    await q.query<{ total: string; active: string; groups: string; last_update: Date | null }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE active) AS active, count(*) FILTER (WHERE is_group_mailbox) AS groups, max(updated_at) AS last_update FROM bank_directory`,
    )
  ).rows[0];
}

export async function searchDirectory(q: Db, term: string, page: number, size = 50) {
  const t = `%${term.trim().toLowerCase()}%`;
  const rows = (
    await q.query(
      `SELECT d.*, s.id AS staff_id, s.status AS staff_status FROM bank_directory d LEFT JOIN staff s ON s.email = d.email
        WHERE ($1 = '%%' OR d.email LIKE $1 OR lower(d.full_name) LIKE $1 OR lower(coalesce(d.department,'')) LIKE $1)
        ORDER BY d.full_name LIMIT ${size + 1} OFFSET ${(Math.max(1, page) - 1) * size}`,
      [t],
    )
  ).rows;
  return { rows: rows.slice(0, size), more: rows.length > size };
}

export const DIRECTORY_TEMPLATE_CSV = "Email,Full name,Department,Group mailbox,Active\r\nfirstname.lastname@altbank.ng,Firstname Lastname,Credit Risk,No,Yes\r\nlegal@altbank.ng,Legal Department,Legal,Yes,Yes\r\n";

/** Read a CSV or .xlsx upload into rows of cells (shared by other imports). */
export async function readSpreadsheet(filename: string, data: Buffer, maxBytes = MAX_DIRECTORY_BYTES): Promise<string[][]> {
  if (data.length === 0) throw invalid("The file is empty.");
  if (data.length > maxBytes) throw invalid(`The file is larger than ${Math.round(maxBytes / 1048576)} MB.`);
  const ext = filename.toLowerCase().split(".").pop();
  const isZip = data.subarray(0, 4).toString("binary") === "PK\u0003\u0004";
  if (ext === "xlsx" || isZip) {
    if (!isZip) throw invalid("The .xlsx file could not be read. Save it again from Excel as .xlsx, or export it as CSV.");
    try {
      return await parseXlsx(data);
    } catch {
      throw invalid("The Excel file could not be read. Save it as .xlsx (not .xls) or export it as CSV.");
    }
  }
  if (ext === "csv" || ext === "txt") return parseCsv(data.toString("utf8"));
  throw invalid("Upload an Excel .xlsx or a .csv file.");
}
