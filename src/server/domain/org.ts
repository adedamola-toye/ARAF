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
