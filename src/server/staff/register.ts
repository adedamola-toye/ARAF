/**
 * Confidential salary register and automatic eligibility for Staff Salary Advance.
 *
 *  - The register holds each employee's verified monthly salary and salary account, maintained by Salary Register
 *    Administrators (CSV import with preview, or individual edits). Employees never declare their own salary.
 *  - Eligibility is computed here, server-side: limit = salary × configured percentage (default 50%); available =
 *    limit − outstanding advances − amounts reserved by requests in progress.
 *  - Outstanding balances fall only when a confirmed repayment is recorded (staff_advance_repayments).
 *  - Salary figures are visible only to the employee (their own), register administrators / Super Admins, and
 *    approvers of a request (who see the snapshot taken at submission). They never go into general emails or the
 *    audit trail; the audit records which fields changed, not the values.
 */
import { createHash } from "node:crypto";
import type { Db, Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, gate, invalid, notFound } from "../errors";
import { decryptField, encryptField } from "../crypto";
import { last4 } from "../mask";
import { parseNairaToKobo } from "../money";
import { readCsv } from "../csv";
import { isValidDateString, lagosDate } from "../time";
import { holdsRole } from "../domain/access";
import { availableKobo, eligibilityLimitKobo, formatNairaKobo } from "@/lib/staff-financing";
import { currentSettings, type StaffSettings } from "./core";
import { staffAdvanceRetired, STAFF_SALARY_ADVANCE_RETIRED_MESSAGE } from "./permission";

export const EMPLOYMENT_STATUSES = ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED", "EXITED"] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];
export const EMPLOYMENT_LABEL: Record<EmploymentStatus, string> = { ACTIVE: "Active", PROBATION: "Probation", ON_LEAVE: "On leave", SUSPENDED: "Suspended", EXITED: "Exited" };
/** Employment statuses that may receive an advance. */
const ELIGIBLE_EMPLOYMENT: EmploymentStatus[] = ["ACTIVE", "ON_LEAVE"];

/** Requests that reserve part of the limit until they finish (approved, pending or in disbursement). */
export const RESERVING_STATUSES = [
  "SUBMITTED",
  "UNDER_PM_REVIEW",
  "RETURNED_FOR_CORRECTION",
  "UNDER_UNIT_HEAD_REVIEW",
  "UNDER_DIVISIONAL_HEAD_REVIEW",
  "APPROVED",
  "AWAITING_SIGNED_OFFER",
  "ASSIGNED_FOR_DISBURSEMENT",
  "DISBURSEMENT_IN_PROGRESS",
];

export interface RegisterRow {
  id: string;
  staff_id: string;
  staff_number: string;
  employee_name: string;
  ad_identity: string;
  monthly_salary_kobo: string;
  account_number_enc: string;
  account_last4: string;
  account_name: string;
  employment_status: EmploymentStatus;
  eligibility_status: "ELIGIBLE" | "HELD";
  hold_reason: string | null;
  salary_as_of: string;
  source: string;
  updated_at: Date;
  updated_by_name?: string | null;
}

export async function canAdministerRegister(q: Db, staffId: string) {
  return (await holdsRole(q, staffId, "SALARY_REGISTER_ADMIN")) || (await holdsRole(q, staffId, "SUPER_ADMIN"));
}

/** The register only fed Staff Salary Advance eligibility, which is retired: it is kept read-only. */
function registerRetired(): never {
  throw gate(STAFF_SALARY_ADVANCE_RETIRED_MESSAGE + " The salary register is kept read-only.");
}

async function requireRegisterAdmin(tx: Tx, ctx: Ctx) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!(await canAdministerRegister(tx, actor.staffId))) throw forbidden("Only a Salary Register Administrator can do this.");
  return { staffId: actor.staffId, role: (await holdsRole(tx, actor.staffId, "SALARY_REGISTER_ADMIN")) ? "SALARY_REGISTER_ADMIN" : "SUPER_ADMIN" };
}

