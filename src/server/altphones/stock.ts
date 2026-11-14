/**
 * Altphones stock. Every change is an append-only ledger entry posted in the same transaction as the
 * running balance (altphones_stock), which is locked row-by-row so two officers can never take the
 * same unit. Available = physical − reserved. Only Branches and Shops hold stock.
 *
 *   down payment / outright payment verified → RESERVE   (reserved +1)
 *   rejection / cancellation                 → RELEASE   (reserved −1)
 *   outright handover                        → SALE      (physical −1, reserved −1)
 *   credit disbursement                      → DISBURSEMENT (physical −1, reserved −1)
 *   approved replenishment / opening stock   → RECEIPT / OPENING (physical +n)
 *   approved stock count                     → COUNT_ADJUSTMENT (physical ± variance)
 *
 * Colour-agnostic stock: units counted without a colour sit in the stock-pool model. A sale of any colour
 * reserves its own colour when available at the supplying location, otherwise a pool unit there; the
 * application records which balance it took (stock_model_id), so release and handover use the same one.
 */
import type { Db, Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, gate, invalid, notFound } from "../errors";
import { holdsRole } from "../domain/access";
import { isImei } from "@/lib/altphones";
import { type AltApp, isUuid, nextRef, PM_ROLE, roleHolders } from "./core";
import { enqueueEmail } from "../notify/outbox";
import { simpleEmail } from "../notify/templates";
import { config } from "../config";

export type Movement = "OPENING" | "RECEIPT" | "RESERVE" | "RELEASE" | "SALE" | "DISBURSEMENT" | "LEGACY_ADJUSTMENT" | "COUNT_ADJUSTMENT";

/** The colour-agnostic stock-pool model, if configured. */
export async function poolModelId(q: Db): Promise<string | null> {
  return (await q.query<{ id: string }>("SELECT id FROM altphones_models WHERE stock_pool LIMIT 1")).rows[0]?.id ?? null;
}
/** The balance an application's reservation sits in. */
export const stockModelOf = (app: AltApp): string => app.stock_model_id ?? app.model_id;

async function availableExact(q: Db, locationId: string, modelId: string): Promise<number> {
  const r = (await q.query<{ a: number }>("SELECT physical - reserved AS a FROM altphones_stock WHERE location_id = $1 AND model_id = $2", [locationId, modelId])).rows[0];
  return r ? Number(r.a) : 0;
}

export async function locationInfo(q: Db, id: string | null | undefined): Promise<{ id: string; name: string; outlet_type: string; state: string; city: string; active: boolean } | null> {
  if (!id || !isUuid(id)) return null;
  return (await q.query("SELECT id, name, outlet_type, state, city, active FROM locations WHERE id = $1", [id])).rows[0] ?? null;
}

export function holdsStock(type: string) {
  return type === "BRANCH" || type === "ALTSHOP";
}

