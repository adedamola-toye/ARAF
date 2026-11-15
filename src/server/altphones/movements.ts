/**
 * Inventory movements beyond sales (maker-checker): transfers between Branches/Altshops, returns into stock,
 * damaged write-offs and approved adjustments. Requested by the Altphones Product Manager (or a Super Admin);
 * posted to the ledger only when the Altphones Unit Head (a different person) approves. Balances can never go
 * below what is reserved, and IMEIs move with the units when they are given.
 */
import type { Db } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { holdsRole } from "../domain/access";
import { isUuid, nextRef, PM_ROLE, roleHolders } from "./core";
import { holdsStock, locationInfo, parseImeiList, post, type Movement } from "./stock";
import { isApprover } from "./location-master";
import { enqueueEmail } from "../notify/outbox";
import { simpleEmail } from "../notify/templates";
import { config } from "../config";

export const MOVEMENT_KINDS = ["TRANSFER", "RETURN", "DAMAGED", "ADJUSTMENT"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];
export const MOVEMENT_LABELS: Record<MovementKind, string> = {
  TRANSFER: "Transfer to another location",
  RETURN: "Return into stock",
  DAMAGED: "Damaged (write-off)",
  ADJUSTMENT: "Approved adjustment",
};

export interface MovementInput {
  kind: string;
  locationId: string;
  toLocationId?: string | null;
  modelId: string;
  quantity: number;
  imeis?: string;
  note: string;
}

async function balance(q: Db, locationId: string, modelId: string) {
  return (await q.query<{ physical: number; reserved: number }>("SELECT physical, reserved FROM altphones_stock WHERE location_id = $1 AND model_id = $2", [locationId, modelId])).rows[0] ?? { physical: 0, reserved: 0 };
}

export async function requestMovement(ctx: Ctx, p: MovementInput) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, PM_ROLE)) && !(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only the Altphones Product Manager or a Super Admin can request a stock movement.");
    const e: Record<string, string> = {};
    const kind = (MOVEMENT_KINDS as readonly string[]).includes(p.kind) ? (p.kind as MovementKind) : null;
    if (!kind) e.kind = "Choose the movement.";
    const from = await locationInfo(tx, p.locationId);
    if (!from || !holdsStock(from.outlet_type)) e.locationId = "Choose a Branch or Altshop (Altboxes do not hold stock).";
    let to = null as Awaited<ReturnType<typeof locationInfo>>;
    if (kind === "TRANSFER") {
      to = await locationInfo(tx, p.toLocationId ?? null);
      if (!to || !holdsStock(to.outlet_type)) e.toLocationId = "Choose the receiving Branch or Altshop.";
      else if (!to.active) e.toLocationId = "The receiving location is not active.";
      else if (from && to.id === from.id) e.toLocationId = "Choose a different receiving location.";
    }
    const model = isUuid(p.modelId) ? (await tx.query<{ id: string; name: string }>("SELECT id, name FROM altphones_models WHERE id = $1", [p.modelId])).rows[0] : null;
    if (!model) e.modelId = "Choose the phone.";
    const qty = Number(p.quantity);
    if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > 10000) e.quantity = "Enter a whole number of units.";
    else if (kind !== "ADJUSTMENT" && qty < 0) e.quantity = "Enter the number of units (positive).";
    const { imeis, errors } = parseImeiList(p.imeis ?? "");
    if (errors.length) e.imeis = errors.join(" ");
    else if (imeis.length > Math.abs(qty)) e.imeis = "More IMEIs than units.";
    const note = (p.note ?? "").trim().slice(0, 500);
    if (note.length < 5) e.note = "Give the reason or reference (delivery note, damage report…).";
    if (Object.keys(e).length) throw invalid("Check the stock movement.", e);
    // Units leaving a location must be available (not reserved for paid customers).
    const out = kind === "TRANSFER" || kind === "DAMAGED" ? qty : kind === "ADJUSTMENT" && qty < 0 ? -qty : 0;
    if (out) {
      const b = await balance(tx, from!.id, model!.id);
      if (b.physical - b.reserved < out) throw conflict(`${from!.name} has ${b.physical - b.reserved} available ${model!.name} (${b.reserved} reserved for paid customers), fewer than ${out}.`);
    }
    for (const imei of imeis) {
      const d = (await tx.query<{ status: string; location_id: string | null }>("SELECT status, location_id FROM altphones_devices WHERE imei = $1", [imei])).rows[0];
      if (kind === "RETURN") {
        if (d && d.status !== "DAMAGED") throw conflict(`IMEI ${imei} is already registered (${d.status.toLowerCase().replace("_", " ")}). Issued phones are returned through their application.`);
      } else if (kind === "TRANSFER" || kind === "DAMAGED") {
        if (!d || d.status !== "IN_STOCK" || d.location_id !== from!.id) throw conflict(`IMEI ${imei} is not an in-stock unit at ${from!.name}.`);
      }
    }
    const ref = await nextRef(tx, "altphones_stock_movement_seq", "MOV", ctx.now);
    const row = (
      await tx.query<{ id: string }>(
        "INSERT INTO altphones_stock_movements (ref, kind, location_id, to_location_id, model_id, quantity, imeis, note, requested_by, requested_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
        [ref, kind, from!.id, to?.id ?? null, model!.id, qty, imeis, note, actor.staffId, ctx.now],
      )
    ).rows[0];
    await audit(tx, ctx, { action: "ALTPHONES_STOCK_MOVEMENT_REQUESTED", details: { ref, kind, location: from!.name, to: to?.name ?? null, model: model!.name, quantity: qty, imeis: imeis.length, note } });
    const uhs = (await roleHolders(tx, ["UNIT_HEAD"])).filter((u) => u.id !== actor.staffId);
    const approvers = [];
    for (const u of uhs) if (await isApprover(tx, u.id)) approvers.push(u);
    if (approvers.length)
      await enqueueEmail(tx, ctx.now, {
        kind: "ALTPHONES_STOCK_MOVEMENT",
        dedupeKey: `altphones:movement:${row.id}`,
        to: approvers.map((a) => a.email),
        subject: `[${ref}] Altphones stock movement awaiting your approval`,
        text: simpleEmail([`${actor.name} requested: ${MOVEMENT_LABELS[kind!]} — ${qty} × ${model!.name} at ${from!.name}${to ? ` → ${to.name}` : ""}.`, `Reason: ${note}`, "", `Approve or reject it (sign-in required): ${config.appUrl}/altphones/inventory`]),
      });
    return { id: row.id, ref };
  });
}

