/**
 * Relationship Manager classification and routing resolution.
 *
 *  - Every RM is classified by the Super Admin as DBC (with a DBC region) or Non-DBC (with an assigned Regional
 *    Business Executive). Nothing is inferred from location.
 *  - DBC requests keep their approved stage order; the Unit Head stage goes to the Unit Head configured for the
 *    RM's DBC region.
 *  - Non-DBC requests follow RM → RBE → CX Credit Review → applicable Credit Officer (and concurrence) →
 *    E-commerce Unit Head → Divisional Head.
 *  - The segment and Unit Head are pinned on the request at submission: later changes apply to new requests only.
 */
import { withTx, type Db, type Tx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { forbidden, gate, invalid } from "../errors";
import { holdsRole } from "./access";
import { managerOf } from "./org";

export const SEGMENTS = { DBC: "DBC", NON_DBC: "Non-DBC" } as const;
export type Segment = keyof typeof SEGMENTS;
export const DBC_REGIONS = { SOUTH_WEST: "South & West", NORTH: "North" } as const;
export type DbcRegion = keyof typeof DBC_REGIONS;
export const ROUTING_KEYS = {
  DBC_UNIT_HEAD_SOUTH_WEST: "DBC Unit Head — South & West",
  DBC_UNIT_HEAD_NORTH: "DBC Unit Head — North",
  ECOMMERCE_UNIT_HEAD: "E-commerce Unit Head (Non-DBC route)",
} as const;
export type RoutingKey = keyof typeof ROUTING_KEYS;
const isKey = (k: string): k is RoutingKey => k in ROUTING_KEYS;

export interface RmClassification {
  staff_id: string;
  segment: Segment;
  dbc_region: DbcRegion | null;
  business_unit: string | null;
  set_at: Date;
}

export async function rmClassification(q: Db, staffId: string): Promise<RmClassification | null> {
  return (await q.query<RmClassification>("SELECT staff_id, segment, dbc_region, business_unit, set_at FROM rm_classifications WHERE staff_id = $1", [staffId])).rows[0] ?? null;
}

export async function routingAssignment(q: Db, key: RoutingKey): Promise<string | null> {
  return (await q.query<{ staff_id: string }>("SELECT staff_id FROM routing_assignments WHERE key = $1", [key])).rows[0]?.staff_id ?? null;
}

export async function routingAssignments(q: Db) {
  return (await q.query<{ key: RoutingKey; staff_id: string; full_name: string; set_at: Date }>("SELECT r.key, r.staff_id, s.full_name, r.set_at FROM routing_assignments r JOIN staff s ON s.id = r.staff_id")).rows;
}

async function activeHolder(q: Db, staffId: string, role: string) {
  const r = await q.query("SELECT 1 FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active AND ra.role = $2 WHERE s.id = $1 AND s.status = 'ACTIVE'", [staffId, role]);
  return !!r.rowCount;
}

/** Super Admin classifies an RM. Non-DBC needs an RBE; DBC needs a DBC region. Reason mandatory, audited. */
export async function setRmClassification(ctx: Ctx, p: { staffId: string; segment: string; dbcRegion?: string | null; rbeId?: string | null; businessUnit?: string | null; reason: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (p.segment !== "DBC" && p.segment !== "NON_DBC") throw invalid("Choose whether the Relationship Manager belongs to DBC.", { segment: "Required." });
  if (p.reason.trim().length < 10) throw invalid("Give a reason (at least 10 characters).", { reason: "Give a reason." });
  const region = p.segment === "DBC" ? (p.dbcRegion ?? "") : null;
  if (p.segment === "DBC" && region !== "SOUTH_WEST" && region !== "NORTH") throw invalid("Choose the RM's DBC region.", { dbcRegion: "Required for DBC." });
  if (p.segment === "NON_DBC" && !p.rbeId) throw invalid("A Non-DBC Relationship Manager must have a Regional Business Executive.", { rbeId: "Required for Non-DBC." });
  await withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden();
    if (!(await holdsRole(tx, p.staffId, "RM"))) throw invalid("Only Relationship Managers are classified as DBC or Non-DBC.");
    if (p.segment === "NON_DBC") {
      if (p.rbeId === p.staffId) throw invalid("A Relationship Manager cannot be their own RBE.");
      if (!(await activeHolder(tx, p.rbeId!, "RBE"))) throw invalid("The chosen person is not an active Regional Business Executive.", { rbeId: "Not an active RBE." });
    }
    const before = await rmClassification(tx, p.staffId);
    const beforeRbe = await managerOf(tx, p.staffId, "RBE");
    await tx.query(
      `INSERT INTO rm_classifications (staff_id, segment, dbc_region, business_unit, set_by, set_at, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (staff_id) DO UPDATE SET segment = EXCLUDED.segment, dbc_region = EXCLUDED.dbc_region, business_unit = EXCLUDED.business_unit,
         set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at, reason = EXCLUDED.reason`,
      [p.staffId, p.segment, region, p.businessUnit?.trim() || null, actor.staffId, ctx.now, p.reason.trim()],
    );
    if (p.segment === "NON_DBC")
      await tx.query(
        `INSERT INTO org_links (staff_id, relation, manager_id, set_by, set_at, reason) VALUES ($1,'RBE',$2,$3,$4,$5)
         ON CONFLICT (staff_id, relation) DO UPDATE SET manager_id = EXCLUDED.manager_id, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at, reason = EXCLUDED.reason`,
        [p.staffId, p.rbeId, actor.staffId, ctx.now, p.reason.trim()],
      );
    else await tx.query("DELETE FROM org_links WHERE staff_id = $1 AND relation = 'RBE'", [p.staffId]);
    await audit(tx, ctx, {
      action: "RM_CLASSIFICATION_CHANGED",
      actorRole: "SUPER_ADMIN",
      reason: p.reason.trim(),
      details: {
        staffId: p.staffId,
        previous: before ? { segment: before.segment, dbcRegion: before.dbc_region, businessUnit: before.business_unit, rbeId: beforeRbe } : null,
        next: { segment: p.segment, dbcRegion: region, businessUnit: p.businessUnit?.trim() || null, rbeId: p.segment === "NON_DBC" ? p.rbeId : null },
        appliesTo: "Requests submitted from now on; requests already submitted keep their routing.",
      },
    });
  });
}