/** Post one ledger movement and apply it to the balance under a row lock. */
export async function post(
  tx: Tx,
  ctx: Ctx,
  m: { locationId: string; modelId: string; movement: Movement; physical: number; reserved: number; applicationId?: string | null; deviceId?: string | null; replenishmentId?: string | null; importId?: string | null; reference?: string | null; legacy?: boolean; note?: string | null; occurredAt?: Date },
) {
  const loc = await locationInfo(tx, m.locationId);
  if (!loc) throw notFound("Location not found.");
  if (!holdsStock(loc.outlet_type)) throw invalid("BOX locations cannot hold stock. Choose a Branch or a Shop.");
  await tx.query("INSERT INTO altphones_stock (location_id, model_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [m.locationId, m.modelId]);
  const bal = (await tx.query<{ physical: number; reserved: number }>("SELECT physical, reserved FROM altphones_stock WHERE location_id = $1 AND model_id = $2 FOR UPDATE", [m.locationId, m.modelId])).rows[0];
  const physical = bal.physical + m.physical;
  const reserved = bal.reserved + m.reserved;
  if (physical < 0) throw conflict(`There is no physical stock of this phone at ${loc.name}.`);
  if (reserved < 0) throw conflict(`There is no reserved unit to release at ${loc.name}.`);
  if (reserved > physical) throw gate(`No phone of this model is available at ${loc.name}. Every unit in stock is already reserved or sold.`);
  await tx.query("UPDATE altphones_stock SET physical = $3, reserved = $4, updated_at = $5 WHERE location_id = $1 AND model_id = $2", [m.locationId, m.modelId, physical, reserved, ctx.now]);
  await tx.query(
    `INSERT INTO altphones_stock_ledger (location_id, model_id, movement, physical_delta, reserved_delta, application_id, device_id, replenishment_id, import_id, reference, legacy, note, actor_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [m.locationId, m.modelId, m.movement, m.physical, m.reserved, m.applicationId ?? null, m.deviceId ?? null, m.replenishmentId ?? null, m.importId ?? null, m.reference ?? null, m.legacy ?? false, m.note ?? null, ctx.actor?.staffId ?? null, m.occurredAt ?? ctx.now],
  );
  return { physical, reserved, available: physical - reserved };
}

/** Units a sale of this model can take at a location: its own colour plus colour-not-recorded units. */
export async function availableAt(q: Db, locationId: string, modelId: string): Promise<number> {
  const pool = await poolModelId(q);
  return (await availableExact(q, locationId, modelId)) + (pool && pool !== modelId ? await availableExact(q, locationId, pool) : 0);
}

/**
 * Reserve one unit for a paid application (atomic; refuses when nothing is available). Earmarks an
 * IMEI-registered unit when one is in stock, so the officer sees which device to hand over.
 */
export async function reserveUnit(tx: Tx, ctx: Ctx, app: AltApp): Promise<string | null> {
  if (app.reservation_status === "RESERVED") return app.device_id ?? null;
  // Own colour first; otherwise a colour-not-recorded unit at the same location; otherwise post() refuses.
  const pool = await poolModelId(tx);
  const fromPool = !!pool && pool !== app.model_id && (await availableExact(tx, app.supply_location_id, app.model_id)) < 1 && (await availableExact(tx, app.supply_location_id, pool)) >= 1;
  const stockModel = fromPool ? pool! : app.model_id;
  await post(tx, ctx, { locationId: app.supply_location_id, modelId: stockModel, movement: "RESERVE", physical: 0, reserved: 1, applicationId: app.id, reference: app.ref, note: fromPool ? "Colour-not-recorded unit" : null });
  await tx.query("UPDATE altphones_applications SET stock_model_id = $2 WHERE id = $1", [app.id, stockModel]);
  app.stock_model_id = stockModel;
  const dev = (
    await tx.query<{ id: string }>(
      `SELECT id FROM altphones_devices WHERE location_id = $1 AND model_id = $2 AND status = 'IN_STOCK' ORDER BY registered_at, imei LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [app.supply_location_id, stockModel],
    )
  ).rows[0];
  if (dev) await tx.query("UPDATE altphones_devices SET status = 'RESERVED', application_id = $2 WHERE id = $1", [dev.id, app.id]);
  return dev?.id ?? null;
}

export async function releaseUnit(tx: Tx, ctx: Ctx, app: AltApp, note: string) {
  if (app.reservation_status !== "RESERVED") return;
  await post(tx, ctx, { locationId: app.supply_location_id, modelId: stockModelOf(app), movement: "RELEASE", physical: 0, reserved: -1, applicationId: app.id, reference: app.ref, note });
  await tx.query("UPDATE altphones_devices SET status = 'IN_STOCK', application_id = NULL WHERE application_id = $1 AND status = 'RESERVED'", [app.id]);
}

/**
 * Hand the reserved unit over (sale or disbursement): physical −1 and reserved −1 in one entry, so
 * available stock is never deducted twice. The IMEI is the reserved device, another registered device
 * in stock at the same location, or a newly captured IMEI for an unregistered unit.
 */
