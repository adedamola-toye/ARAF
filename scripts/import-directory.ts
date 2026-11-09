import { loadEnv } from "./load-env";
loadEnv();
import { readFileSync } from "node:fs";
import { config } from "../src/server/config";
import { withTx, closePool } from "../src/server/db";

/**
 * Import the bank directory allowlist from a CSV export (upsert by email).
 * Usage: npm run directory:import -- <file.csv> [--dry-run] [--skip-invalid]
 *
 * Columns: email, full_name, department, is_group_mailbox, active
 * This only populates bank_directory; staff accounts and roles are still created in the app.
 */

interface DirectoryRow {
  email: string;
  fullName: string;
  department: string | null;
  isGroupMailbox: boolean;
  active: boolean;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const src = text.replace(/^\uFEFF/, "");
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

function parseBool(value: string, name: string, line: number, fallback: boolean): boolean | string {
  const v = value.trim().toLowerCase();
  if (v === "") return fallback;
  if (["true", "yes", "y", "1"].includes(v)) return true;
  if (["false", "no", "n", "0"].includes(v)) return false;
  return `Line ${line}: ${name} must be true/false (got "${value}").`;
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const skipInvalid = args.includes("--skip-invalid");
  if (!file) {
    console.error("Usage: npm run directory:import -- <file.csv> [--dry-run] [--skip-invalid]");
    process.exitCode = 1;
    return;
  }

  const table = parseCsv(readFileSync(file, "utf8"));
  if (table.length < 2) {
    console.error("CSV is empty (expected a header row and at least one data row).");
    process.exitCode = 1;
    return;
  }

  const header = table[0].map((h) => h.trim().toLowerCase());
  const idx = (...names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const iEmail = idx("email");
  const iName = idx("full_name", "full name", "name");
  const iDept = idx("department", "business_unit", "unit");
  const iGroup = idx("is_group_mailbox", "group_mailbox", "group");
  const iActive = idx("active", "status");

  const missing = [
    iEmail < 0 ? "email" : null,
    iName < 0 ? "full_name" : null,
  ].filter(Boolean);
  if (missing.length) {
    console.error(`CSV header is missing required column(s): ${missing.join(", ")}.`);
    console.error("Supported columns: email, full_name, department, is_group_mailbox, active");
    process.exitCode = 1;
    return;
  }

  const rows: DirectoryRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const domain = config.staffEmailDomain;

  table.slice(1).forEach((cells, n) => {
    const line = n + 2;
    const cell = (i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
    const email = cell(iEmail).toLowerCase();
    const fullName = cell(iName);
    if (!email) {
      errors.push(`Line ${line}: email is required.`);
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push(`Line ${line}: "${email}" is not a valid email.`);
      return;
    }
    if (!email.endsWith(`@${domain}`)) {
      errors.push(`Line ${line}: "${email}" must be an @${domain} address.`);
      return;
    }
    if (seen.has(email)) {
      errors.push(`Line ${line}: duplicate email "${email}".`);
      return;
    }
    if (!fullName) {
      errors.push(`Line ${line}: full_name is required.`);
      return;
    }
    const group = parseBool(cell(iGroup), "is_group_mailbox", line, false);
    if (typeof group === "string") {
      errors.push(group);
      return;
    }
    const active = parseBool(cell(iActive), "active", line, true);
    if (typeof active === "string") {
      errors.push(active);
      return;
    }
    seen.add(email);
    rows.push({ email, fullName, department: cell(iDept) || null, isGroupMailbox: group, active });
  });

  if (errors.length) {
    console.error(`Found ${errors.length} invalid row(s):`);
    for (const e of errors) console.error(`  ${e}`);
    if (!skipInvalid) {
      console.error("No changes made. Fix the rows, or pass --skip-invalid to import the valid ones.");
      process.exitCode = 1;
      return;
    }
    console.warn(`Continuing with ${rows.length} valid row(s); ${errors.length} skipped.`);
  }
  if (!rows.length) {
    console.error("No valid rows to import.");
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] ${rows.length} valid directory row(s) parsed from ${file}.`);
    for (const r of rows) {
      console.log(`  ${r.email} | ${r.fullName} | ${r.department ?? "—"} | group=${r.isGroupMailbox} | active=${r.active}`);
    }
    console.log("[dry-run] No database changes made.");
    return;
  }

  return withTx(async (tx) => {
    let inserted = 0;
    let updated = 0;
    for (const r of rows) {
      const res = await tx.query<{ inserted: boolean }>(
        `INSERT INTO bank_directory (email, full_name, department, is_group_mailbox, active, source, updated_at)
         VALUES ($1,$2,$3,$4,$5,'hr-import',now())
         ON CONFLICT (email) DO UPDATE
           SET full_name = EXCLUDED.full_name,
               department = EXCLUDED.department,
               is_group_mailbox = EXCLUDED.is_group_mailbox,
               active = EXCLUDED.active,
               source = 'hr-import',
               updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [r.email, r.fullName, r.department, r.isGroupMailbox, r.active],
      );
      if (res.rows[0].inserted) inserted++;
      else updated++;
    }
    console.log(`Directory import complete: ${inserted} inserted, ${updated} updated, ${rows.length} processed.`);
    console.log("Next: Super Admin -> Staff & roles -> Provision, then grant each role.");
  });
}

Promise.resolve()
  .then(main)
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
