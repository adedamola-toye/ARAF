import type { Db, Tx } from "../db";
import { withTx, db } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { config } from "../config";
import { DomainError, conflict, forbidden, invalid, notFound } from "../errors";
import { revokeAllSessions } from "../auth/session";
import { holdsRole } from "./access";
import { type AppRow, assignmentSpec, eligibleStaff, notifyAssignment } from "./assignment";
import { REGION_REQUIRED_ROLES, SINGLE_HOLDER_ROLES, isRegion, isRole, normaliseNigerianState, type Role } from "./roles";
import type { Stage } from "./stages";
import { validateTemplate, DOCX_MIME } from "./offer";
import { assertDocx, validateDocxTemplate } from "./offer-docx";
import type { ApplicantType } from "./application-data";
import { objectStore } from "../storage";
import { randomUUID } from "node:crypto";
import { readSpreadsheet } from "./directory";

async function requireSuperAdmin(tx: Tx, ctx: Ctx) {
  if (!ctx.actor || !(await holdsRole(tx, ctx.actor.staffId, "SUPER_ADMIN"))) throw forbidden("Super Admin access is required.");
}

/** Wrap admin operations so denied attempts are audited even though the transaction rolls back. */
async function adminOp<T>(ctx: Ctx, action: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await withTx(async (tx) => {
      await requireSuperAdmin(tx, ctx);
      return fn(tx);
    });
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") await auditOutsideTx(ctx, { action, outcome: "DENIED", reason: e.message });
    throw e;
  }
}

export function isStaffDomain(email: string) {
  return email.toLowerCase().endsWith(`@${config.staffEmailDomain}`);
}

/** Validate an internal address against the configured bank directory (allowlist). */
export async function directoryEntry(q: Db, email: string) {
  return (await q.query<{ email: string; full_name: string; is_group_mailbox: boolean; active: boolean }>("SELECT * FROM bank_directory WHERE email = $1", [email.toLowerCase()])).rows[0] ?? null;
}

