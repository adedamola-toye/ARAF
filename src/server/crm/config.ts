/**
 * CRM configuration (Super Admin): complaint catalogue, teams and membership, routing rules, SLA policies,
 * business calendar, escalation rules, closure policy and report schedules. Every change needs a reason,
 * takes effect immediately and is audited with the previous and new values. Existing tickets keep the
 * names, team, priority and deadlines they were created with: configuration never rewrites history.
 */
import { withTx, type Tx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { holdsRole } from "../domain/access";
import { isValidDateString } from "../time";
import { FALLBACK_TEAM_ID, crmProducts, isPriority } from "./core";

const uuidRe = /^[0-9a-f-]{36}$/i;
const nz = (v: unknown) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim());

async function asAdmin<T>(ctx: Ctx, reason: string, fn: (tx: Tx, reason: string) => Promise<T>): Promise<T> {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const why = String(reason ?? "").trim();
  if (why.length < 10) throw invalid("Give a reason for the change (at least 10 characters).", { reason: "Give a reason." });
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only the Super Admin can change the CRM configuration.");
    return fn(tx, why);
  });
}

async function cfgAudit(tx: Tx, ctx: Ctx, action: string, reason: string, details: Record<string, unknown>) {
  await audit(tx, ctx, { action, actorRole: "SUPER_ADMIN", reason, details });
}

async function validProduct(tx: Tx, code: string | null) {
  if (code === null) return null;
  if (!(await crmProducts(tx, { includeInactive: true })).some((p) => p.code === code)) throw invalid("Unknown product or area.", { productCode: "Unknown." });
  return code;
}

// ------------------------------------------------------------------ catalogue