export async function issueUnit(tx: Tx, ctx: Ctx, app: AltApp, imeiRaw: string, movement: "SALE" | "DISBURSEMENT"): Promise<{ deviceId: string; imei: string }> {
  const imei = imeiRaw.replace(/\s/g, "");
  if (!isImei(imei)) throw invalid("Enter the 15-digit IMEI.", { imei: "The IMEI must be exactly 15 digits." });
  if (app.reservation_status !== "RESERVED") throw conflict("No unit is reserved for this application.");
  let dev = (await tx.query<{ id: string; status: string; location_id: string | null; model_id: string; application_id: string | null }>("SELECT * FROM altphones_devices WHERE imei = $1 FOR UPDATE", [imei])).rows[0];
  if (dev) {
    const mine = dev.status === "RESERVED" && dev.application_id === app.id;
    const free = dev.status === "IN_STOCK" && dev.location_id === app.supply_location_id && dev.model_id === stockModelOf(app);
    if (!mine && !free) {
      throw invalid("This IMEI cannot be issued.", {
        imei: dev.status === "ISSUED" ? "This IMEI has already been issued to a customer." : dev.model_id !== app.model_id ? "This IMEI belongs to a different phone model." : "This IMEI is not in stock at the supplying location, or is reserved for another customer.",
      });
    }
    if (!mine) await tx.query("UPDATE altphones_devices SET status = 'IN_STOCK', application_id = NULL WHERE application_id = $1 AND status = 'RESERVED'", [app.id]);
  } else {
    // A unit counted in stock without a registered IMEI: register it now, within the physical count.
    const tracked = Number(
      (await tx.query<{ n: string }>("SELECT count(*) AS n FROM altphones_devices WHERE location_id = $1 AND model_id = $2 AND status IN ('IN_STOCK','RESERVED') AND (application_id IS DISTINCT FROM $3)", [app.supply_location_id, stockModelOf(app), app.id])).rows[0].n,
    );
    const phys = (await tx.query<{ physical: number }>("SELECT physical FROM altphones_stock WHERE location_id = $1 AND model_id = $2", [app.supply_location_id, stockModelOf(app)])).rows[0]?.physical ?? 0;
    if (tracked + 1 > phys) throw invalid("This IMEI is not registered at the supplying location.", { imei: "Every unit in stock there already has a registered IMEI. Choose one of them." });
    await tx.query("UPDATE altphones_devices SET status = 'IN_STOCK', application_id = NULL WHERE application_id = $1 AND status = 'RESERVED'", [app.id]);
    dev = (
      await tx.query("INSERT INTO altphones_devices (imei, model_id, location_id, status, application_id, registered_by, registered_at) VALUES ($1,$2,$3,'IN_STOCK',NULL,$4,$5) RETURNING *", [
        imei,
        app.model_id,
        app.supply_location_id,
        ctx.actor?.staffId ?? null,
        ctx.now,
      ])
    ).rows[0];
  }
  await post(tx, ctx, { locationId: app.supply_location_id, modelId: stockModelOf(app), movement, physical: -1, reserved: -1, applicationId: app.id, deviceId: dev!.id, reference: app.ref });
  // The issued device is recorded as the colour the customer actually received.
  await tx.query("UPDATE altphones_devices SET status = 'ISSUED', application_id = $2, issued_at = $3, model_id = $4 WHERE id = $1", [dev!.id, app.id, ctx.now, app.model_id]);
  return { deviceId: dev!.id, imei };
}

/** Devices the officer can hand over for this application (reserved first). */
export async function issuableDevices(q: Db, app: AltApp) {
  return (
    await q.query<{ id: string; imei: string; status: string }>(
      `SELECT id, imei, status FROM altphones_devices
        WHERE (application_id = $1 AND status = 'RESERVED') OR (location_id = $2 AND model_id = $3 AND status = 'IN_STOCK')
        ORDER BY (status = 'RESERVED') DESC, imei LIMIT 200`,
      [app.id, app.supply_location_id, stockModelOf(app)],
    )
  ).rows;
}

// ------------------------------------------------------------------ replenishment (PM requests, Super Admin approves)