export async function registerRecord(q: Db, staffId: string): Promise<RegisterRow | null> {
  return (
    (
      await q.query<RegisterRow>(
        "SELECT r.*, r.monthly_salary_kobo::text, r.salary_as_of::text, s.full_name AS updated_by_name FROM salary_register r LEFT JOIN staff s ON s.id = r.updated_by WHERE r.staff_id = $1",
        [staffId],
      )
    ).rows[0] ?? null
  );
}

export function accountNumber(r: Pick<RegisterRow, "account_number_enc">): string {
  return decryptField(r.account_number_enc);
}

// ------------------------------------------------------------------ exposure and eligibility

export interface AdvanceRow {
  id: string;
  ref: string;
  status: string;
  gross_kobo: string | null;
  deduction_kobo: string | null;
  net_kobo: string | null;
  disbursed_at: Date | null;
  disbursement_txn_ref: string | null;
  repaid_kobo: string;
  outstanding_kobo: string;
  last_repayment_at: string | null;
  offer_document_id: string | null;
  tenor_months: number | null;
}

/** Every disbursed advance with confirmed repayments and the outstanding balance. */
export async function advances(q: Db, staffId: string): Promise<AdvanceRow[]> {
  return (
    await q.query<AdvanceRow>(
      `SELECT r.id, r.ref, r.status, r.gross_kobo::text, r.deduction_kobo::text, r.net_kobo::text, r.disbursed_at, r.disbursement_txn_ref, r.offer_document_id, r.tenor_months,
              coalesce(p.repaid, 0)::text AS repaid_kobo, greatest(r.gross_kobo - coalesce(p.repaid, 0), 0)::text AS outstanding_kobo, p.last::text AS last_repayment_at
         FROM staff_requests r
         LEFT JOIN (SELECT request_id, sum(amount_kobo) AS repaid, max(value_date) AS last FROM staff_advance_repayments GROUP BY request_id) p ON p.request_id = r.id
        WHERE r.applicant_id = $1 AND r.status = 'COMPLETED' ORDER BY r.disbursed_at DESC`,
      [staffId],
    )
  ).rows;
}

export async function exposure(q: Db, staffId: string, excludeRequestId: string | null = null) {
  const adv = await advances(q, staffId);
  const outstanding = adv.reduce((t, a) => t + Number(a.outstanding_kobo), 0);
  const reserved = Number(
    (
      await q.query<{ k: string }>(
        `SELECT coalesce(sum(gross_kobo), 0)::text AS k FROM staff_requests WHERE applicant_id = $1 AND status = ANY($2) AND gross_kobo IS NOT NULL AND ($3::uuid IS NULL OR id <> $3)`,
        [staffId, RESERVING_STATUSES, excludeRequestId],
      )
    ).rows[0].k,
  );
  return { outstanding, reserved, advances: adv };
}

export type EligibilityState = "ELIGIBLE" | "NO_RECORD" | "OUTDATED" | "NOT_EMPLOYED" | "HELD" | "FULLY_USED";

export interface Eligibility {
  state: EligibilityState;
  message: string;
  salaryKobo: number | null;
  percentBps: number;
  limitKobo: number;
  outstandingKobo: number;
  reservedKobo: number;
  availableKobo: number;
  salaryAsOf: string | null;
  record: RegisterRow | null;
}