export async function decideMovement(ctx: Ctx, id: string, p: { decision: string; note?: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!isUuid(id)) throw notFound("Movement not found.");
  return withTx(async (tx) => {
    if (!(await isApprover(tx, actor.staffId))) throw forbidden("Only the Altphones Unit Head can approve a stock movement.");
    const m = (await tx.query("SELECT * FROM altphones_stock_movements WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!m) throw notFound("Movement not found.");
    if (m.status !== "PENDING") throw conflict(`${m.ref} has already been decided.`);
    if (m.requested_by === actor.staffId) throw forbidden("You requested this movement, so another approver must decide it.");
    const note = (p.note ?? "").trim().slice(0, 500);
    if (p.decision === "REJECT") {
      if (note.length < 3) throw invalid("Give the reason for rejecting.", { note: "Enter a reason." });
      await tx.query("UPDATE altphones_stock_movements SET status = 'REJECTED', decided_by = $2, decided_at = $3, decision_note = $4 WHERE id = $1", [id, actor.staffId, ctx.now, note]);
      await audit(tx, ctx, { action: "ALTPHONES_STOCK_MOVEMENT_REJECTED", details: { ref: m.ref, note } });
      return { ref: m.ref, approved: false };
    }
    if (p.decision !== "APPROVE") throw invalid("Choose approve or reject.");
    const base = { modelId: m.model_id as string, reserved: 0, reference: m.ref as string, note: m.note as string };
    const kind = m.kind as MovementKind;
    // post() re-checks the balance under a row lock: a movement can never take reserved units.
    if (kind === "TRANSFER") {
      await post(tx, ctx, { ...base, locationId: m.location_id, movement: "TRANSFER_OUT", physical: -m.quantity });
      await post(tx, ctx, { ...base, locationId: m.to_location_id, movement: "TRANSFER_IN", physical: m.quantity });
      if (m.imeis.length) await tx.query("UPDATE altphones_devices SET location_id = $2 WHERE imei = ANY($1) AND status = 'IN_STOCK' AND location_id = $3", [m.imeis, m.to_location_id, m.location_id]);
    } else if (kind === "RETURN") {
      await post(tx, ctx, { ...base, locationId: m.location_id, movement: "RETURN", physical: m.quantity });
      for (const imei of m.imeis as string[])
        await tx.query(
          `INSERT INTO altphones_devices (imei, model_id, location_id, status, registered_by, registered_at) VALUES ($1,$2,$3,'IN_STOCK',$4,$5)
           ON CONFLICT (imei) DO UPDATE SET status = 'IN_STOCK', location_id = EXCLUDED.location_id WHERE altphones_devices.status = 'DAMAGED'`,
          [imei, m.model_id, m.location_id, actor.staffId, ctx.now],
        );
    } else if (kind === "DAMAGED") {
      await post(tx, ctx, { ...base, locationId: m.location_id, movement: "DAMAGED", physical: -m.quantity });
      if (m.imeis.length) await tx.query("UPDATE altphones_devices SET status = 'DAMAGED' WHERE imei = ANY($1) AND status = 'IN_STOCK' AND location_id = $2", [m.imeis, m.location_id]);
    } else {
      await post(tx, ctx, { ...base, locationId: m.location_id, movement: "ADJUSTMENT" as Movement, physical: m.quantity });
    }
    await tx.query("UPDATE altphones_stock_movements SET status = 'APPROVED', decided_by = $2, decided_at = $3, decision_note = $4 WHERE id = $1", [id, actor.staffId, ctx.now, note || null]);
    await audit(tx, ctx, { action: "ALTPHONES_STOCK_MOVEMENT_APPROVED", details: { ref: m.ref, kind, quantity: m.quantity } });
    return { ref: m.ref, approved: true };
  });
}

export async function listMovements(q: Db, opts: { status?: string; limit?: number } = {}) {
  return (
    await q.query(
      `SELECT m.*, l.name AS location_name, t.name AS to_location_name, md.name AS model_name, r.full_name AS requested_by_name, d.full_name AS decided_by_name
         FROM altphones_stock_movements m JOIN locations l ON l.id = m.location_id LEFT JOIN locations t ON t.id = m.to_location_id
         JOIN altphones_models md ON md.id = m.model_id JOIN staff r ON r.id = m.requested_by LEFT JOIN staff d ON d.id = m.decided_by
        WHERE ($1::text IS NULL OR m.status = $1) ORDER BY m.requested_at DESC LIMIT $2`,
      [opts.status ?? null, opts.limit ?? 100],
    )
  ).rows;
}
