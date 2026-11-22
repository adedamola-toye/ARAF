/**
 * Scoped staff-profile editing by Team Leads.
 *
 *  - Only Team Leads a Super Admin has explicitly designated may edit, and only while they hold an active Team Lead
 *    role. The Super Admin keeps full editing in Administration → Staff.
 *  - Scope: the people in the Team Lead's own team(s) (active RM, Team Lead or Delight Officer roles with the same
 *    team), never themselves.
 *  - Fields: full name and business unit only. Roles, status, region, email and access cannot be changed here, so a
 *    Team Lead can never grant or widen anyone's privileges.
 *  - Every change is audited with the previous and new values.
 */
import type { Db } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { holdsRole } from "./access";

export const TEAM_EDITABLE_FIELDS = ["fullName", "businessUnit"] as const;

export async function isDesignatedEditor(q: Db, staffId: string): Promise<boolean> {
  if (!(await holdsRole(q, staffId, "TEAM_LEAD"))) return false;
  return !!(await q.query("SELECT 1 FROM team_lead_profile_editors WHERE staff_id = $1 AND revoked_at IS NULL", [staffId])).rowCount;
}

async function teamsOf(q: Db, staffId: string): Promise<string[]> {
  return (await q.query<{ team: string }>("SELECT DISTINCT team FROM role_assignments WHERE staff_id = $1 AND active AND role = 'TEAM_LEAD' AND team IS NOT NULL", [staffId])).rows.map((r) => r.team);
}

export async function teamMembers(q: Db, leadId: string) {
  const teams = await teamsOf(q, leadId);
  if (!teams.length) return [];
  return (
    await q.query<{ id: string; full_name: string; email: string; business_unit: string | null; roles: string; team: string }>(
      `SELECT s.id, s.full_name, s.email, s.business_unit, string_agg(DISTINCT ra.role, ',') AS roles, min(ra.team) AS team
         FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active AND ra.team = ANY($1) AND ra.role IN ('RM','TEAM_LEAD','DELIGHT_OFFICER')
        WHERE s.id <> $2 AND s.status = 'ACTIVE' GROUP BY s.id ORDER BY s.full_name`,
      [teams, leadId],
    )
  ).rows;
}

export async function editTeamMemberProfile(ctx: Ctx, staffId: string, p: { fullName: string; businessUnit: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await isDesignatedEditor(tx, actor.staffId))) throw forbidden("Only Team Leads designated by the Super Admin can edit team profiles.");
    if (staffId === actor.staffId) throw forbidden("You cannot edit your own profile here. Ask the Super Admin.");
    const members = await teamMembers(tx, actor.staffId);
    if (!members.some((m) => m.id === staffId)) throw forbidden("This person is not in your team.");
    const cur = (await tx.query<{ full_name: string; business_unit: string | null }>("SELECT full_name, business_unit FROM staff WHERE id = $1 FOR UPDATE", [staffId])).rows[0];
    if (!cur) throw notFound();
    const fullName = (p.fullName ?? "").replace(/\s+/g, " ").trim();
    if (fullName.length < 3 || fullName.length > 120) throw invalid("Enter the full name (3–120 characters).", { fullName: "Enter the full name." });
    const businessUnit = (p.businessUnit ?? "").trim().slice(0, 80) || null;
    if (cur.full_name === fullName && cur.business_unit === businessUnit) throw conflict("Nothing changed.");
    await tx.query("UPDATE staff SET full_name = $2, business_unit = $3, updated_at = $4 WHERE id = $1", [staffId, fullName, businessUnit, ctx.now]);
    await audit(tx, ctx, {
      action: "STAFF_UPDATED",
      actorRole: "TEAM_LEAD",
      details: { staffId, by: "TEAM_LEAD_SCOPED", before: { fullName: cur.full_name, businessUnit: cur.business_unit }, after: { fullName, businessUnit } },
    });
  });
}

export async function designateEditor(ctx: Ctx, staffId: string, on: boolean, reason: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const why = (reason ?? "").trim();
  if (why.length < 5) throw invalid("Give the reason.", { reason: "Reason required." });
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can designate profile editors.");
    if (on) {
      if (!(await holdsRole(tx, staffId, "TEAM_LEAD"))) throw invalid("Only someone with an active Team Lead role can be designated.");
      const r = await tx.query(
        "INSERT INTO team_lead_profile_editors (staff_id, designated_by, designated_at, reason) VALUES ($1,$2,$3,$4) ON CONFLICT (staff_id) WHERE revoked_at IS NULL DO NOTHING",
        [staffId, actor.staffId, ctx.now, why],
      );
      if (!r.rowCount) throw conflict("Already designated.");
    } else {
      const r = await tx.query("UPDATE team_lead_profile_editors SET revoked_by = $2, revoked_at = $3 WHERE staff_id = $1 AND revoked_at IS NULL", [staffId, actor.staffId, ctx.now]);
      if (!r.rowCount) throw conflict("Not designated.");
    }
    await audit(tx, ctx, { action: on ? "PROFILE_EDITOR_DESIGNATED" : "PROFILE_EDITOR_REVOKED", actorRole: "SUPER_ADMIN", reason: why, details: { staffId } });
  });
}

export async function teamLeadEditors(q: Db) {
  return (
    await q.query<{ id: string; full_name: string; email: string; teams: string | null; designated: boolean; designated_at: Date | null }>(
      `SELECT s.id, s.full_name, s.email, string_agg(DISTINCT ra.team, ', ') AS teams, (e.id IS NOT NULL) AS designated, e.designated_at
         FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active AND ra.role = 'TEAM_LEAD'
         LEFT JOIN team_lead_profile_editors e ON e.staff_id = s.id AND e.revoked_at IS NULL
        WHERE s.status = 'ACTIVE' GROUP BY s.id, e.id ORDER BY s.full_name`,
    )
  ).rows;
}
