import type { Db, Tx } from "../db";
import { withTx, db } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { config } from "../config";
import { DomainError, conflict, forbidden, invalid, notFound } from "../errors";
import { revokeAllSessions } from "../auth/session";
import { holdsRole } from "./access";
import { type AppRow, assignmentSpec, eligibleStaff, notifyAssignment } from "./assignment";
import { REGIONS, REGION_REQUIRED_ROLES, SINGLE_HOLDER_ROLES, isRole, type Role } from "./roles";
import type { Stage } from "./stages";
import { validateTemplate } from "./offer";

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

export async function provisionStaff(ctx: Ctx, p: { email: string; fullName: string; region?: string | null; businessUnit?: string | null }) {
  return adminOp(ctx, "STAFF_PROVISIONED", async (tx) => {
    const email = p.email.trim().toLowerCase();
    if (!isStaffDomain(email) || !/^[a-z0-9._%+-]+@[a-z0-9.-]+$/.test(email)) throw invalid(`Staff must use a verified @${config.staffEmailDomain} email.`, { email: "Invalid email." });
    const dir = await directoryEntry(tx, email);
    if (!dir || !dir.active) throw invalid("This email is not in the bank directory (verification failed).", { email: "Not found in the bank directory." });
    if (dir.is_group_mailbox) throw invalid("Group mailboxes cannot be provisioned as staff.", { email: "Group mailbox." });
    if (p.region && !(REGIONS as readonly string[]).includes(p.region)) throw invalid("Unknown region.");
    const exists = await tx.query("SELECT 1 FROM staff WHERE email = $1", [email]);
    if (exists.rowCount) throw conflict("A staff record already exists for this email.");
    const r = await tx.query<{ id: string }>(
      `INSERT INTO staff (email, full_name, region, business_unit, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
      [email, p.fullName.trim() || dir.full_name, p.region || null, p.businessUnit?.trim() || null, ctx.actor!.staffId, ctx.now],
    );
    await audit(tx, ctx, { action: "STAFF_PROVISIONED", actorRole: "SUPER_ADMIN", details: { staffId: r.rows[0].id, email, region: p.region ?? null } });
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

export async function grantRole(ctx: Ctx, p: { staffId: string; role: string; region?: string | null; businessUnit?: string | null }) {
  return adminOp(ctx, "ROLE_GRANTED", async (tx) => {
    if (!isRole(p.role)) throw invalid("Unknown role.");
    if (p.staffId === ctx.actor!.staffId) throw forbidden("Super Admins cannot change their own role assignments.");
    const staff = (await tx.query("SELECT * FROM staff WHERE id = $1 FOR UPDATE", [p.staffId])).rows[0];
    if (!staff) throw notFound();
    if (staff.status !== "ACTIVE") throw invalid("Reactivate the staff member before assigning roles.");
    const region = p.region || staff.region || null;
    if (REGION_REQUIRED_ROLES.includes(p.role) && !region) throw invalid("This role requires a region (North or South).", { region: "Required." });
    if (region && !(REGIONS as readonly string[]).includes(region)) throw invalid("Unknown region.");
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
        `INSERT INTO role_assignments (staff_id, role, region, business_unit, granted_by, granted_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [p.staffId, p.role, region, p.businessUnit?.trim() || staff.business_unit || null, ctx.actor!.staffId, ctx.now],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw conflict("The staff member already holds this role.");
      throw e;
    }
    await audit(tx, ctx, { action: "ROLE_GRANTED", actorRole: "SUPER_ADMIN", details: { staffId: p.staffId, role: p.role, region } });
  });
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
    return eligibleStaff(tx, spec.roles, spec.exclude);
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
    await tx.query("UPDATE offer_templates SET status = 'RETIRED' WHERE status = 'ACTIVE'");
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