export interface ReplenishmentInput {
  kind: string;
  locationId: string;
  modelId: string;
  quantity: string;
  imeis: string;
  reason: string;
}

export function parseImeiList(raw: string): { imeis: string[]; errors: string[] } {
  const parts = raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (!isImei(p)) errors.push(`"${p}" is not a 15-digit IMEI.`);
    else if (seen.has(p)) errors.push(`${p} is listed twice.`);
    seen.add(p);
  }
  return { imeis: [...seen].filter(isImei), errors };
}

export async function requestReplenishment(ctx: Ctx, p: ReplenishmentInput) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, PM_ROLE))) throw forbidden("Only the Altphones Product Manager can request stock.");
    const e: Record<string, string> = {};
    const loc = await locationInfo(tx, p.locationId);
    if (!loc) e.locationId = "Choose a Branch or Shop.";
    else if (!holdsStock(loc.outlet_type)) e.locationId = "BOX locations cannot hold stock.";
    const model = isUuid(p.modelId) ? (await tx.query("SELECT id, name FROM altphones_models WHERE id = $1", [p.modelId])).rows[0] : null;
    if (!model) e.modelId = "Choose the phone model.";
    const qty = Number(p.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100000) e.quantity = "Enter a whole number of units.";
    if (!["OPENING", "RECEIPT"].includes(p.kind)) e.kind = "Choose opening stock or a stock receipt.";
    const { imeis, errors } = parseImeiList(p.imeis ?? "");
    if (errors.length) e.imeis = errors.slice(0, 3).join(" ");
    else if (Number.isInteger(qty) && imeis.length > qty) e.imeis = `${imeis.length} IMEIs listed for ${qty} units.`;
    if (imeis.length) {
      const dup = (await tx.query<{ imei: string }>("SELECT imei FROM altphones_devices WHERE imei = ANY($1)", [imeis])).rows;
      if (dup.length) e.imeis = `Already registered: ${dup.slice(0, 3).map((d) => d.imei).join(", ")}.`;
    }
    if ((p.reason ?? "").trim().length < 3) e.reason = "Say where the stock comes from (delivery note, supplier, transfer).";
    if (Object.keys(e).length) throw invalid("Check the stock request.", e);
    const ref = await nextRef(tx, "altphones_replenishment_seq", "STK", ctx.now);
    const row = (
      await tx.query(
        `INSERT INTO altphones_replenishments (ref, kind, location_id, model_id, quantity, imeis, reason, requested_by, requested_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, ref`,
        [ref, p.kind, p.locationId, p.modelId, qty, imeis, p.reason.trim(), actor.staffId, ctx.now],
      )
    ).rows[0];
    await audit(tx, ctx, { action: "ALTPHONES_STOCK_REQUESTED", details: { ref, kind: p.kind, location: loc!.name, model: model.name, quantity: qty, imeis: imeis.length } });
    const admins = await roleHolders(tx, ["SUPER_ADMIN"]);
    if (admins.length) {
      await enqueueEmail(tx, ctx.now, {
        kind: "ALTPHONES_STOCK_REQUESTED",
        dedupeKey: `altphones:stock-request:${row.id}`,
        to: admins.map((a) => a.email),
        subject: `[${ref}] Altphones stock request awaiting approval`,
        text: simpleEmail([`${actor.name} requested ${qty} × ${model.name} for ${loc!.name}.`, "", `Approve or reject it (sign-in required): ${config.appUrl}/altphones/inventory`]),
      });
    }
    return row;
  });
}

