/**
 * Reporting lines configured by the Super Admin: Merchant Officer → Lead → Head, and staff → Unit Head →
 * Divisional Head. Routing and reporting read these; no person is hardcoded.
 */
import { withTx, type Db } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { forbidden, invalid } from "../errors";
import { holdsRole } from "./access";

export const RELATIONS = {
  MO_LEAD: { label: "Merchant Officer Lead", managerRole: "MERCHANT_OFFICER_LEAD", forRoles: ["MERCHANT_OFFICER"] },
  MO_HEAD: { label: "Merchant Officer Head", managerRole: "MERCHANT_OFFICER_HEAD", forRoles: ["MERCHANT_OFFICER_LEAD"] },
  UNIT_HEAD: { label: "Unit Head", managerRole: "UNIT_HEAD", forRoles: null },
  DIVISIONAL_HEAD: { label: "Divisional Head", managerRole: "DIVISIONAL_HEAD", forRoles: ["UNIT_HEAD"] },
  /** Non-DBC Relationship Manager -> Regional Business Executive (set through RM classification). */
  RBE: { label: "Regional Business Executive", managerRole: "RBE", forRoles: ["RM"] },
} as const;
export type Relation = keyof typeof RELATIONS;
export const isRelation = (r: string): r is Relation => r in RELATIONS;

export async function managerOf(q: Db, staffId: string | null | undefined, relation: Relation): Promise<string | null> {
  if (!staffId) return null;
  return (await q.query<{ manager_id: string }>("SELECT manager_id FROM org_links WHERE staff_id = $1 AND relation = $2", [staffId, relation])).rows[0]?.manager_id ?? null;
}

/** Everyone who reports (directly) to a manager under a relation. */
export async function reportsOf(q: Db, managerId: string, relation: Relation): Promise<string[]> {
  return (await q.query<{ staff_id: string }>("SELECT staff_id FROM org_links WHERE manager_id = $1 AND relation = $2", [managerId, relation])).rows.map((r) => r.staff_id);
}

export interface OrgLinkRow {
  staff_id: string;
  relation: Relation;
  manager_id: string;
  manager_name: string;
  set_at: Date;
}
export async function orgLinks(q: Db): Promise<OrgLinkRow[]> {
  return (await q.query<OrgLinkRow>("SELECT l.staff_id, l.relation, l.manager_id, m.full_name AS manager_name, l.set_at FROM org_links l JOIN staff m ON m.id = l.manager_id")).rows;
}

/** Super Admin sets (or clears, managerId = null) a reporting line. Mandatory reason; audited with previous value. */
export async function setOrgLink(ctx: Ctx, p: { staffId: string; relation: string; managerId: string | null; reason: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!isRelation(p.relation)) throw invalid("Unknown reporting line.");
  if (p.reason.trim().length < 10) throw invalid("Give a reason (at least 10 characters).", { reason: "Give a reason." });
  const rel = RELATIONS[p.relation];
  await withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden();
    if (p.managerId) {
      if (p.managerId === p.staffId) throw invalid("A person cannot report to themselves.");
      if (!(await holdsRole(tx, p.managerId, rel.managerRole))) throw invalid(`The chosen manager does not hold the ${rel.label} role.`);
      if (rel.forRoles && !(await Promise.all(rel.forRoles.map((r) => holdsRole(tx, p.staffId, r)))).some(Boolean)) {
        throw invalid(`Only a ${rel.forRoles.map((r) => r.replace(/_/g, " ").toLowerCase()).join(" or ")} can have a ${rel.label}.`);
      }
    }
    const before = (await tx.query("SELECT manager_id FROM org_links WHERE staff_id = $1 AND relation = $2", [p.staffId, p.relation])).rows[0]?.manager_id ?? null;
    if (p.managerId)
      await tx.query(
        `INSERT INTO org_links (staff_id, relation, manager_id, set_by, set_at, reason) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (staff_id, relation) DO UPDATE SET manager_id = EXCLUDED.manager_id, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at, reason = EXCLUDED.reason`,
        [p.staffId, p.relation, p.managerId, actor.staffId, ctx.now, p.reason.trim()],
      );
    else await tx.query("DELETE FROM org_links WHERE staff_id = $1 AND relation = $2", [p.staffId, p.relation]);
    await audit(tx, ctx, { action: "REPORTING_LINE_CHANGED", actorRole: "SUPER_ADMIN", reason: p.reason.trim(), details: { staffId: p.staffId, relation: p.relation, previous: before, next: p.managerId } });
  });
}

export interface Supervision {
  /** Staff whose requests this person may see (they originate or are the assigned RM). */
  staffIds: string[];
  /** Retail teams in scope (Team Leads' teams). */
  teams: string[];
  /** Regions (states / zones) in scope: a request is visible when its region, or its initiator's region, is one of these. */
  regions: string[];
  label: string;
}

