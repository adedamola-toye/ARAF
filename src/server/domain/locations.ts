/**
 * Admin-managed outlet locations (State → Town/City → Outlet type → Outlet name), each mapped to an
 * Outlet Service Supervisor and a team. Routing and access use the mapping; submitted applications keep a
 * snapshot so later edits do not rewrite history.
 */
import type { Db } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, gate, invalid, notFound } from "../errors";
import { holdsRole } from "./access";
import { REGIONS } from "./roles";

export const OUTLET_TYPES = ["BRANCH", "ALTBOX", "ALTSHOP", "ALTLOUNGE"] as const;
export type OutletType = (typeof OUTLET_TYPES)[number];
export const OUTLET_TYPE_LABELS: Record<OutletType, string> = { BRANCH: "Branch", ALTBOX: "Altbox", ALTSHOP: "Altshop", ALTLOUNGE: "AltLounge" };

export interface LocationRow {
  id: string;
  state: string;
  city: string;
  outlet_type: OutletType;
  name: string;
  address: string | null;
  oss_staff_id: string | null;
  oss_name?: string | null;
  team: string | null;
  active: boolean;
  business_unit?: string | null;
  /** Relationship Managers can choose this location when originating a request. */
  rm_origination?: boolean;
  created_at?: Date;
  created_by_name?: string | null;
  updated_by_name?: string | null;
  updated_at: Date;
}

export interface LocationSnapshot {
  locationId: string;
  state: string;
  city: string;
  outletType: OutletType;
  outletName: string;
  address: string | null;
  ossStaffId: string | null;
  team: string | null;
  capturedAt: string;
}

export async function listLocations(q: Db, opts: { activeOnly?: boolean } = {}): Promise<LocationRow[]> {
  return (
    await q.query<LocationRow>(
      `SELECT l.*, s.full_name AS oss_name, cb.full_name AS created_by_name, ub.full_name AS updated_by_name
         FROM locations l LEFT JOIN staff s ON s.id = l.oss_staff_id LEFT JOIN staff cb ON cb.id = l.created_by LEFT JOIN staff ub ON ub.id = l.updated_by
        ${opts.activeOnly ? "WHERE l.active" : ""} ORDER BY l.state, l.city, l.outlet_type, l.name`,
    )
  ).rows;
}

export function snapshotOf(l: LocationRow, now: Date): LocationSnapshot {
  return { locationId: l.id, state: l.state, city: l.city, outletType: l.outlet_type, outletName: l.name, address: l.address, ossStaffId: l.oss_staff_id, team: l.team, capturedAt: now.toISOString() };
}

export interface LocationInput {
  id?: string | null;
  state: string;
  city: string;
  outletType: string;
  name: string;
  address?: string | null;
  ossStaffId?: string | null;
  team?: string | null;
  businessUnit?: string | null;
  rmOrigination?: boolean;
  active: boolean;
}