export async function decideReplenishment(ctx: Ctx, id: string, p: { decision: "APPROVE" | "REJECT"; comment: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can approve stock.");
    if (!isUuid(id)) throw notFound("Stock request not found.");
    const r = (await tx.query("SELECT * FROM altphones_replenishments WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!r) throw notFound("Stock request not found.");
    if (r.status !== "PENDING") throw conflict("This stock request has already been decided.");
    if (r.requested_by === actor.staffId) throw forbidden("Separation of duties: you cannot approve your own stock request.");
    if (p.decision === "REJECT" && (p.comment ?? "").trim().length < 3) throw invalid("Give the reason for rejecting.", { comment: "Enter a reason." });
    await tx.query("UPDATE altphones_replenishments SET status = $2, decided_by = $3, decided_at = $4, decision_comment = $5 WHERE id = $1", [
      id,
      p.decision === "APPROVE" ? "APPROVED" : "REJECTED",
      actor.staffId,
      ctx.now,
      p.comment?.trim() || null,
    ]);
    if (p.decision === "APPROVE") {
      if (r.imeis.length) {
        const dup = (await tx.query<{ imei: string }>("SELECT imei FROM altphones_devices WHERE imei = ANY($1)", [r.imeis])).rows;
        if (dup.length) throw conflict(`These IMEIs were registered since the request was made: ${dup.map((d) => d.imei).join(", ")}. Reject it and ask for a corrected request.`);
        await tx.query(
          `INSERT INTO altphones_devices (imei, model_id, location_id, status, registered_by, registered_at) SELECT x, $2, $3, 'IN_STOCK', $4, $5 FROM unnest($1::text[]) AS x`,
          [r.imeis, r.model_id, r.location_id, actor.staffId, ctx.now],
        );
      }
      await post(tx, ctx, { locationId: r.location_id, modelId: r.model_id, movement: r.kind, physical: r.quantity, reserved: 0, replenishmentId: r.id, reference: r.ref, note: r.reason });
    }
    await audit(tx, ctx, { action: p.decision === "APPROVE" ? "ALTPHONES_STOCK_APPROVED" : "ALTPHONES_STOCK_REJECTED", reason: p.comment || null, details: { ref: r.ref, quantity: r.quantity } });
    return { ref: r.ref };
  });
}

// ------------------------------------------------------------------ reporting

export interface StockRow {
  location_id: string;
  location_name: string;
  outlet_type: string;
  state: string;
  city: string;
  model_id: string;
  model_name: string;
  opening: number;
  received: number;
  physical: number;
  reserved: number;
  available: number;
  sales: number;
  disbursements: number;
  legacy: number;
  remaining: number;
  imeis_in_stock: number;
}

/** Balances with the ledger-derived figures; `remaining` is recomputed from the ledger and must equal `physical`. */
export async function stockOverview(q: Db, opts: { locationId?: string | null } = {}): Promise<StockRow[]> {
  return (
    await q.query<StockRow>(
      `SELECT s.location_id, l.name AS location_name, l.outlet_type, l.state, l.city, s.model_id, m.name AS model_name,
              coalesce(sum(g.physical_delta) FILTER (WHERE g.movement = 'OPENING'), 0)::int AS opening,
              coalesce(sum(g.physical_delta) FILTER (WHERE g.movement = 'RECEIPT'), 0)::int AS received,
              s.physical, s.reserved, (s.physical - s.reserved) AS available,
              coalesce(-sum(g.physical_delta) FILTER (WHERE g.movement = 'SALE'), 0)::int AS sales,
              coalesce(-sum(g.physical_delta) FILTER (WHERE g.movement = 'DISBURSEMENT'), 0)::int AS disbursements,
              coalesce(sum(g.physical_delta) FILTER (WHERE g.movement = 'LEGACY_ADJUSTMENT'), 0)::int AS legacy,
              coalesce(sum(g.physical_delta), 0)::int AS remaining,
              (SELECT count(*) FROM altphones_devices d WHERE d.location_id = s.location_id AND d.model_id = s.model_id AND d.status IN ('IN_STOCK','RESERVED'))::int AS imeis_in_stock
         FROM altphones_stock s
         JOIN locations l ON l.id = s.location_id
         JOIN altphones_models m ON m.id = s.model_id
         LEFT JOIN altphones_stock_ledger g ON g.location_id = s.location_id AND g.model_id = s.model_id
        WHERE ($1::uuid IS NULL OR s.location_id = $1)
        GROUP BY s.location_id, l.name, l.outlet_type, l.state, l.city, s.model_id, m.name, s.physical, s.reserved
        ORDER BY l.state, l.name, m.name`,
      [opts.locationId ?? null],
    )
  ).rows;
}

/** Locations that can supply a model, with what is available now. */
export async function supplyOptions(q: Db, modelId: string | null, near?: { state: string; city: string } | null) {
  return (
    await q.query<{ id: string; name: string; outlet_type: string; state: string; city: string; available: number; same_city: boolean; same_state: boolean }>(
      `SELECT l.id, l.name, l.outlet_type, l.state, l.city,
              coalesce((SELECT sum(s.physical - s.reserved) FROM altphones_stock s JOIN altphones_models m ON m.id = s.model_id WHERE s.location_id = l.id AND (s.model_id = $1 OR m.stock_pool)), 0)::int AS available,
              (l.state = $2 AND lower(l.city) = lower($3)) AS same_city, (l.state = $2) AS same_state
         FROM locations l
        WHERE l.active AND l.outlet_type IN ('BRANCH','ALTSHOP')
        ORDER BY (l.state = $2 AND lower(l.city) = lower($3)) DESC, (l.state = $2) DESC, l.state, l.city, l.name`,
      [modelId, near?.state ?? "", near?.city ?? ""],
    )
  ).rows;
}

// ------------------------------------------------------------------ physical stock counts (maker-checker)

export interface StockCountInput {
  locationId: string;
  countedOn: string;
  note: string;
  lines: { modelId: string; counted: string }[];
}

const COUNTERS = ["SUPER_ADMIN", PM_ROLE];

/**
 * Record a physical count at a Branch or Shop. Nothing changes until a different Super Admin approves it;
 * the variance against the ledger at the time of counting is then posted as a COUNT_ADJUSTMENT.
 */
export async function submitStockCount(ctx: Ctx, p: StockCountInput) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await Promise.all(COUNTERS.map((r) => holdsRole(tx, actor.staffId, r)))).some(Boolean)) throw forbidden("Only the Altphones Product Manager or a Super Admin can record a stock count.");
    const e: Record<string, string> = {};
    const loc = await locationInfo(tx, p.locationId);
    if (!loc) e.locationId = "Choose a Branch or Shop.";
    else if (!holdsStock(loc.outlet_type)) e.locationId = "BOX locations do not hold stock.";
    const day = /^\d{4}-\d{2}-\d{2}$/.test(p.countedOn ?? "") ? p.countedOn : "";
    const today = new Date(ctx.now.getTime() + 3600_000).toISOString().slice(0, 10); // Lagos date
    if (!day) e.countedOn = "Enter the date of the count.";
    else if (day > today) e.countedOn = "The count date cannot be in the future.";
    const lines: { modelId: string; counted: number; system: number; reserved: number; name: string }[] = [];
    for (const l of p.lines ?? []) {
      if (!isUuid(l.modelId)) continue;
      const raw = String(l.counted ?? "").trim();
      if (raw === "") continue;
      const counted = Number(raw);
      const m = (await tx.query<{ name: string }>("SELECT name FROM altphones_models WHERE id = $1", [l.modelId])).rows[0];
      if (!m) continue;
      if (!Number.isInteger(counted) || counted < 0 || counted > 100000) {
        e[`count_${l.modelId}`] = `${m.name}: enter a whole number of units.`;
        continue;
      }
      const bal = loc ? (await tx.query<{ physical: number; reserved: number }>("SELECT physical, reserved FROM altphones_stock WHERE location_id = $1 AND model_id = $2", [loc.id, l.modelId])).rows[0] : undefined;
      const reserved = bal?.reserved ?? 0;
      if (counted < reserved) e[`count_${l.modelId}`] = `${m.name}: ${reserved} unit${reserved === 1 ? " is" : "s are"} reserved for paid customers, so the count cannot be lower.`;
      lines.push({ modelId: l.modelId, counted, system: bal?.physical ?? 0, reserved, name: m.name });
    }
    if (!lines.length && !Object.keys(e).length) e.lines = "Enter the units counted for at least one phone.";
    if (Object.keys(e).length) throw invalid("Check the stock count.", e);
    const open = (await tx.query("SELECT ref FROM altphones_stock_counts WHERE location_id = $1 AND status = 'SUBMITTED'", [loc!.id])).rows[0];
    if (open) throw conflict(`Count ${open.ref} for ${loc!.name} is still awaiting approval.`);
    const ref = await nextRef(tx, "altphones_stock_count_seq", "CNT", ctx.now);
    const row = (
      await tx.query<{ id: string; ref: string }>(
        "INSERT INTO altphones_stock_counts (ref, location_id, counted_on, note, submitted_by, submitted_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, ref",
        [ref, loc!.id, day, (p.note ?? "").trim().slice(0, 500) || null, actor.staffId, ctx.now],
      )
    ).rows[0];
    for (const l of lines) await tx.query("INSERT INTO altphones_stock_count_lines (count_id, model_id, counted, system_at_submit) VALUES ($1,$2,$3,$4)", [row.id, l.modelId, l.counted, l.system]);
    const variance = lines.reduce((a, l) => a + (l.counted - l.system), 0);
    await audit(tx, ctx, { action: "ALTPHONES_STOCK_COUNTED", details: { ref, location: loc!.name, lines: lines.map((l) => ({ model: l.name, counted: l.counted, system: l.system })), variance } });
    const admins = (await roleHolders(tx, ["SUPER_ADMIN"])).filter((a) => a.id !== actor.staffId);
    if (admins.length) {
      await enqueueEmail(tx, ctx.now, {
        kind: "ALTPHONES_STOCK_COUNTED",
        dedupeKey: `altphones:stock-count:${row.id}`,
        to: admins.map((a) => a.email),
        subject: `[${ref}] Altphones stock count awaiting approval — ${loc!.name}`,
        text: simpleEmail([`${actor.name} recorded a stock count at ${loc!.name} (${variance >= 0 ? "+" : ""}${variance} against the ledger).`, "", `Approve or reject it (sign-in required): ${config.appUrl}/altphones/inventory`]),
      });
    }
    return { ...row, variance };
  });
}