/**
 * Who a supervisor oversees (shared by case access and reporting, so a report never lists a facility its viewer
 * cannot open). The hierarchy is RM → Team Lead → Unit Head → Divisional Head; Non-DBC RMs → RBE; Merchant
 * Officer → Lead → Head. A Unit Head also oversees the DBC RMs of the region they are configured for and the
 * states on their Unit Head role assignment.
 */
export async function supervision(q: Db, staffId: string): Promise<Supervision> {
  const roles = (await q.query<{ role: string; region: string | null; team: string | null }>("SELECT role, region, team FROM role_assignments WHERE staff_id = $1 AND active", [staffId])).rows;
  const has = (r: string) => roles.some((x) => x.role === r);
  const ids = new Set<string>();
  const teams = new Set<string>();
  const regions = new Set<string>();
  const labels: string[] = [];
  const rows = async (sql: string, p: unknown[]) => (await q.query<{ id: string }>(sql, p)).rows.map((r) => r.id);
  const teamOf = async (people: string[]) =>
    people.length ? (await q.query<{ team: string }>("SELECT DISTINCT team FROM role_assignments WHERE staff_id = ANY($1::uuid[]) AND active AND role = 'TEAM_LEAD' AND team IS NOT NULL", [people])).rows.map((r) => r.team) : [];
  const unit = async (uh: string) => {
    const direct = await rows("SELECT staff_id AS id FROM org_links WHERE manager_id = $1 AND relation = 'UNIT_HEAD'", [uh]);
    direct.forEach((x) => ids.add(x));
    // Team Leads reporting to the Unit Head bring their whole team (RMs on the same team code).
    for (const t of await teamOf(direct)) teams.add(t);
    const dbc = await rows(
      `SELECT c.staff_id AS id FROM routing_assignments x JOIN rm_classifications c ON c.segment = 'DBC'
          AND c.dbc_region = CASE x.key WHEN 'DBC_UNIT_HEAD_NORTH' THEN 'NORTH' WHEN 'DBC_UNIT_HEAD_SOUTH_WEST' THEN 'SOUTH_WEST' END
        WHERE x.staff_id = $1`,
      [uh],
    );
    dbc.forEach((x) => ids.add(x));
  };
  // A Unit Head's or RBE's region: the region on that role, else the person's own region (staff profile). Requests
  // whose initiator, or whose request region, is in that region are in scope; nothing else needs configuring.
  if (has("UNIT_HEAD") || has("RBE")) {
    const { expandRegions } = await import("./roles");
    const own = (await q.query<{ region: string | null }>("SELECT region FROM staff WHERE id = $1", [staffId])).rows[0]?.region ?? null;
    const fromRoles = roles.filter((x) => (x.role === "UNIT_HEAD" || x.role === "RBE") && x.region).map((x) => x.region!);
    for (const r of expandRegions(fromRoles.length ? fromRoles : own ? [own] : [])) regions.add(r);
  }
  if (has("UNIT_HEAD")) {
    await unit(staffId);
    labels.push("your unit");
  }
  if (has("DIVISIONAL_HEAD")) {
    for (const uh of await rows("SELECT staff_id AS id FROM org_links WHERE manager_id = $1 AND relation = 'DIVISIONAL_HEAD'", [staffId])) {
      ids.add(uh);
      await unit(uh);
    }
    labels.push("your division");
  }
  if (has("TEAM_LEAD")) {
    roles.filter((x) => x.role === "TEAM_LEAD" && x.team).forEach((x) => teams.add(x.team!));
    labels.push("your team");
  }
  if (has("RBE")) {
    (await rows("SELECT staff_id AS id FROM org_links WHERE manager_id = $1 AND relation = 'RBE'", [staffId])).forEach((x) => ids.add(x));
    labels.push("your Relationship Managers");
  }
  if (has("MERCHANT_OFFICER_HEAD")) {
    ids.add(staffId);
    for (const lead of await rows("SELECT staff_id AS id FROM org_links WHERE manager_id = $1 AND relation = 'MO_HEAD'", [staffId])) {
      ids.add(lead);
      (await rows("SELECT staff_id AS id FROM org_links WHERE manager_id = $1 AND relation = 'MO_LEAD'", [lead])).forEach((x) => ids.add(x));
    }
    labels.push("the Merchant Officer business line");
  }
  // Everyone on the teams in scope.
  if (teams.size)
    (await rows("SELECT DISTINCT staff_id AS id FROM role_assignments WHERE active AND team = ANY($1::text[]) AND role IN ('RM','TEAM_LEAD','DELIGHT_OFFICER')", [[...teams]])).forEach((x) => ids.add(x));
  return { staffIds: [...ids], teams: [...teams], regions: [...regions], label: labels[0] ?? "" };
}