export async function saveLocation(ctx: Ctx, p: LocationInput) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can manage locations.");
    const e: Record<string, string> = {};
    if (!(REGIONS as readonly string[]).includes(p.state)) e.state = "Choose a state.";
    if ((p.city ?? "").trim().length < 2) e.city = "Enter the town or city.";
    if (!(OUTLET_TYPES as readonly string[]).includes(p.outletType)) e.outletType = "Choose the outlet type.";
    if ((p.name ?? "").trim().length < 2) e.name = "Enter the outlet name.";
    if (p.ossStaffId && !(await holdsRole(tx, p.ossStaffId, "OUTLET_SERVICE_SUPERVISOR"))) e.ossStaffId = "The selected person does not hold the Outlet Service Supervisor role.";
    if (Object.keys(e).length) throw invalid("Check the location details.", e);
    // Addresses are never typed here: they come from the location master (profiling workbook or an approved request).
    const vals = [p.state, p.city.trim(), p.outletType, p.name.trim(), p.ossStaffId || null, (p.team ?? "").trim() || null, p.active, actor.staffId, ctx.now, (p.businessUnit ?? "").trim() || null, !!p.rmOrigination];
    try {
      const SHOP_OR_BOX = ["ALTSHOP", "ALTBOX"];
      const viaPm = "New Altshops and Altboxes, a change into one, and reactivating one are proposed by the Altphones Product Manager (Altphones → Locations) and take effect only after Unit Head approval.";
      if (!p.id && SHOP_OR_BOX.includes(p.outletType)) throw gate(viaPm);
      if (p.id) {
        const before = (await tx.query("SELECT * FROM locations WHERE id = $1 FOR UPDATE", [p.id])).rows[0];
        if (!before) throw notFound();
        if (SHOP_OR_BOX.includes(p.outletType) && ((!before.active && p.active) || !SHOP_OR_BOX.includes(before.outlet_type) || before.outlet_type !== p.outletType)) throw gate(viaPm);
        await tx.query(
          `UPDATE locations SET state=$2, city=$3, outlet_type=$4, name=$5, oss_staff_id=$6, team=$7, active=$8, updated_by=$9, updated_at=$10, business_unit=$11, rm_origination=$12 WHERE id=$1`,
          [p.id, ...vals],
        );
        await audit(tx, ctx, { action: "LOCATION_UPDATED", actorRole: "SUPER_ADMIN", details: { locationId: p.id, before: { state: before.state, city: before.city, outletType: before.outlet_type, name: before.name, oss: before.oss_staff_id, team: before.team, active: before.active, businessUnit: before.business_unit, rmOrigination: before.rm_origination }, after: { state: p.state, city: p.city, outletType: p.outletType, name: p.name, oss: p.ossStaffId ?? null, team: p.team ?? null, active: p.active, businessUnit: p.businessUnit ?? null, rmOrigination: !!p.rmOrigination } } });
        return p.id;
      }
      const r = await tx.query<{ id: string }>(
        `INSERT INTO locations (state, city, outlet_type, name, oss_staff_id, team, active, created_by, created_at, updated_by, updated_at, business_unit, rm_origination)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9,$10,$11) RETURNING id`,
        vals,
      );
      await audit(tx, ctx, { action: "LOCATION_CREATED", actorRole: "SUPER_ADMIN", details: { locationId: r.rows[0].id, state: p.state, city: p.city, outletType: p.outletType, name: p.name, oss: p.ossStaffId ?? null, team: p.team ?? null, businessUnit: p.businessUnit ?? null, rmOrigination: !!p.rmOrigination } });
      return r.rows[0].id;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw conflict("A location with this state, city, outlet type and name already exists.");
      throw err;
    }
  });
}

/** Active locations Relationship Managers can choose when originating a request. */
export async function rmOriginationLocations(q: Db): Promise<{ id: string; name: string; state: string; city: string; outlet_type: OutletType }[]> {
  return (await q.query("SELECT id, name, state, city, outlet_type FROM locations WHERE active AND rm_origination ORDER BY state, name")).rows;
}

/** Requests, RMs and change history for one location (Super Admin location management). */
export async function locationActivity(q: Db, id: string) {
  const [apps, rms, history] = await Promise.all([
    q.query(
      `SELECT a.id, a.ref, a.customer_name, a.product_label, a.status, a.stage, a.requested_amount_kobo, a.submitted_at, s.full_name AS initiator
         FROM applications a JOIN staff s ON s.id = a.initiator_id
        WHERE a.origination_location_id = $1 OR a.outlet_location_id = $1 ORDER BY a.created_at DESC LIMIT 100`,
      [id],
    ),
    q.query(
      `SELECT s.id, s.full_name, s.email, count(*)::int AS requests FROM applications a JOIN staff s ON s.id = a.initiator_id
        WHERE a.origination_location_id = $1 AND a.initiator_role = 'RM' GROUP BY s.id ORDER BY count(*) DESC`,
      [id],
    ),
    q.query(
      `SELECT e.action, e.occurred_at, e.details, s.full_name AS actor FROM audit_events e LEFT JOIN staff s ON s.id = e.actor_id
        WHERE e.action IN ('LOCATION_CREATED','LOCATION_UPDATED') AND e.details->>'locationId' = $1 ORDER BY e.id DESC LIMIT 50`,
      [id],
    ),
  ]);
  return { applications: apps.rows, rms: rms.rows, history: history.rows };
}