export async function provisionStaff(ctx: Ctx, p: { email: string; fullName: string; region?: string | null; businessUnit?: string | null; role?: string | null }) {
  return adminOp(ctx, "STAFF_PROVISIONED", async (tx) => {
    const email = p.email.trim().toLowerCase();
    if (!isStaffDomain(email) || !/^[a-z0-9._%+-]+@[a-z0-9.-]+$/.test(email)) throw invalid(`Staff must use a verified @${config.staffEmailDomain} email.`, { email: "Invalid email." });
    const dir = await directoryEntry(tx, email);
    if (!dir || !dir.active) throw invalid("This email is not in the bank directory (verification failed).", { email: "Not found in the bank directory." });
    if (dir.is_group_mailbox) throw invalid("Group mailboxes cannot be provisioned as staff.", { email: "Group mailbox." });
    if (p.region && !isRegion(p.region)) throw invalid("Unknown state.", { region: "Unknown state." });
    if (p.role && !isRole(p.role)) throw invalid("Unknown role.", { role: "Unknown role." });
    const exists = await tx.query("SELECT 1 FROM staff WHERE email = $1", [email]);
    if (exists.rowCount) throw conflict("A staff record already exists for this email.");
    const r = await tx.query<{ id: string }>(
      `INSERT INTO staff (email, full_name, region, business_unit, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
      [email, p.fullName.trim() || dir.full_name, p.region || null, p.businessUnit?.trim() || null, ctx.actor!.staffId, ctx.now],
    );
    if (p.role) {
      await grantRoleInTx(tx, ctx, { staffId: r.rows[0].id, role: p.role, region: p.region ?? null, businessUnit: p.businessUnit ?? null });
    }
    await audit(tx, ctx, { action: "STAFF_PROVISIONED", actorRole: "SUPER_ADMIN", details: { staffId: r.rows[0].id, email, region: p.region ?? null, role: p.role ?? null } });
    return r.rows[0].id;
  });
}

export async function setStaffStatus(ctx: Ctx, staffId: string, status: "ACTIVE" | "SUSPENDED") {
  return adminOp(ctx, "STAFF_STATUS_CHANGED", async (tx) => {
    if (staffId === ctx.actor!.staffId) throw forbidden("You cannot change your own status.");
    const r = await tx.query("UPDATE staff SET status = $2, updated_at = $3 WHERE id = $1 RETURNING id", [staffId, status, ctx.now]);
    if (!r.rowCount) throw notFound();
    if (status === "SUSPENDED") {
      await revokeAllSessions(tx, ctx, staffId, "STAFF_SUSPENDED");
      await unassignOpenTasks(tx, ctx, staffId, null);
    }
    await audit(tx, ctx, { action: "STAFF_STATUS_CHANGED", actorRole: "SUPER_ADMIN", details: { staffId, status } });
  });
}

async function grantRoleInTx(tx: Tx, ctx: Ctx, p: { staffId: string; role: string; region?: string | null; businessUnit?: string | null; team?: string | null }) {
  if (!isRole(p.role)) throw invalid("Unknown role.");
  if (p.staffId === ctx.actor!.staffId) throw forbidden("Super Admins cannot change their own role assignments.");
  const staff = (await tx.query("SELECT * FROM staff WHERE id = $1 FOR UPDATE", [p.staffId])).rows[0];
  if (!staff) throw notFound();
  if (staff.status !== "ACTIVE") throw invalid("Reactivate the staff member before assigning roles.");
  const region = p.region || staff.region || null;
  if (REGION_REQUIRED_ROLES.includes(p.role) && !region) throw invalid("This role requires a state.", { region: "Required." });
  if (region && !isRegion(region)) throw invalid("Unknown state.");
  const team = (p.team ?? "").trim().toUpperCase() || null;
  if (team && !/^[A-Z0-9][A-Z0-9 _-]{1,40}$/.test(team)) throw invalid("Team codes use letters, digits, spaces, - or _.", { team: "Invalid team." });
  if (["RM", "TEAM_LEAD"].includes(p.role) && !team) throw invalid("Relationship Managers and Team Leads need a team so requests can be routed to the right Team Lead.", { team: "Team required." });
  if (SINGLE_HOLDER_ROLES.includes(p.role)) {
    const holder = await tx.query("SELECT staff_id FROM role_assignments WHERE role = $1 AND active FOR UPDATE", [p.role]);
    if (holder.rowCount) throw conflict("This position already has an active holder. Revoke it first.");
  }
  if (p.role === "LEGAL_REVIEWER" || p.role === "SHARIAH_REVIEWER") {
    const g = p.role === "LEGAL_REVIEWER" ? "LEGAL" : "SHARIAH";
    const m = await tx.query("SELECT 1 FROM recipient_group_members WHERE group_code = $1 AND email = $2", [g, staff.email]);
    if (!m.rowCount) throw invalid(`Add ${staff.email} to the approved ${g === "LEGAL" ? "Legal" : "Shariah Compliance"} recipient group first.`);
  }
  try {
    await tx.query(
      `INSERT INTO role_assignments (staff_id, role, region, business_unit, granted_by, granted_at, team) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [p.staffId, p.role, region, p.businessUnit?.trim() || staff.business_unit || null, ctx.actor!.staffId, ctx.now, team],
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw conflict("The staff member already holds this role.");
    throw e;
  }
  await audit(tx, ctx, { action: "ROLE_GRANTED", actorRole: "SUPER_ADMIN", details: { staffId: p.staffId, role: p.role, region, team } });
}

export async function grantRole(ctx: Ctx, p: { staffId: string; role: string; region?: string | null; businessUnit?: string | null; team?: string | null }) {
  return adminOp(ctx, "ROLE_GRANTED", (tx) => grantRoleInTx(tx, ctx, p));
}

export async function revokeRole(ctx: Ctx, p: { staffId: string; role: string }) {
  return adminOp(ctx, "ROLE_REVOKED", async (tx) => {
    if (p.staffId === ctx.actor!.staffId) throw forbidden("Super Admins cannot change their own role assignments.");
    const r = await tx.query(
      "UPDATE role_assignments SET active = false, revoked_by = $3, revoked_at = $4 WHERE staff_id = $1 AND role = $2 AND active RETURNING id",
      [p.staffId, p.role, ctx.actor!.staffId, ctx.now],
    );
    if (!r.rowCount) throw notFound("Active assignment not found.");
    const moved = await unassignOpenTasks(tx, ctx, p.staffId, p.role);
    await audit(tx, ctx, { action: "ROLE_REVOKED", actorRole: "SUPER_ADMIN", details: { staffId: p.staffId, role: p.role, tasksUnassigned: moved } });
  });
}

/** Open tasks held under a revoked role (or by a suspended person) become unassigned exceptions. */
async function unassignOpenTasks(tx: Tx, ctx: Ctx, staffId: string, role: string | null): Promise<number> {
  const tasks = (
    await tx.query(
      `SELECT * FROM tasks WHERE assignee_id = $1 AND status = 'OPEN' ${role ? "AND assignee_role = $2" : ""} FOR UPDATE`,
      role ? [staffId, role] : [staffId],
    )
  ).rows;
  for (const t of tasks) {
    await tx.query("UPDATE tasks SET assignee_id = NULL, assigned_at = NULL WHERE id = $1", [t.id]);
    await tx.query(
      `INSERT INTO assignment_changes (task_id, from_staff_id, to_staff_id, method, changed_by, changed_at) VALUES ($1,$2,NULL,'UNASSIGNED_ON_REVOKE',$3,$4)`,
      [t.id, staffId, ctx.actor?.staffId ?? null, ctx.now],
    );
    await audit(tx, ctx, { action: "TASK_UNASSIGNED", applicationId: t.application_id, stage: t.stage, assignmentFrom: staffId, details: { taskId: t.id, reason: role ? "ROLE_REVOKED" : "STAFF_SUSPENDED" } });
  }
  return tasks.length;
}

/** Eligible assignees for an open task, using the same rules as automatic routing. */
export async function eligibleForTask(taskId: string) {
  return withTx(async (tx) => {
    const t = (await tx.query("SELECT * FROM tasks WHERE id = $1", [taskId])).rows[0];
    if (!t) throw notFound();
    const app = (await tx.query<AppRow>("SELECT * FROM applications WHERE id = $1", [t.application_id])).rows[0];
    const spec = await assignmentSpec(tx, app, t.stage as Stage);
    if (spec.only && spec.only.filter(Boolean).length === 0) return [];
    return eligibleStaff(tx, spec.roles, spec.exclude, { team: spec.team, only: spec.only });
  });
}

/** Super Admin resolves a missing assignee (or hands over an assignment) to an eligible officer. */
export async function adminAssignTask(ctx: Ctx, taskId: string, staffId: string, note: string) {
  return adminOp(ctx, "TASK_REASSIGNED", async (tx) => {
    if (!note || note.trim().length < 3) throw invalid("Enter a reason for the assignment.", { note: "Required." });
    if (staffId === ctx.actor!.staffId) throw forbidden("You cannot assign a task to yourself.");
    const t = (await tx.query("SELECT * FROM tasks WHERE id = $1", [taskId])).rows[0];
    if (!t) throw notFound();
    const app = (await tx.query<AppRow>("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [t.application_id])).rows[0];
    const task = (await tx.query("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [taskId])).rows[0];
    if (task.status !== "OPEN") throw conflict("This task is no longer open.");
    const spec = await assignmentSpec(tx, app, task.stage as Stage);
    const pool = await eligibleStaff(tx, spec.roles, spec.exclude);
    const pick = pool.find((p) => p.staff_id === staffId);
    if (!pick) throw invalid("The selected officer is not eligible for this stage (role, status or separation of duties).");
    await tx.query("UPDATE tasks SET assignee_id = $2, assignee_role = $3, assigned_at = $4 WHERE id = $1", [taskId, staffId, pick.role, ctx.now]);
    await tx.query(
      `INSERT INTO assignment_changes (task_id, from_staff_id, to_staff_id, method, eligible_pool, changed_by, changed_at) VALUES ($1,$2,$3,'ADMIN',$4,$5,$6)`,
      [taskId, task.assignee_id, staffId, JSON.stringify(pool.map((p) => ({ id: p.staff_id, role: p.role }))), ctx.actor!.staffId, ctx.now],
    );
    const col: Partial<Record<Stage, string>> = {
      FIRST_CREDIT_REVIEW: "first_reviewer_id",
      CREDIT_CORRECTION: "first_reviewer_id",
      SECOND_CREDIT_REVIEW: "second_reviewer_id",
      CO3_PACK_REVIEW: "pack_co3_id",
      DISBURSEMENT_CORRECTION: "pack_co3_id",
      COMPLETION: "pack_co3_id",
      DISBURSEMENT_CHECK: "do1_id",
      DISBURSEMENT_BOOKING: "do2_id",
    };
    const c = col[task.stage as Stage];
    if (c) await tx.query(`UPDATE applications SET ${c} = $2, lock_version = lock_version + 1, updated_at = $3 WHERE id = $1`, [app.id, staffId, ctx.now]);
    await audit(tx, ctx, { action: "TASK_REASSIGNED", actorRole: "SUPER_ADMIN", applicationId: app.id, stage: task.stage, reason: note, assignmentFrom: task.assignee_id, assignmentTo: staffId, details: { taskId } });
    await notifyAssignment(tx, ctx, app, taskId, task.stage as Stage, staffId, `:admin:${ctx.now.getTime()}`);
  });
}

// ------------------------------------------------------------------ recipient groups & directory

export async function addGroupMember(ctx: Ctx, group: string, rawEmail: string) {
  return adminOp(ctx, "GROUP_MEMBER_ADDED", async (tx) => {
    if (group !== "LEGAL" && group !== "SHARIAH") throw invalid("Unknown group.");
    const email = rawEmail.trim().toLowerCase();
    if (!isStaffDomain(email)) throw invalid(`Recipients must be internal @${config.staffEmailDomain} addresses.`);
    const dir = await directoryEntry(tx, email);
    if (!dir || !dir.active) throw invalid("This address is not in the bank directory allowlist.");
    await tx.query("INSERT INTO recipient_group_members (group_code, email, added_by, added_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [group, email, ctx.actor!.staffId, ctx.now]);
    await audit(tx, ctx, { action: "GROUP_MEMBER_ADDED", actorRole: "SUPER_ADMIN", details: { group, email } });
  });
}
export async function removeGroupMember(ctx: Ctx, group: string, email: string) {
  return adminOp(ctx, "GROUP_MEMBER_REMOVED", async (tx) => {
    await tx.query("DELETE FROM recipient_group_members WHERE group_code = $1 AND email = $2", [group, email.toLowerCase()]);
    await audit(tx, ctx, { action: "GROUP_MEMBER_REMOVED", actorRole: "SUPER_ADMIN", details: { group, email } });
  });
}

// ------------------------------------------------------------------ offer templates

export async function createTemplateVersion(ctx: Ctx, p: { name: string; bodyHtml: string; productionApproved: boolean; notes?: string }) {
  return adminOp(ctx, "TEMPLATE_CREATED", async (tx) => {
    const errors = validateTemplate(p.bodyHtml);
    if (errors.length) throw invalid(errors.join(" "));
    const v = (await tx.query<{ max: number | null }>("SELECT max(version) AS max FROM offer_templates WHERE name = $1", [p.name])).rows[0].max ?? 0;
    const r = await tx.query<{ id: string }>(
      `INSERT INTO offer_templates (name, version, body_html, status, production_approved, notes, created_by, created_at) VALUES ($1,$2,$3,'DRAFT',$4,$5,$6,$7) RETURNING id`,
      [p.name.trim(), v + 1, p.bodyHtml, p.productionApproved, p.notes ?? null, ctx.actor!.staffId, ctx.now],
    );
    await audit(tx, ctx, { action: "TEMPLATE_CREATED", actorRole: "SUPER_ADMIN", details: { templateId: r.rows[0].id, name: p.name, version: v + 1, productionApproved: p.productionApproved } });
    return r.rows[0].id;
  });
}
export async function activateTemplate(ctx: Ctx, templateId: string) {
  return adminOp(ctx, "TEMPLATE_ACTIVATED", async (tx) => {
    const t = (await tx.query("SELECT * FROM offer_templates WHERE id = $1", [templateId])).rows[0];
    if (!t) throw notFound();
    // One active template per applicant type: retire only the one it replaces.
    await tx.query(
      `UPDATE offer_templates SET status = 'RETIRED' WHERE status = 'ACTIVE' AND coalesce(applicant_type,'ALL') = coalesce($1,'ALL')
          AND coalesce(product_code,'WAKEELBOOST') = coalesce($2,'WAKEELBOOST') AND coalesce(structure,'ALL') = coalesce($3,'ALL')`,
      [t.applicant_type, t.product_code, t.structure],
    );
    await tx.query("UPDATE offer_templates SET status = 'ACTIVE', activated_by = $2, activated_at = $3 WHERE id = $1", [templateId, ctx.actor!.staffId, ctx.now]);
    await audit(tx, ctx, { action: "TEMPLATE_ACTIVATED", actorRole: "SUPER_ADMIN", details: { templateId, name: t.name, version: t.version } });
  });
}

// ------------------------------------------------------------------ schedules

export async function updateMonthlySchedule(ctx: Ctx, p: { enabled: boolean; dayOfMonth: number; hour: number; minute: number; recipientIds: string[] }) {
  return adminOp(ctx, "SCHEDULE_UPDATED", async (tx) => {
    if (p.dayOfMonth < 1 || p.dayOfMonth > 28 || p.hour < 0 || p.hour > 23 || p.minute < 0 || p.minute > 59) throw invalid("Invalid schedule.");
    for (const id of p.recipientIds) {
      const s = await tx.query("SELECT 1 FROM staff WHERE id = $1 AND status = 'ACTIVE'", [id]);
      if (!s.rowCount) throw invalid("Recipients must be active provisioned staff.");
    }
    await tx.query(
      `UPDATE schedule_settings SET enabled=$1, day_of_month=$2, hour=$3, minute=$4, recipient_staff_ids=$5, updated_by=$6, updated_at=$7 WHERE code='MONTHLY_REPORT'`,
      [p.enabled, p.dayOfMonth, p.hour, p.minute, p.recipientIds, ctx.actor!.staffId, ctx.now],
    );
    await audit(tx, ctx, { action: "SCHEDULE_UPDATED", actorRole: "SUPER_ADMIN", details: { code: "MONTHLY_REPORT", ...p } });
  });
}

export async function isSuperAdmin(staffId: string) {
  return holdsRole(db, staffId, "SUPER_ADMIN");
}
export type { Role };

/** Upload a new DOCX offer template version for an applicant type (saved as DRAFT until activated). */
export async function createDocxTemplateVersion(ctx: Ctx, p: { name: string; applicantType: string; filename: string; data: Buffer; productionApproved: boolean; notes?: string }) {
  if (!["INDIVIDUAL", "ENTERPRISE", "LIMITED"].includes(p.applicantType)) throw invalid("Choose the applicant type this template is for.");
  assertDocx(p.data);
  const errors = await validateDocxTemplate(p.data, p.applicantType as ApplicantType);
  if (errors.length) throw invalid(`The template cannot be used: ${errors.join(" ")}`);
  const key = `templates/offer/${randomUUID()}.docx`;
  await objectStore().put(key, p.data, DOCX_MIME);
  return adminOp(ctx, "TEMPLATE_CREATED", async (tx) => {
    const v = (await tx.query<{ max: number | null }>("SELECT max(version) AS max FROM offer_templates WHERE name = $1 AND applicant_type = $2", [p.name.trim(), p.applicantType])).rows[0].max ?? 0;
    const r = await tx.query<{ id: string }>(
      `INSERT INTO offer_templates (name, version, format, applicant_type, storage_key, source_filename, status, production_approved, approved_by, approved_at, notes, created_by, created_at)
       VALUES ($1,$2,'DOCX',$3,$4,$5,'DRAFT',$6,$7,$8,$9,$10,$11) RETURNING id`,
      [p.name.trim(), v + 1, p.applicantType, key, p.filename.slice(0, 200), p.productionApproved, p.productionApproved ? ctx.actor!.staffId : null, p.productionApproved ? ctx.now : null, p.notes ?? null, ctx.actor!.staffId, ctx.now],
    );
    await audit(tx, ctx, { action: "TEMPLATE_CREATED", actorRole: "SUPER_ADMIN", details: { templateId: r.rows[0].id, name: p.name, applicantType: p.applicantType, version: v + 1, format: "DOCX", productionApproved: p.productionApproved } });
    return r.rows[0].id;
  });
}

/** Record the bank's approval of a template version for production offers. */
export async function approveTemplate(ctx: Ctx, templateId: string) {
  return adminOp(ctx, "TEMPLATE_APPROVED", async (tx) => {
    const r = await tx.query("UPDATE offer_templates SET production_approved = true, approved_by = $2, approved_at = $3 WHERE id = $1 AND NOT production_approved RETURNING name, version, applicant_type", [templateId, ctx.actor!.staffId, ctx.now]);
    if (!r.rowCount) throw conflict("Template not found or already approved.");
    await audit(tx, ctx, { action: "TEMPLATE_APPROVED", actorRole: "SUPER_ADMIN", details: { templateId, ...r.rows[0] } });
  });
}

// ------------------------------------------------------------------ bulk provisioning and bulk role assignment

export const STAFF_TEMPLATE_CSV = "Full name,Email,State,Business unit\nAdaeze Example,adaeze.example@altbank.ng,LAGOS,Retail\nMusa Example,musa.example@altbank.ng,,Finance\n";
export const MAX_BULK_STAFF_ROWS = 5000;

export interface BulkStaffRow {
  row: number;
  email: string;
  fullName: string;
  region: string | null;
  businessUnit: string | null;
  outcome: "NEW" | "EXISTS" | "ERROR";
  /** Not in the bank directory: added to it only when the admin chose to. */
  addsToDirectory?: boolean;
  message?: string;
}
export interface BulkStaffSummary {
  filename: string;
  totalRows: number;
  toCreate: number;
  existing: number;
  errors: number;
  addsToDirectory: number;
  rows: BulkStaffRow[];
  applied: boolean;
  created: number;
}

/** "Lagos", "lagos state", "Abuja", "FCT" … → the state as ARAF stores it ("LAGOS", "FCT (ABUJA)"). */
export function normaliseState(v: string): string | null {
  const s = v.toUpperCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").replace(/\s+STATE$/, "").trim();
  if (!s) return null;
  return normaliseNigerianState(s) ?? s; // unresolved labels are returned as written so validation reports them
}
const headerKey = (h: string) => h.toLowerCase().replace(/[^a-z]/g, "");
const COLS: Record<string, string[]> = {
  email: ["email", "emailaddress", "workemail", "mail"],
  fullName: ["fullname", "name", "staffname", "employeename"],
  region: ["state", "region", "location"],
  businessUnit: ["businessunit", "unit", "department", "dept"],
};

/**
 * Bulk staff provisioning from a spreadsheet of names and emails. Rows are checked exactly like single
 * provisioning (verified @altbank.ng email, bank directory entry, known state); people who already have a
 * staff record are left alone. With `addToDirectory`, emails missing from the bank directory are added to it
 * (audited) instead of being refused. Nothing is saved on a dry run; on commit, valid new rows are created in
 * one transaction and rows with problems are skipped and reported. No roles are granted here.
 */
export async function bulkProvisionStaff(ctx: Ctx, p: { filename: string; data: Buffer; dryRun: boolean; addToDirectory: boolean }): Promise<BulkStaffSummary> {
  const grid = await readSpreadsheet(p.filename, p.data);
  const header = (grid[0] ?? []).map(headerKey);
  const col = (k: string) => header.findIndex((h) => COLS[k].includes(h));
  const ci = { email: col("email"), fullName: col("fullName"), region: col("region"), businessUnit: col("businessUnit") };
  if (ci.email < 0 || ci.fullName < 0) throw invalid("The file needs an Email column and a Full name column (download the template).");
  const body = grid.slice(1).filter((r) => r.some((c) => String(c ?? "").trim()));
  if (body.length === 0) throw invalid("The file has no staff rows.");
  if (body.length > MAX_BULK_STAFF_ROWS) throw invalid(`Upload at most ${MAX_BULK_STAFF_ROWS.toLocaleString()} rows at a time.`);

  return adminOp(ctx, "STAFF_BULK_PROVISIONED", async (tx) => {
    const cell = (r: string[], i: number) => (i >= 0 ? String(r[i] ?? "").replace(/\s+/g, " ").trim() : "");
    const parsed = body.map((r, i) => ({
      row: i + 2,
      email: cell(r, ci.email).toLowerCase(),
      fullName: cell(r, ci.fullName),
      region: normaliseState(cell(r, ci.region)),
      businessUnit: cell(r, ci.businessUnit).slice(0, 80) || null,
    }));
    const emails = parsed.map((x) => x.email).filter(Boolean);
    const staffSet = new Set((await tx.query<{ email: string }>("SELECT email FROM staff WHERE email = ANY($1)", [emails])).rows.map((r) => r.email));
    const dir = new Map((await tx.query<{ email: string; active: boolean; is_group_mailbox: boolean }>("SELECT email, active, is_group_mailbox FROM bank_directory WHERE email = ANY($1)", [emails])).rows.map((r) => [r.email, r]));
    const seen = new Set<string>();
    const rows: BulkStaffRow[] = parsed.map((x) => {
      const problems: string[] = [];
      let addsToDirectory = false;
      if (!/^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(x.email)) problems.push(x.email ? "email is not valid" : "email is missing");
      else if (!isStaffDomain(x.email)) problems.push(`email must be an @${config.staffEmailDomain} address`);
      if (x.fullName.replace(/[^a-z]/gi, "").length < 2) problems.push("full name is missing");
      if (x.region && !isRegion(x.region)) problems.push(`"${x.region}" is not a Nigerian state`);
      if (x.email && seen.has(x.email)) problems.push("email appears more than once in the file");
      if (x.email) seen.add(x.email);
      if (!problems.length && staffSet.has(x.email)) return { ...x, outcome: "EXISTS" as const, message: "Already provisioned; left unchanged." };
      if (!problems.length) {
        const d = dir.get(x.email);
        if (d?.is_group_mailbox) problems.push("group mailboxes cannot be staff");
        else if (d && !d.active) problems.push("marked as no longer active in the bank directory");
        else if (!d) {
          if (p.addToDirectory) addsToDirectory = true;
          else problems.push("not in the bank directory (upload the directory, or tick “Also add them to the bank directory”)");
        }
      }
      return problems.length ? { ...x, outcome: "ERROR" as const, message: problems.join("; ") } : { ...x, outcome: "NEW" as const, addsToDirectory };
    });
    const fresh = rows.filter((r) => r.outcome === "NEW");
    const summary: BulkStaffSummary = {
      filename: p.filename.slice(0, 200),
      totalRows: rows.length,
      toCreate: fresh.length,
      existing: rows.filter((r) => r.outcome === "EXISTS").length,
      errors: rows.filter((r) => r.outcome === "ERROR").length,
      addsToDirectory: fresh.filter((r) => r.addsToDirectory).length,
      rows,
      applied: false,
      created: 0,
    };
    if (p.dryRun) return summary;
    for (const r of fresh) {
      if (r.addsToDirectory) {
        await tx.query("INSERT INTO bank_directory (email, full_name, source, updated_at) VALUES ($1,$2,'staff-bulk-upload',$3) ON CONFLICT (email) DO NOTHING", [r.email, r.fullName, ctx.now]);
      }
      const ins = await tx.query<{ id: string }>(
        "INSERT INTO staff (email, full_name, region, business_unit, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (email) DO NOTHING RETURNING id",
        [r.email, r.fullName, r.region, r.businessUnit, ctx.actor!.staffId, ctx.now],
      );
      if (!ins.rows[0]) continue; // provisioned by someone else a moment ago
      summary.created++;
      await audit(tx, ctx, { action: "STAFF_PROVISIONED", actorRole: "SUPER_ADMIN", details: { staffId: ins.rows[0].id, email: r.email, region: r.region, via: "bulk upload", addedToDirectory: !!r.addsToDirectory } });
    }
    summary.applied = true;
    await audit(tx, ctx, { action: "STAFF_BULK_PROVISIONED", actorRole: "SUPER_ADMIN", details: { filename: summary.filename, rows: summary.totalRows, created: summary.created, alreadyProvisioned: summary.existing, skippedWithErrors: summary.errors, addedToDirectory: summary.addsToDirectory } });
    return summary;
  });
}

export interface BulkGrantResult {
  granted: number;
  alreadyHeld: number;
  failed: { staffId: string; name: string; message: string }[];
}

/**
 * Assign one role to many staff at once. Each person goes through exactly the same checks and audit as a
 * single grant (state, team, single-holder positions, recipient groups, not your own roles); anyone who
 * cannot be given the role is reported and the rest are still granted.
 */
export async function bulkGrantRole(ctx: Ctx, p: { staffIds: string[]; role: string; region?: string | null; team?: string | null; businessUnit?: string | null }): Promise<BulkGrantResult> {
  const ids = [...new Set(p.staffIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x)))];
  if (!ids.length) throw invalid("Select at least one staff member.");
  if (ids.length > 500) throw invalid("Assign roles to at most 500 people at a time.");
  if (!isRole(p.role)) throw invalid("Choose a role.", { role: "Required." });
  await adminOp(ctx, "ROLE_BULK_GRANTED", async () => undefined); // Super Admin only (denials audited)
  const names = new Map((await db.query<{ id: string; full_name: string }>("SELECT id, full_name FROM staff WHERE id = ANY($1)", [ids])).rows.map((r) => [r.id, r.full_name]));
  const out: BulkGrantResult = { granted: 0, alreadyHeld: 0, failed: [] };
  for (const staffId of ids) {
    try {
      await grantRole(ctx, { staffId, role: p.role, region: p.region || null, team: p.team || null, businessUnit: p.businessUnit || null });
      out.granted++;
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      if (e.code === "FORBIDDEN" && /Super Admin access is required/.test(e.message)) throw e;
      if (e.code === "CONFLICT" && /already holds this role/.test(e.message)) out.alreadyHeld++;
      else out.failed.push({ staffId, name: names.get(staffId) ?? staffId, message: e.message });
    }
  }
  await auditOutsideTx(ctx, { action: "ROLE_BULK_GRANTED", actorRole: "SUPER_ADMIN", details: { role: p.role, region: p.region || null, team: p.team || null, selected: ids.length, granted: out.granted, alreadyHeld: out.alreadyHeld, failed: out.failed.length } });
  return out;
}