export async function eligibilityFor(q: Db, staffId: string, now: Date, settings?: StaffSettings, excludeRequestId: string | null = null): Promise<Eligibility> {
  const s = settings ?? (await currentSettings(q));
  const rec = await registerRecord(q, staffId);
  const ex = await exposure(q, staffId, excludeRequestId);
  const base = { percentBps: s.eligibility_percent_bps, outstandingKobo: ex.outstanding, reservedKobo: ex.reserved, record: rec };
  if (!rec)
    return { ...base, state: "NO_RECORD", message: "Your verified salary record is not in the salary register yet. Contact the Salary Register Administrator (HR).", salaryKobo: null, limitKobo: 0, availableKobo: 0, salaryAsOf: null };
  const salary = Number(rec.monthly_salary_kobo);
  const limit = eligibilityLimitKobo(salary, s.eligibility_percent_bps);
  const available = availableKobo(limit, ex.outstanding, ex.reserved);
  const common = { ...base, salaryKobo: salary, limitKobo: limit, availableKobo: available, salaryAsOf: rec.salary_as_of };
  const ageDays = Math.floor((Date.parse(lagosDate(now)) - Date.parse(rec.salary_as_of)) / 86_400_000);
  if (rec.eligibility_status === "HELD") return { ...common, availableKobo: 0, state: "HELD", message: `Your salary advance eligibility is on hold${rec.hold_reason ? `: ${rec.hold_reason}` : ""}. Contact the Salary Register Administrator.` };
  if (!ELIGIBLE_EMPLOYMENT.includes(rec.employment_status)) return { ...common, availableKobo: 0, state: "NOT_EMPLOYED", message: `Your employment status (${EMPLOYMENT_LABEL[rec.employment_status]}) does not allow a salary advance.` };
  if (ageDays > s.salary_record_max_age_days)
    return { ...common, availableKobo: 0, state: "OUTDATED", message: `Your salary record (verified for ${rec.salary_as_of}) is older than ${s.salary_record_max_age_days} days. It must be refreshed by the Salary Register Administrator before you can apply.` };
  if (available <= 0) return { ...common, state: "FULLY_USED", message: "Your limit is fully used by an outstanding or pending advance. It becomes available again as repayments are confirmed." };
  return { ...common, state: "ELIGIBLE", message: "You are eligible." };
}

/** True when this settings version uses the register (automatic eligibility, no bureau check for this product). */
export const usesRegister = (s: Pick<StaffSettings, "eligibility_mode">) => s.eligibility_mode === "SALARY_REGISTER";

// ------------------------------------------------------------------ individual maintenance

export interface RecordInput {
  staffId: string;
  staffNumber: string;
  monthlySalary: string;
  accountNumber: string;
  accountName: string;
  employmentStatus: string;
  salaryAsOf: string;
}

function validateRecord(i: Omit<RecordInput, "staffId">, now: Date) {
  const errors: Record<string, string> = {};
  const staffNumber = (i.staffNumber ?? "").trim();
  if (!/^[A-Za-z0-9/\-]{2,30}$/.test(staffNumber)) errors.staffNumber = "Staff ID: 2–30 letters, digits, / or -.";
  const salary = parseNairaToKobo((i.monthlySalary ?? "").trim());
  if (salary === null || salary <= 0) errors.monthlySalary = "Enter the verified monthly salary in naira.";
  else if (salary > 100_000_000_000) errors.monthlySalary = "The salary is too large; check the figure.";
  const acct = (i.accountNumber ?? "").replace(/\s+/g, "");
  if (!/^\d{10}$/.test(acct)) errors.accountNumber = "The salary account number has 10 digits.";
  const name = (i.accountName ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 3) errors.accountName = "Enter the name on the salary account.";
  const status = (i.employmentStatus ?? "").trim().toUpperCase().replace(/\s+/g, "_");
  if (!(EMPLOYMENT_STATUSES as readonly string[]).includes(status)) errors.employmentStatus = `Employment status: ${EMPLOYMENT_STATUSES.join(", ")}.`;
  const asOf = (i.salaryAsOf ?? "").trim();
  if (!isValidDateString(asOf)) errors.salaryAsOf = "Salary verified for (date, YYYY-MM-DD).";
  else if (asOf > lagosDate(now)) errors.salaryAsOf = "The salary date cannot be in the future.";
  return { errors, value: { staffNumber, salary: salary ?? 0, acct, name, status: status as EmploymentStatus, asOf } };
}