/** Approve (post the variance) or reject a stock count. The person who counted cannot decide it. */
export async function decideStockCount(ctx: Ctx, id: string, p: { decision: "APPROVE" | "REJECT"; comment: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can approve a stock count.");
    if (!isUuid(id)) throw notFound("Stock count not found.");
    const c = (await tx.query("SELECT c.*, to_char(c.counted_on, 'YYYY-MM-DD') AS counted_day, l.name AS location_name FROM altphones_stock_counts c JOIN locations l ON l.id = c.location_id WHERE c.id = $1 FOR UPDATE OF c", [id])).rows[0];
    if (!c) throw notFound("Stock count not found.");
    if (c.status !== "SUBMITTED") throw conflict("This stock count has already been decided.");
    if (c.submitted_by === actor.staffId) throw forbidden("Separation of duties: you cannot approve your own stock count.");
    if (p.decision === "REJECT" && (p.comment ?? "").trim().length < 3) throw invalid("Give the reason for rejecting.", { comment: "Enter a reason." });
    let posted = 0;
    if (p.decision === "APPROVE") {
      const lines = (await tx.query<{ model_id: string; counted: number; system_at_submit: number }>("SELECT model_id, counted, system_at_submit FROM altphones_stock_count_lines WHERE count_id = $1", [id])).rows;
      for (const l of lines) {
        const variance = l.counted - l.system_at_submit; // movements since the count are kept, not overwritten
        if (variance === 0) continue;
        await post(tx, ctx, { locationId: c.location_id, modelId: l.model_id, movement: "COUNT_ADJUSTMENT", physical: variance, reserved: 0, reference: c.ref, note: `Stock count of ${c.counted_day}${c.note ? ` — ${c.note}` : ""}` });
        posted += variance;
      }
    }
    await tx.query("UPDATE altphones_stock_counts SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5 WHERE id = $1", [id, p.decision === "APPROVE" ? "APPROVED" : "REJECTED", actor.staffId, ctx.now, (p.comment ?? "").trim() || null]);
    await audit(tx, ctx, { action: p.decision === "APPROVE" ? "ALTPHONES_STOCK_COUNT_APPROVED" : "ALTPHONES_STOCK_COUNT_REJECTED", details: { ref: c.ref, location: c.location_name, adjustment: posted, comment: p.comment?.trim() || null } });
    return { ref: c.ref, adjustment: posted };
  });
}