/** Super Admin sets a configured approver (must hold the Unit Head approval role). Reason mandatory, audited. */
export async function setRoutingAssignment(ctx: Ctx, p: { key: string; staffId: string | null; reason: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!isKey(p.key)) throw invalid("Unknown routing assignment.");
  if (p.reason.trim().length < 10) throw invalid("Give a reason (at least 10 characters).", { reason: "Give a reason." });
  await withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden();
    if (p.staffId && !(await activeHolder(tx, p.staffId, "UNIT_HEAD"))) throw invalid("The chosen person must be an active holder of the Unit Head (credit approval) role.");
    const before = await routingAssignment(tx, p.key as RoutingKey);
    if (p.staffId)
      await tx.query(
        `INSERT INTO routing_assignments (key, staff_id, set_by, set_at, reason) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key) DO UPDATE SET staff_id = EXCLUDED.staff_id, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at, reason = EXCLUDED.reason`,
        [p.key, p.staffId, actor.staffId, ctx.now, p.reason.trim()],
      );
    else await tx.query("DELETE FROM routing_assignments WHERE key = $1", [p.key]);
    await audit(tx, ctx, { action: "ROUTING_ASSIGNMENT_CHANGED", actorRole: "SUPER_ADMIN", reason: p.reason.trim(), details: { key: p.key, previous: before, next: p.staffId } });
  });
}

export interface ResolvedRouting {
  segment: Segment | null;
  rbeId: string | null;
  unitHeadId: string | null;
}

/**
 * Routing for an RM's request at submission. Unclassified RMs keep the existing route (and are listed for the
 * Super Admin to classify). A Non-DBC RM without an active RBE cannot submit: the RBE stage is never bypassed.
 */
export async function resolveRouting(q: Db, initiatorId: string, initiatorRole: string): Promise<ResolvedRouting> {
  if (initiatorRole !== "RM") return { segment: null, rbeId: null, unitHeadId: null };
  const c = await rmClassification(q, initiatorId);
  if (!c) return { segment: null, rbeId: null, unitHeadId: null };
  if (c.segment === "NON_DBC") {
    const rbe = await managerOf(q, initiatorId, "RBE");
    if (!rbe || !(await activeHolder(q, rbe, "RBE"))) throw gate("Your Regional Business Executive is not set up yet, so this request cannot be routed. Ask the Super Admin to assign your RBE.");
    return { segment: "NON_DBC", rbeId: rbe, unitHeadId: await routingAssignment(q, "ECOMMERCE_UNIT_HEAD") };
  }
  return { segment: "DBC", rbeId: null, unitHeadId: await routingAssignment(q, c.dbc_region === "NORTH" ? "DBC_UNIT_HEAD_NORTH" : "DBC_UNIT_HEAD_SOUTH_WEST") };
}

/** Pin the resolved routing on the request (first submission only; corrections keep the original routing). */
export async function pinRouting(tx: Tx, app: { id: string; initiator_id: string; initiator_role: string; routing_segment?: string | null; routing_unit_head_id?: string | null; selected_rbe_id: string | null }): Promise<ResolvedRouting> {
  if (app.routing_segment) return { segment: app.routing_segment as Segment, rbeId: app.selected_rbe_id, unitHeadId: app.routing_unit_head_id ?? null };
  const r = await resolveRouting(tx, app.initiator_id, app.initiator_role);
  if (r.segment) {
    app.routing_segment = r.segment;
    app.routing_unit_head_id = r.unitHeadId;
    if (r.rbeId) app.selected_rbe_id = r.rbeId;
    await tx.query("UPDATE applications SET routing_segment = $2, routing_unit_head_id = $3, selected_rbe_id = coalesce($4, selected_rbe_id) WHERE id = $1", [app.id, r.segment, r.unitHeadId, r.rbeId]);
  }
  return r;
}

/** RMs who are not yet classified, or whose Non-DBC classification has no active RBE (Super Admin to resolve). */
export async function classificationGaps(q: Db) {
  return (
    await q.query<{ id: string; full_name: string; issue: string }>(
      `SELECT s.id, s.full_name,
              CASE WHEN c.staff_id IS NULL THEN 'Not classified as DBC or Non-DBC'
                   ELSE 'Non-DBC without an active Regional Business Executive' END AS issue
         FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active AND ra.role = 'RM'
         LEFT JOIN rm_classifications c ON c.staff_id = s.id
         LEFT JOIN org_links l ON l.staff_id = s.id AND l.relation = 'RBE'
        WHERE s.status = 'ACTIVE'
          AND (c.staff_id IS NULL OR (c.segment = 'NON_DBC' AND NOT EXISTS (
                SELECT 1 FROM role_assignments x JOIN staff m ON m.id = x.staff_id WHERE x.staff_id = l.manager_id AND x.role = 'RBE' AND x.active AND m.status = 'ACTIVE')))
        ORDER BY s.full_name`,
    )
  ).rows;
}