/** Field names that changed (values are never put in the audit trail). */
function changedFields(before: RegisterRow | null, v: ReturnType<typeof validateRecord>["value"]): string[] {
  if (!before) return ["created"];
  const out: string[] = [];
  if (before.staff_number !== v.staffNumber) out.push("staffNumber");
  if (Number(before.monthly_salary_kobo) !== v.salary) out.push("monthlySalary");
  if (accountNumber(before) !== v.acct) out.push("accountNumber");
  if (before.account_name !== v.name) out.push("accountName");
  if (before.employment_status !== v.status) out.push("employmentStatus");
  if (before.salary_as_of !== v.asOf) out.push("salaryAsOf");
  return out;
}

const snap = (v: ReturnType<typeof validateRecord>["value"]) => ({ staffNumber: v.staffNumber, salaryKobo: v.salary, accountLast4: last4(v.acct), accountName: v.name, employmentStatus: v.status, salaryAsOf: v.asOf });
const snapRow = (r: RegisterRow) => ({ staffNumber: r.staff_number, salaryKobo: Number(r.monthly_salary_kobo), accountLast4: r.account_last4, accountName: r.account_name, employmentStatus: r.employment_status, salaryAsOf: r.salary_as_of });

async function writeRecord(tx: Tx, ctx: Ctx, staff: { id: string; full_name: string; email: string }, v: ReturnType<typeof validateRecord>["value"], source: "CSV" | "MANUAL", importId: string | null, reason: string | null, actorRole: string) {
  const before = await registerRecord(tx, staff.id);
  const clash = await tx.query("SELECT 1 FROM salary_register WHERE lower(staff_number) = lower($1) AND staff_id <> $2", [v.staffNumber, staff.id]);
  if (clash.rowCount) throw conflict(`Staff ID ${v.staffNumber} is already registered to another employee.`);
  const changed = changedFields(before, v);
  if (before && !changed.length) return "UNCHANGED" as const;
  const enc = encryptField(v.acct);
  const row = (
    await tx.query<{ id: string }>(
      `INSERT INTO salary_register (staff_id, staff_number, employee_name, ad_identity, monthly_salary_kobo, account_number_enc, account_last4, account_name, employment_status, salary_as_of, source, import_id, updated_by, updated_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
       ON CONFLICT (staff_id) DO UPDATE SET staff_number = EXCLUDED.staff_number, employee_name = EXCLUDED.employee_name, ad_identity = EXCLUDED.ad_identity,
         monthly_salary_kobo = EXCLUDED.monthly_salary_kobo, account_number_enc = EXCLUDED.account_number_enc, account_last4 = EXCLUDED.account_last4, account_name = EXCLUDED.account_name,
         employment_status = EXCLUDED.employment_status, salary_as_of = EXCLUDED.salary_as_of, source = EXCLUDED.source, import_id = EXCLUDED.import_id,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [staff.id, v.staffNumber, staff.full_name, staff.email.toLowerCase(), v.salary, enc, last4(v.acct), v.name, v.status, v.asOf, source, importId, ctx.actor!.staffId, ctx.now],
    )
  ).rows[0];
  await tx.query(
    "INSERT INTO salary_register_history (register_id, staff_id, change, before, after, reason, source, import_id, changed_by, changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [row.id, staff.id, before ? "UPDATED" : "CREATED", before ? JSON.stringify(snapRow(before)) : null, JSON.stringify(snap(v)), reason, source, importId, ctx.actor!.staffId, ctx.now],
  );
  await audit(tx, ctx, { action: before ? "SALARY_RECORD_UPDATED" : "SALARY_RECORD_CREATED", actorRole, reason, details: { staffId: staff.id, fieldsChanged: changed, source, importId } });
  return before ? ("UPDATED" as const) : ("CREATED" as const);
}

export async function saveRecord(ctx: Ctx, i: RecordInput, reason: string) {
  if (staffAdvanceRetired()) registerRetired();
  const why = (reason ?? "").trim();
  return withTx(async (tx) => {
    const { role } = await requireRegisterAdmin(tx, ctx);
    const { errors, value } = validateRecord(i, ctx.now);
    if (why.length < 5) errors.reason = "Give the reason and the source (for example the payroll period).";
    if (!/^[0-9a-f-]{36}$/i.test(i.staffId)) errors.staffId = "Choose the employee.";
    if (Object.keys(errors).length) throw invalid("Check the salary record.", errors);
    const staff = (await tx.query<{ id: string; full_name: string; email: string }>("SELECT id, full_name, email FROM staff WHERE id = $1", [i.staffId])).rows[0];
    if (!staff) throw notFound("Employee not found.");
    return writeRecord(tx, ctx, staff, value, "MANUAL", null, why, role);
  });
}

export async function holdRecord(ctx: Ctx, staffId: string, hold: boolean, reason: string) {
  if (staffAdvanceRetired()) registerRetired();
  const why = (reason ?? "").trim();
  if (why.length < 5) throw invalid("Give the reason.", { reason: "Reason required." });
  return withTx(async (tx) => {
    const { role } = await requireRegisterAdmin(tx, ctx);
    const r = (await tx.query<RegisterRow>("SELECT *, monthly_salary_kobo::text, salary_as_of::text FROM salary_register WHERE staff_id = $1 FOR UPDATE", [staffId])).rows[0];
    if (!r) throw notFound("No salary record for this employee.");
    if ((r.eligibility_status === "HELD") === hold) throw conflict(hold ? "Already on hold." : "Not on hold.");
    await tx.query("UPDATE salary_register SET eligibility_status = $2, hold_reason = $3, updated_by = $4, updated_at = $5 WHERE id = $1", [r.id, hold ? "HELD" : "ELIGIBLE", hold ? why : null, ctx.actor!.staffId, ctx.now]);
    await tx.query(
      "INSERT INTO salary_register_history (register_id, staff_id, change, before, after, reason, source, changed_by, changed_at) VALUES ($1,$2,$3,$4,$5,$6,'MANUAL',$7,$8)",
      [r.id, staffId, hold ? "HELD" : "RELEASED", JSON.stringify({ eligibilityStatus: r.eligibility_status }), JSON.stringify({ eligibilityStatus: hold ? "HELD" : "ELIGIBLE" }), why, ctx.actor!.staffId, ctx.now],
    );
    await audit(tx, ctx, { action: hold ? "SALARY_ELIGIBILITY_HELD" : "SALARY_ELIGIBILITY_RELEASED", actorRole: role, reason: why, details: { staffId } });
  });
}

// ------------------------------------------------------------------ CSV import (preview, then apply)

export const REGISTER_CSV_HEADERS = ["staff_id", "ad_identity", "employee_name", "monthly_salary", "salary_account_number", "salary_account_name", "employment_status", "salary_as_of"] as const;
export const REGISTER_CSV_TEMPLATE = `${REGISTER_CSV_HEADERS.join(",")}\nALT-00123,jane.doe@altbank.ng,Jane Doe,1900000.00,0123456789,Jane Doe,ACTIVE,2026-11-25\n`;

interface PreviewRow {
  line: number;
  staffId: string;
  name: string;
  email: string;
  v: { staffNumber: string; salary: number; accEnc: string; accLast4: string; name: string; status: EmploymentStatus; asOf: string };
  action: "CREATE" | "UPDATE" | "UNCHANGED";
  changed: string[];
}

export async function previewImport(ctx: Ctx, filename: string, data: Buffer) {
  if (staffAdvanceRetired()) registerRetired();
  return withTx(async (tx) => {
    await requireRegisterAdmin(tx, ctx);
    let table: string[][];
    try {
      table = await readCsv(data, 5 * 1024 * 1024);
    } catch (e) {
      throw invalid(`The file could not be read as CSV: ${(e as Error).message}`);
    }
    if (!table.length) throw invalid("The file is empty.");
    const head = table[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const missing = REGISTER_CSV_HEADERS.filter((h) => !head.includes(h));
    if (missing.length) throw invalid(`Missing columns: ${missing.join(", ")}. Download the template for the expected layout.`);
    const col = (row: string[], h: string) => (row[head.indexOf(h)] ?? "").trim();
    const errors: { line: number; message: string }[] = [];
    const rows: PreviewRow[] = [];
    const seenNo = new Map<string, number>();
    const seenEmail = new Map<string, number>();
    for (let i = 1; i < table.length; i++) {
      const r = table[i];
      const line = i + 1;
      if (r.every((c) => !c.trim())) continue;
      const email = col(r, "ad_identity").toLowerCase();
      const { errors: fe, value } = validateRecord(
        { staffNumber: col(r, "staff_id"), monthlySalary: col(r, "monthly_salary"), accountNumber: col(r, "salary_account_number"), accountName: col(r, "salary_account_name"), employmentStatus: col(r, "employment_status"), salaryAsOf: col(r, "salary_as_of") },
        ctx.now,
      );
      const problems = Object.values(fe);
      const no = value.staffNumber.toLowerCase();
      if (no && seenNo.has(no)) problems.push(`Duplicate staff ID (also on line ${seenNo.get(no)}).`);
      if (email && seenEmail.has(email)) problems.push(`Duplicate AD identity (also on line ${seenEmail.get(email)}).`);
      if (no) seenNo.set(no, line);
      if (email) seenEmail.set(email, line);
      const staff = email ? (await tx.query<{ id: string; full_name: string; email: string; status: string }>("SELECT id, full_name, email, status FROM staff WHERE lower(email) = $1", [email])).rows[0] : undefined;
      if (!email) problems.push("AD identity (sign-in email) is required.");
      else if (!staff) problems.push(`No ARAF staff profile signs in as ${email}.`);
      if (staff && no) {
        const clash = await tx.query("SELECT 1 FROM salary_register WHERE lower(staff_number) = $1 AND staff_id <> $2", [no, staff.id]);
        if (clash.rowCount) problems.push(`Staff ID ${value.staffNumber} is registered to another employee.`);
      }
      const nameInFile = col(r, "employee_name");
      if (staff && nameInFile && nameInFile.toLowerCase().replace(/\s+/g, " ") !== staff.full_name.toLowerCase().replace(/\s+/g, " ")) problems.push(`Name "${nameInFile}" does not match the staff profile (${staff.full_name}).`);
      if (problems.length || !staff) {
        errors.push({ line, message: problems.join(" ") });
        continue;
      }
      const before = await registerRecord(tx, staff.id);
      const changed = changedFields(before, value);
      rows.push({
        line,
        staffId: staff.id,
        name: staff.full_name,
        email: staff.email,
        v: { staffNumber: value.staffNumber, salary: value.salary, accEnc: encryptField(value.acct), accLast4: last4(value.acct), name: value.name, status: value.status, asOf: value.asOf },
        action: !before ? "CREATE" : changed.length ? "UPDATE" : "UNCHANGED",
        changed,
      });
    }
    const count = (a: PreviewRow["action"]) => rows.filter((r) => r.action === a).length;
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO salary_register_imports (filename, sha256, total_rows, valid_rows, error_rows, creates, updates, unchanged, errors, preview, uploaded_by, uploaded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [filename.slice(0, 200), createHash("sha256").update(data).digest("hex"), rows.length + errors.length, rows.length, errors.length, count("CREATE"), count("UPDATE"), count("UNCHANGED"), JSON.stringify(errors), JSON.stringify(rows), ctx.actor!.staffId, ctx.now],
      )
    ).rows[0].id;
    await audit(tx, ctx, { action: "SALARY_REGISTER_IMPORT_PREVIEWED", details: { importId: id, filename, valid: rows.length, errors: errors.length } });
    return id;
  });
}

export async function importView(q: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return (
    (
      await q.query<{
        id: string; filename: string; status: string; total_rows: number; valid_rows: number; error_rows: number; creates: number; updates: number; unchanged: number;
        errors: { line: number; message: string }[]; preview: PreviewRow[] | null; uploaded_at: Date; uploaded_by_name: string; decided_at: Date | null;
      }>("SELECT i.*, s.full_name AS uploaded_by_name FROM salary_register_imports i JOIN staff s ON s.id = i.uploaded_by WHERE i.id = $1", [id])
    ).rows[0] ?? null
  );
}

/** Apply a previewed import. Rows with errors are never applied; the valid rows are applied together. */
export async function applyImport(ctx: Ctx, id: string, decision: "APPLY" | "DISCARD") {
  if (staffAdvanceRetired()) registerRetired();
  return withTx(async (tx) => {
    const { role } = await requireRegisterAdmin(tx, ctx);
    const imp = (await tx.query<{ id: string; status: string; preview: PreviewRow[] | null; filename: string }>("SELECT * FROM salary_register_imports WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!imp) throw notFound("Import not found.");
    if (imp.status !== "PREVIEW") throw conflict("This import has already been applied or discarded.");
    let created = 0;
    let updated = 0;
    if (decision === "APPLY") {
      for (const r of imp.preview ?? []) {
        if (r.action === "UNCHANGED") continue;
        const staff = (await tx.query<{ id: string; full_name: string; email: string }>("SELECT id, full_name, email FROM staff WHERE id = $1", [r.staffId])).rows[0];
        const res = await writeRecord(tx, ctx, staff, { staffNumber: r.v.staffNumber, salary: r.v.salary, acct: decryptField(r.v.accEnc), name: r.v.name, status: r.v.status, asOf: r.v.asOf }, "CSV", id, `CSV import ${imp.filename}`, role);
        if (res === "CREATED") created++;
        if (res === "UPDATED") updated++;
      }
    }
    await tx.query("UPDATE salary_register_imports SET status = $2, preview = NULL, decided_by = $3, decided_at = $4 WHERE id = $1", [id, decision === "APPLY" ? "APPLIED" : "DISCARDED", ctx.actor!.staffId, ctx.now]);
    await audit(tx, ctx, { action: decision === "APPLY" ? "SALARY_REGISTER_IMPORT_APPLIED" : "SALARY_REGISTER_IMPORT_DISCARDED", actorRole: role, details: { importId: id, created, updated } });
    return { created, updated };
  });
}

export async function importHistory(q: Db) {
  return (
    await q.query<{ id: string; filename: string; status: string; valid_rows: number; error_rows: number; creates: number; updates: number; uploaded_at: Date; uploaded_by_name: string }>(
      "SELECT i.id, i.filename, i.status, i.valid_rows, i.error_rows, i.creates, i.updates, i.uploaded_at, s.full_name AS uploaded_by_name FROM salary_register_imports i JOIN staff s ON s.id = i.uploaded_by ORDER BY i.uploaded_at DESC LIMIT 30",
    )
  ).rows;
}

/** Register listing for administrators: record, exposure and availability per employee. */
export async function registerListing(q: Db, now: Date, search = "") {
  const s = await currentSettings(q);
  const rows = (
    await q.query<RegisterRow>(
      `SELECT r.*, r.monthly_salary_kobo::text, r.salary_as_of::text, u.full_name AS updated_by_name FROM salary_register r LEFT JOIN staff u ON u.id = r.updated_by
        WHERE $1 = '' OR r.employee_name ILIKE '%' || $1 || '%' OR r.staff_number ILIKE '%' || $1 || '%' OR r.ad_identity ILIKE '%' || $1 || '%'
        ORDER BY r.employee_name LIMIT 500`,
      [search.trim()],
    )
  ).rows;
  const out = [];
  for (const r of rows) out.push({ record: r, eligibility: await eligibilityFor(q, r.staff_id, now, s) });
  return out;
}

/** Active staff with no register record (exception list for administrators). */
export async function staffWithoutRecord(q: Db) {
  return (
    await q.query<{ id: string; full_name: string; email: string }>(
      `SELECT s.id, s.full_name, s.email FROM staff s WHERE s.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM salary_register r WHERE r.staff_id = s.id)
         AND EXISTS (SELECT 1 FROM staff_requests q WHERE q.applicant_id = s.id) ORDER BY s.full_name LIMIT 200`,
    )
  ).rows;
}

// ------------------------------------------------------------------ confirmed repayments

export async function recordRepayment(ctx: Ctx, requestId: string, p: { amount: string; valueDate: string; reference: string; source: string; note?: string }) {
  const errors: Record<string, string> = {};
  const amount = parseNairaToKobo((p.amount ?? "").trim());
  if (amount === null || amount <= 0) errors.amount = "Enter the repaid amount in naira.";
  if (!isValidDateString(p.valueDate)) errors.valueDate = "Enter the value date.";
  else if (p.valueDate > lagosDate(ctx.now)) errors.valueDate = "The value date cannot be in the future.";
  const ref = (p.reference ?? "").trim();
  if (!/^[A-Za-z0-9\-/_.]{4,64}$/.test(ref)) errors.reference = "Enter the payroll or transaction reference (4–64 letters, digits or - / _ .).";
  if (!["PAYROLL_DEDUCTION", "TRANSFER", "OTHER"].includes(p.source)) errors.source = "Choose how it was repaid.";
  if (Object.keys(errors).length) throw invalid("Check the repayment.", errors);
  return withTx(async (tx) => {
    const { role } = await requireRegisterAdmin(tx, ctx);
    const r = (await tx.query<{ id: string; ref: string; status: string; gross_kobo: string; applicant_id: string }>("SELECT id, ref, status, gross_kobo::text, applicant_id FROM staff_requests WHERE id = $1 FOR UPDATE", [requestId])).rows[0];
    if (!r) throw notFound("Advance not found.");
    if (r.status !== "COMPLETED") throw gate("Repayments are recorded only against a disbursed advance.");
    const repaid = Number((await tx.query<{ k: string }>("SELECT coalesce(sum(amount_kobo), 0)::text AS k FROM staff_advance_repayments WHERE request_id = $1", [requestId])).rows[0].k);
    const outstanding = Number(r.gross_kobo) - repaid;
    if (amount! > outstanding) throw invalid(`The amount is more than the outstanding balance (${formatNairaKobo(outstanding)}).`, { amount: "More than outstanding." });
    if ((await tx.query("SELECT 1 FROM staff_advance_repayments WHERE reference = $1", [ref])).rowCount) throw conflict("This reference is already recorded.");
    await tx.query(
      "INSERT INTO staff_advance_repayments (request_id, amount_kobo, value_date, reference, source, note, recorded_by, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [requestId, amount, p.valueDate, ref, p.source, (p.note ?? "").trim() || null, ctx.actor!.staffId, ctx.now],
    );
    await audit(tx, ctx, { action: "STAFF_ADVANCE_REPAYMENT_RECORDED", actorRole: role, staffRequestId: requestId, details: { reference: ref, source: p.source, valueDate: p.valueDate, settled: amount === outstanding } });
    return { outstanding: outstanding - amount!, settled: amount === outstanding };
  });
}

export async function repaymentHistory(q: Db, requestId: string) {
  return (
    await q.query<{ amount_kobo: string; value_date: string; reference: string; source: string; recorded_at: Date }>(
      "SELECT amount_kobo::text, value_date::text, reference, source, recorded_at FROM staff_advance_repayments WHERE request_id = $1 ORDER BY value_date, recorded_at",
      [requestId],
    )
  ).rows;
}

/** Disbursed advances with an outstanding balance (repayment recording screen). */
export async function openAdvances(q: Db) {
  return (
    await q.query<{ id: string; ref: string; full_name: string; gross_kobo: string; repaid_kobo: string; disbursed_at: Date }>(
      `SELECT r.id, r.ref, r.full_name, r.gross_kobo::text, coalesce(sum(p.amount_kobo), 0)::text AS repaid_kobo, r.disbursed_at
         FROM staff_requests r LEFT JOIN staff_advance_repayments p ON p.request_id = r.id
        WHERE r.status = 'COMPLETED' GROUP BY r.id HAVING r.gross_kobo > coalesce(sum(p.amount_kobo), 0) ORDER BY r.disbursed_at`,
    )
  ).rows;
}