export interface StockCountRow {
  id: string;
  ref: string;
  location_id: string;
  location_name: string;
  status: string;
  counted_on: string;
  note: string | null;
  submitted_by: string;
  submitted_by_name: string;
  submitted_at: Date;
  decided_by_name: string | null;
  decision_note: string | null;
  lines: { model: string; counted: number; system: number }[];
}

export async function listStockCounts(q: Db, opts: { locationId?: string | null; limit?: number } = {}): Promise<StockCountRow[]> {
  return (
    await q.query<StockCountRow>(
      `SELECT c.id, c.ref, c.location_id, l.name AS location_name, c.status, to_char(c.counted_on, 'YYYY-MM-DD') AS counted_on, c.note,
              c.submitted_by, s.full_name AS submitted_by_name, c.submitted_at, d.full_name AS decided_by_name, c.decision_note,
              coalesce((SELECT json_agg(json_build_object('model', m.name, 'counted', x.counted, 'system', x.system_at_submit) ORDER BY m.name)
                          FROM altphones_stock_count_lines x JOIN altphones_models m ON m.id = x.model_id WHERE x.count_id = c.id), '[]') AS lines
         FROM altphones_stock_counts c JOIN locations l ON l.id = c.location_id JOIN staff s ON s.id = c.submitted_by LEFT JOIN staff d ON d.id = c.decided_by
        WHERE ($1::uuid IS NULL OR c.location_id = $1)
        ORDER BY (c.status = 'SUBMITTED') DESC, c.submitted_at DESC LIMIT $2`,
      [opts.locationId ?? null, opts.limit ?? 50],
    )
  ).rows;
}