export async function saveCategory(ctx: Ctx, p: { id?: string | null; name: string; description?: string | null; active: boolean; sortOrder?: number; reason: string }) {
  const name = String(p.name ?? "").trim();
  if (name.length < 2 || name.length > 80) throw invalid("Give the category a name (2–80 characters).", { name: "Required." });
  return asAdmin(ctx, p.reason, async (tx, why) => {
    const sort = Number.isFinite(p.sortOrder) ? Math.trunc(p.sortOrder!) : 100;
    if (p.id) {
      const before = (await tx.query("SELECT * FROM crm_categories WHERE id = $1 FOR UPDATE", [p.id])).rows[0];
      if (!before) throw notFound();
      await tx.query("UPDATE crm_categories SET name = $2, description = $3, active = $4, sort_order = $5, updated_by = $6, updated_at = $7 WHERE id = $1", [p.id, name, nz(p.description), p.active, sort, ctx.actor!.staffId, ctx.now]);
      await cfgAudit(tx, ctx, "CRM_CONFIG_CATEGORY_CHANGED", why, { id: p.id, previous: { name: before.name, active: before.active, sort: before.sort_order }, next: { name, active: p.active, sort } });
      return p.id;
    }
    const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36) || "CATEGORY";
    let code = /^[A-Z]/.test(base) ? base : `C_${base}`;
    for (let i = 2; (await tx.query("SELECT 1 FROM crm_categories WHERE code = $1", [code])).rowCount; i++) code = `${base.slice(0, 33)}_${i}`;
    const id = (await tx.query<{ id: string }>("INSERT INTO crm_categories (code, name, description, active, sort_order, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [code, name, nz(p.description), p.active, sort, ctx.actor!.staffId, ctx.now])).rows[0].id;
    await cfgAudit(tx, ctx, "CRM_CONFIG_CATEGORY_CREATED", why, { id, code, name });
    return id;
  });
}

export async function saveSubcategory(ctx: Ctx, p: { id?: string | null; categoryId: string; name: string; productCode?: string | null; defaultPriority: string; active: boolean; sortOrder?: number; reason: string }) {
  const name = String(p.name ?? "").trim();
  if (name.length < 2 || name.length > 120) throw invalid("Give the issue a name (2–120 characters).", { name: "Required." });
  if (!isPriority(p.defaultPriority)) throw invalid("Choose a default priority.", { defaultPriority: "Required." });
  if (!uuidRe.test(p.categoryId ?? "")) throw invalid("Choose a category.", { categoryId: "Required." });
  return asAdmin(ctx, p.reason, async (tx, why) => {
    if (!(await tx.query("SELECT 1 FROM crm_categories WHERE id = $1", [p.categoryId])).rowCount) throw invalid("Choose a category.", { categoryId: "Unknown." });
    const product = await validProduct(tx, nz(p.productCode));
    const sort = Number.isFinite(p.sortOrder) ? Math.trunc(p.sortOrder!) : product ? 200 : 100;
    try {
      if (p.id) {
        const before = (await tx.query("SELECT * FROM crm_subcategories WHERE id = $1 FOR UPDATE", [p.id])).rows[0];
        if (!before) throw notFound();
        await tx.query("UPDATE crm_subcategories SET category_id = $2, name = $3, product_code = $4, default_priority = $5, active = $6, sort_order = $7, updated_by = $8, updated_at = $9 WHERE id = $1", [p.id, p.categoryId, name, product, p.defaultPriority, p.active, sort, ctx.actor!.staffId, ctx.now]);
        await cfgAudit(tx, ctx, "CRM_CONFIG_ISSUE_CHANGED", why, { id: p.id, previous: { name: before.name, category: before.category_id, product: before.product_code, priority: before.default_priority, active: before.active }, next: { name, category: p.categoryId, product, priority: p.defaultPriority, active: p.active } });
        return p.id;
      }
      const id = (await tx.query<{ id: string }>("INSERT INTO crm_subcategories (category_id, name, product_code, default_priority, active, sort_order, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id", [p.categoryId, name, product, p.defaultPriority, p.active, sort, ctx.actor!.staffId, ctx.now])).rows[0].id;
      await cfgAudit(tx, ctx, "CRM_CONFIG_ISSUE_CREATED", why, { id, category: p.categoryId, name, product, priority: p.defaultPriority });
      return id;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw conflict("An issue with this name already exists in the category for that product.");
      throw e;
    }
  });
}

// ------------------------------------------------------------------ teams

export async function saveTeam(ctx: Ctx, p: { id?: string | null; name: string; description?: string | null; active: boolean; reason: string }) {
  const name = String(p.name ?? "").trim();
  if (name.length < 2 || name.length > 80) throw invalid("Give the team a name (2–80 characters).", { name: "Required." });
  return asAdmin(ctx, p.reason, async (tx, why) => {
    try {
      if (p.id) {
        const before = (await tx.query("SELECT * FROM crm_teams WHERE id = $1 FOR UPDATE", [p.id])).rows[0];
        if (!before) throw notFound();
        if (!p.active) {
          const s = (await tx.query("SELECT fallback_team_id FROM crm_settings WHERE id = 1")).rows[0];
          if (s.fallback_team_id === p.id) throw invalid("This team is the fallback queue. Choose another fallback team before deactivating it.");
          // Resolved tickets can still be reopened, so only fully closed tickets release a team.
          const open = Number((await tx.query("SELECT count(*) AS n FROM crm_tickets WHERE team_id = $1 AND status <> 'CLOSED'", [p.id])).rows[0].n);
          if (open) throw invalid(`This team still holds ${open} ticket(s) that are not closed (resolved tickets can be reopened). Transfer them before deactivating it.`);
        }
        await tx.query("UPDATE crm_teams SET name = $2, description = $3, active = $4, updated_at = $5 WHERE id = $1", [p.id, name, nz(p.description), p.active, ctx.now]);
        await cfgAudit(tx, ctx, "CRM_CONFIG_TEAM_CHANGED", why, { id: p.id, previous: { name: before.name, active: before.active }, next: { name, active: p.active } });
        return p.id;
      }
      const id = (await tx.query<{ id: string }>("INSERT INTO crm_teams (name, description, active, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5) RETURNING id", [name, nz(p.description), p.active, ctx.actor!.staffId, ctx.now])).rows[0].id;
      await cfgAudit(tx, ctx, "CRM_CONFIG_TEAM_CREATED", why, { id, name });
      return id;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw conflict("A team with this name already exists.");
      throw e;
    }
  });
}

/** Add, change or remove a team member (role LEAD or OFFICER, or null to remove). */
export async function setTeamMember(ctx: Ctx, p: { teamId: string; email?: string; staffId?: string; memberRole: "LEAD" | "OFFICER" | null; reason: string }) {
  return asAdmin(ctx, p.reason, async (tx, why) => {
    const team = (await tx.query("SELECT id, name FROM crm_teams WHERE id = $1", [p.teamId])).rows[0];
    if (!team) throw notFound("Team not found.");
    const staff = (
      await tx.query<{ id: string; full_name: string }>(
        p.staffId ? "SELECT id, full_name FROM staff WHERE id = $1 AND status = 'ACTIVE'" : "SELECT id, full_name FROM staff WHERE email = lower($1) AND status = 'ACTIVE'",
        [p.staffId ?? String(p.email ?? "").trim()],
      )
    ).rows[0];
    if (!staff) throw invalid("No active ARAF user with that email. The person must have an ARAF account first.", { email: "Not an active user." });
    const before = (await tx.query("SELECT member_role, active FROM crm_team_members WHERE team_id = $1 AND staff_id = $2", [team.id, staff.id])).rows[0] ?? null;
    if (p.memberRole === null) {
      if (!before?.active) throw invalid("This person is not a member of the team.");
      const held = Number((await tx.query("SELECT count(*) AS n FROM crm_tickets WHERE team_id = $1 AND assignee_id = $2 AND status NOT IN ('RESOLVED','CLOSED')", [team.id, staff.id])).rows[0].n);
      if (held) throw invalid(`${staff.full_name} still holds ${held} open ticket(s) in this team. Reassign them first.`);
      await tx.query("UPDATE crm_team_members SET active = false WHERE team_id = $1 AND staff_id = $2", [team.id, staff.id]);
    } else {
      if (p.memberRole !== "LEAD" && p.memberRole !== "OFFICER") throw invalid("Choose Team Lead or Resolution Officer.");
      await tx.query(
        `INSERT INTO crm_team_members (team_id, staff_id, member_role, active, added_by, added_at) VALUES ($1,$2,$3,true,$4,$5)
         ON CONFLICT (team_id, staff_id) DO UPDATE SET member_role = EXCLUDED.member_role, active = true, added_by = EXCLUDED.added_by, added_at = EXCLUDED.added_at`,
        [team.id, staff.id, p.memberRole, ctx.actor!.staffId, ctx.now],
      );
    }
    await cfgAudit(tx, ctx, "CRM_CONFIG_TEAM_MEMBER_CHANGED", why, { teamId: team.id, team: team.name, staffId: staff.id, previous: before, next: p.memberRole });
  });
}

// ------------------------------------------------------------------ routing

export async function saveRoutingRule(ctx: Ctx, p: { id?: string | null; productCode?: string | null; categoryId?: string | null; subcategoryId?: string | null; stage?: string | null; teamId: string; priorityOverride?: string | null; active: boolean; reason: string }) {
  return asAdmin(ctx, p.reason, async (tx, why) => {
    const product = await validProduct(tx, nz(p.productCode));
    const cat = nz(p.categoryId);
    const sub = nz(p.subcategoryId);
    const stage = nz(p.stage);
    const pr = nz(p.priorityOverride);
    if (pr && !isPriority(pr)) throw invalid("Unknown priority.");
    if (cat && !uuidRe.test(cat)) throw invalid("Unknown category.", { categoryId: "Unknown." });
    if (sub && !uuidRe.test(sub)) throw invalid("Unknown issue.", { subcategoryId: "Unknown." });
    if (cat && !(await tx.query("SELECT 1 FROM crm_categories WHERE id = $1", [cat])).rowCount) throw invalid("Unknown category.");
    if (sub && !(await tx.query("SELECT 1 FROM crm_subcategories WHERE id = $1 AND ($2::uuid IS NULL OR category_id = $2)", [sub, cat])).rowCount) throw invalid("The issue does not belong to the chosen category.", { subcategoryId: "Check the issue." });
    if (stage && !/^[A-Z][A-Z0-9_]{1,60}$/.test(stage)) throw invalid("Unknown stage.");
    if (!uuidRe.test(p.teamId ?? "") || !(await tx.query("SELECT 1 FROM crm_teams WHERE id = $1 AND active", [p.teamId])).rowCount) throw invalid("Choose an active team.", { teamId: "Required." });
    if (!product && !cat && !sub && !stage) throw invalid("A rule needs at least one condition (product, category, issue or stage). Unmatched complaints already go to the fallback queue.");
    const vals = [product, cat, sub, stage, p.teamId, pr, p.active, ctx.now];
    if (p.id) {
      const before = (await tx.query("SELECT * FROM crm_routing_rules WHERE id = $1 FOR UPDATE", [p.id])).rows[0];
      if (!before) throw notFound();
      await tx.query("UPDATE crm_routing_rules SET product_code = $2, category_id = $3, subcategory_id = $4, stage = $5, team_id = $6, priority_override = $7, active = $8, updated_at = $9 WHERE id = $1", [p.id, ...vals]);
      await cfgAudit(tx, ctx, "CRM_CONFIG_ROUTING_CHANGED", why, { id: p.id, previous: before, next: { product, cat, sub, stage, team: p.teamId, priority: pr, active: p.active } });
      return p.id;
    }
    const id = (await tx.query<{ id: string }>("INSERT INTO crm_routing_rules (product_code, category_id, subcategory_id, stage, team_id, priority_override, active, created_at, updated_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9) RETURNING id", [...vals, ctx.actor!.staffId])).rows[0].id;
    await cfgAudit(tx, ctx, "CRM_CONFIG_ROUTING_CREATED", why, { id, product, cat, sub, stage, team: p.teamId, priority: pr });
    return id;
  });
}

// ------------------------------------------------------------------ SLA policies

export async function saveSlaPolicy(ctx: Ctx, p: { id?: string | null; name: string; productCode?: string | null; categoryId?: string | null; subcategoryId?: string | null; priority?: string | null; teamId?: string | null; assignmentMinutes?: number | null; firstResponseMinutes?: number | null; resolutionMinutes?: number | null; businessHours: boolean; active: boolean; reason: string }) {
  const name = String(p.name ?? "").trim();
  if (name.length < 2 || name.length > 80) throw invalid("Name the policy (2–80 characters).", { name: "Required." });
  const mins = (v: number | null | undefined, k: string) => {
    if (v === null || v === undefined || Number.isNaN(v)) return null;
    if (!Number.isInteger(v) || v < 1 || v > 525_600) throw invalid("Targets are whole minutes between 1 and 525,600.", { [k]: "Invalid." });
    return v;
  };
  const a = mins(p.assignmentMinutes, "assignmentMinutes");
  const f = mins(p.firstResponseMinutes, "firstResponseMinutes");
  const r = mins(p.resolutionMinutes, "resolutionMinutes");
  if (a === null && f === null && r === null) throw invalid("Set at least one target.");
  return asAdmin(ctx, p.reason, async (tx, why) => {
    const product = await validProduct(tx, nz(p.productCode));
    const pr = nz(p.priority);
    if (pr && !isPriority(pr)) throw invalid("Unknown priority.");
    const cat = nz(p.categoryId);
    const sub = nz(p.subcategoryId);
    const team = nz(p.teamId);
    if (cat && !uuidRe.test(cat)) throw invalid("Unknown category.", { categoryId: "Unknown." });
    if (sub && !uuidRe.test(sub)) throw invalid("Unknown issue.", { subcategoryId: "Unknown." });
    if (team && !uuidRe.test(team)) throw invalid("Unknown team.", { teamId: "Unknown." });
    const vals = [name, product, cat, sub, pr, team, a, f, r, p.businessHours, p.active, ctx.now];
    if (p.id) {
      const before = (await tx.query("SELECT * FROM crm_sla_policies WHERE id = $1 FOR UPDATE", [p.id])).rows[0];
      if (!before) throw notFound();
      await tx.query("UPDATE crm_sla_policies SET name=$2, product_code=$3, category_id=$4, subcategory_id=$5, priority=$6, team_id=$7, assignment_minutes=$8, first_response_minutes=$9, resolution_minutes=$10, business_hours=$11, active=$12, updated_at=$13 WHERE id = $1", [p.id, ...vals]);
      await cfgAudit(tx, ctx, "CRM_CONFIG_SLA_CHANGED", why, { id: p.id, previous: before, next: vals, appliesTo: "Tickets created from now on; existing tickets keep their deadlines." });
      return p.id;
    }
    const id = (await tx.query<{ id: string }>("INSERT INTO crm_sla_policies (name, product_code, category_id, subcategory_id, priority, team_id, assignment_minutes, first_response_minutes, resolution_minutes, business_hours, active, created_at, updated_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13) RETURNING id", [...vals, ctx.actor!.staffId])).rows[0].id;
    await cfgAudit(tx, ctx, "CRM_CONFIG_SLA_CREATED", why, { id, name, targets: { a, f, r }, businessHours: p.businessHours });
    return id;
  });
}

// ------------------------------------------------------------------ escalation rules

export const ESCALATION_TRIGGERS: Record<string, { label: string; unit: string }> = {
  UNASSIGNED_OVER: { label: "Awaiting assignment longer than", unit: "minutes" },
  NOT_STARTED_OVER: { label: "Assigned but not started for longer than", unit: "minutes" },
  APPROACHING_BREACH: { label: "Resolution time used reaches", unit: "% of the target" },
  RESOLUTION_BREACHED: { label: "Resolution deadline exceeded by", unit: "minutes" },
  REASSIGNED_TIMES: { label: "Reassigned or transferred at least", unit: "times" },
  CRITICAL_OPEN_OVER: { label: "Critical ticket unresolved for longer than", unit: "minutes" },
};

export async function saveEscalationRule(ctx: Ctx, p: { id?: string | null; trigger: string; threshold: number; notifyTeamLead: boolean; notifyCxHead: boolean; markEscalated: boolean; active: boolean; reason: string }) {
  if (!(p.trigger in ESCALATION_TRIGGERS)) throw invalid("Choose a trigger.", { trigger: "Required." });
  if (!Number.isInteger(p.threshold) || p.threshold < 1 || p.threshold > 525_600 || (p.trigger === "APPROACHING_BREACH" && p.threshold > 99)) throw invalid("Enter a valid threshold.", { threshold: "Invalid." });
  if (!p.notifyTeamLead && !p.notifyCxHead && !p.markEscalated) throw invalid("The rule must notify someone or mark the ticket escalated.");
  return asAdmin(ctx, p.reason, async (tx, why) => {
    const vals = [p.trigger, p.threshold, p.notifyTeamLead, p.notifyCxHead, p.markEscalated, p.active, ctx.now];
    if (p.id) {
      const before = (await tx.query("SELECT * FROM crm_escalation_rules WHERE id = $1 FOR UPDATE", [p.id])).rows[0];
      if (!before) throw notFound();
      await tx.query("UPDATE crm_escalation_rules SET trigger=$2, threshold=$3, notify_team_lead=$4, notify_cx_head=$5, mark_escalated=$6, active=$7, updated_at=$8 WHERE id = $1", [p.id, ...vals]);
      await cfgAudit(tx, ctx, "CRM_CONFIG_ESCALATION_CHANGED", why, { id: p.id, previous: before, next: vals });
      return p.id;
    }
    const id = (await tx.query<{ id: string }>("INSERT INTO crm_escalation_rules (trigger, threshold, notify_team_lead, notify_cx_head, mark_escalated, active, created_at, updated_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8) RETURNING id", [...vals, ctx.actor!.staffId])).rows[0].id;
    await cfgAudit(tx, ctx, "CRM_CONFIG_ESCALATION_CREATED", why, { id, trigger: p.trigger, threshold: p.threshold });
    return id;
  });
}

// ------------------------------------------------------------------ settings (fallback, calendar, closure)

export async function saveCrmSettings(ctx: Ctx, p: { fallbackTeamId: string; closurePolicy: string; closureTimeoutHours: number | null; workingStart: number; workingEnd: number; workingDays: number[]; holidays: string[]; pauseOnPendingInfo: boolean; reason: string }) {
  const errs: Record<string, string> = {};
  if (!(Number.isInteger(p.workingStart) && Number.isInteger(p.workingEnd) && p.workingStart >= 0 && p.workingStart < p.workingEnd && p.workingEnd <= 24)) errs.workingEnd = "Working hours must end after they start (0–24).";
  if (!p.workingDays.length || p.workingDays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) errs.workingDays = "Choose at least one working day.";
  const bad = p.holidays.filter((h) => !isValidDateString(h));
  if (bad.length) errs.holidays = `Not a date (YYYY-MM-DD): ${bad.join(", ")}`;
  if (p.closurePolicy !== "CONFIRMATION" && p.closurePolicy !== "TIMEOUT") errs.closurePolicy = "Choose a closure policy.";
  if (p.closurePolicy === "TIMEOUT" && !(Number.isInteger(p.closureTimeoutHours) && p.closureTimeoutHours! >= 1 && p.closureTimeoutHours! <= 2160)) errs.closureTimeoutHours = "Set the hours after which a resolved ticket closes (1–2160).";
  if (Object.keys(errs).length) throw invalid("Check the highlighted settings.", errs);
  return asAdmin(ctx, p.reason, async (tx, why) => {
    if (!(await tx.query("SELECT 1 FROM crm_teams WHERE id = $1 AND active", [p.fallbackTeamId])).rowCount) throw invalid("Choose an active fallback team.", { fallbackTeamId: "Required." });
    const before = (await tx.query("SELECT * FROM crm_settings WHERE id = 1 FOR UPDATE")).rows[0];
    const days = [...new Set(p.workingDays)].sort();
    const hol = [...new Set(p.holidays)].sort();
    await tx.query(
      "UPDATE crm_settings SET fallback_team_id=$1, closure_policy=$2, closure_timeout_hours=$3, working_start=$4, working_end=$5, working_days=$6, holidays=$7::date[], pause_on_pending_info=$8, updated_by=$9, updated_at=$10 WHERE id = 1",
      [p.fallbackTeamId, p.closurePolicy, p.closurePolicy === "TIMEOUT" ? p.closureTimeoutHours : null, p.workingStart, p.workingEnd, days, hol, p.pauseOnPendingInfo, ctx.actor!.staffId, ctx.now],
    );
    await cfgAudit(tx, ctx, "CRM_CONFIG_SETTINGS_CHANGED", why, {
      previous: { fallback: before.fallback_team_id, closure: before.closure_policy, timeout: before.closure_timeout_hours, hours: [before.working_start, before.working_end], days: before.working_days, pause: before.pause_on_pending_info },
      next: { fallback: p.fallbackTeamId, closure: p.closurePolicy, timeout: p.closureTimeoutHours, hours: [p.workingStart, p.workingEnd], days, holidays: hol.length, pause: p.pauseOnPendingInfo },
    });
  });
}

// ------------------------------------------------------------------ report schedules

export async function saveReportSchedule(ctx: Ctx, p: { frequency: string; enabled: boolean; sendHour: number; includeCxHeads: boolean; extraRecipientEmails: string[]; reason: string }) {
  if (!["DAILY", "WEEKLY", "MONTHLY"].includes(p.frequency)) throw invalid("Unknown schedule.");
  if (!Number.isInteger(p.sendHour) || p.sendHour < 0 || p.sendHour > 23) throw invalid("Choose an hour from 0 to 23.", { sendHour: "Invalid." });
  return asAdmin(ctx, p.reason, async (tx, why) => {
    const emails = [...new Set(p.extraRecipientEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const found = (await tx.query<{ id: string; email: string }>("SELECT id, email FROM staff WHERE email = ANY($1) AND status = 'ACTIVE'", [emails])).rows;
    const missing = emails.filter((e) => !found.some((f) => f.email === e));
    if (missing.length) throw invalid(`Recipients must be active ARAF users: ${missing.join(", ")}.`, { extra: "Unknown recipient." });
    // Reports carry organisation-wide complaint data: extra recipients must hold CX Head, Super Admin or Reporting Admin.
    for (const f of found) {
      const ok = (await tx.query("SELECT 1 FROM role_assignments WHERE staff_id = $1 AND active AND role IN ('CX_HEAD','SUPER_ADMIN','REPORTING_ADMIN','EXECUTIVE_VIEW')", [f.id])).rowCount;
      if (!ok) throw invalid(`${f.email} is not authorised to receive CX reports (CX Head, Super Admin, Reporting Admin or Executive View only).`, { extra: "Not authorised." });
    }
    const before = (await tx.query("SELECT * FROM crm_report_schedules WHERE frequency = $1 FOR UPDATE", [p.frequency])).rows[0];
    await tx.query("UPDATE crm_report_schedules SET enabled=$2, send_hour=$3, include_cx_heads=$4, extra_recipient_ids=$5, updated_by=$6, updated_at=$7 WHERE frequency = $1", [p.frequency, p.enabled, p.sendHour, p.includeCxHeads, found.map((f) => f.id), ctx.actor!.staffId, ctx.now]);
    await cfgAudit(tx, ctx, "CRM_CONFIG_REPORT_SCHEDULE_CHANGED", why, { frequency: p.frequency, previous: before, next: { enabled: p.enabled, hour: p.sendHour, cxHeads: p.includeCxHeads, extra: found.length } });
  });
}

// ------------------------------------------------------------------ knowledge base (CX Head or Super Admin)

export async function saveKbArticle(ctx: Ctx, p: { id?: string | null; title: string; body: string; categoryId?: string | null; status: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const title = String(p.title ?? "").trim();
  const body = String(p.body ?? "").trim();
  if (title.length < 5 || title.length > 150) throw invalid("Give the article a title (5–150 characters).", { title: "Required." });
  if (body.length < 10 || body.length > 20000) throw invalid("Write the guidance (10–20,000 characters).", { body: "Required." });
  if (!["DRAFT", "PUBLISHED", "RETIRED"].includes(p.status)) throw invalid("Choose a status.");
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "CX_HEAD")) && !(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only the CX Head or Super Admin can publish resolution guidance.");
    const cat = nz(p.categoryId);
    if (p.id) {
      const before = (await tx.query("SELECT status, title FROM crm_kb_articles WHERE id = $1 FOR UPDATE", [p.id])).rows[0];
      if (!before) throw notFound();
      await tx.query("UPDATE crm_kb_articles SET title=$2, body=$3, category_id=$4, status=$5, updated_by=$6, updated_at=$7 WHERE id = $1", [p.id, title, body, cat, p.status, actor.staffId, ctx.now]);
      await audit(tx, ctx, { action: "CRM_KB_ARTICLE_CHANGED", details: { id: p.id, previous: before, next: { title, status: p.status } } });
      return p.id;
    }
    const id = (await tx.query<{ id: string }>("INSERT INTO crm_kb_articles (title, body, category_id, status, updated_by, updated_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id", [title, body, cat, p.status, actor.staffId, ctx.now])).rows[0].id;
    await audit(tx, ctx, { action: "CRM_KB_ARTICLE_CREATED", details: { id, title, status: p.status } });
    return id;
  });
}

export { FALLBACK_TEAM_ID };