export interface LocationStockRow {
  id: string;
  name: string;
  state: string;
  city: string;
  outlet_type: string;
  source_name: string | null;
  source_state: string | null;
  source_type: string | null;
  physical: number;
  reserved: number;
  available: number;
  last_count: string | null;
}

/** Every stock-holding location (zero-stock ones included) with its totals across all phones. */
export async function locationStock(q: Db, f: { state?: string; type?: string; stock?: string; q?: string } = {}): Promise<LocationStockRow[]> {
  return (
    await q.query<LocationStockRow>(
      `SELECT l.id, l.name, l.state, l.city, l.outlet_type, l.source_name, l.source_state, l.source_type,
              coalesce(sum(s.physical), 0)::int AS physical, coalesce(sum(s.reserved), 0)::int AS reserved,
              coalesce(sum(s.physical - s.reserved), 0)::int AS available,
              (SELECT to_char(max(c.counted_on), 'YYYY-MM-DD') FROM altphones_stock_counts c WHERE c.location_id = l.id AND c.status = 'APPROVED') AS last_count
         FROM locations l LEFT JOIN altphones_stock s ON s.location_id = l.id
        WHERE l.active AND l.outlet_type IN ('BRANCH','ALTSHOP')
          AND ($1 = '' OR l.state = $1) AND ($2 = '' OR l.outlet_type = $2)
          AND ($4 = '' OR lower(l.name) LIKE '%' || $4 || '%' OR lower(coalesce(l.source_name, '')) LIKE '%' || $4 || '%' OR lower(l.city) LIKE '%' || $4 || '%')
        GROUP BY l.id
       HAVING ($3 = '' OR ($3 = 'zero' AND coalesce(sum(s.physical), 0) = 0) OR ($3 = 'instock' AND coalesce(sum(s.physical), 0) > 0))
        ORDER BY l.state, l.name`,
      [f.state ?? "", f.type ?? "", f.stock ?? "", (f.q ?? "").trim().toLowerCase()],
    )
  ).rows;
}
