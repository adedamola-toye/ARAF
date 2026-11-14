/**
 * Altphones catalogue (Product Manager) and versioned settings (Product Manager for pricing, repayment
 * rules and contract wording; Super Admin for credit-policy score bands, the route Unit Head and the team mailbox).
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { DomainError, conflict, forbidden, invalid, notFound } from "../errors";
import { holdsRole } from "../domain/access";
import { objectStore } from "../storage";
import { sha256Hex } from "../crypto";
import { config } from "../config";
import { ALTPHONES_TENURES, isEmail, parseRateE4, type MarkupBasis, type ShortMonthRule, type WeekendRule } from "@/lib/altphones";
import { currentSettings, isUuid, PM_ROLE, type AltSettings } from "./core";
import { CONTRACT_PLACEHOLDER_KEYS, unknownPlaceholders } from "@/lib/altphones-contract";

export const MAX_ACTIVE_MODELS = 3;

export interface ModelRow {
  id: string;
  name: string;
  specifications: string;
  image_key: string | null;
  image_mime: string | null;
  image_sha256: string | null;
  active: boolean;
  sort_order: number;
  updated_at: Date;
}

export async function listModels(q: Db, opts: { activeOnly?: boolean } = {}): Promise<ModelRow[]> {
  // The colour-not-recorded stock pool is not a catalogue phone: it never appears here.
  return (await q.query<ModelRow>(`SELECT * FROM altphones_models WHERE NOT stock_pool ${opts.activeOnly ? "AND active" : ""} ORDER BY active DESC, sort_order, name`)).rows;
}

async function requirePm(q: Db, ctx: Ctx) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!(await holdsRole(q, actor.staffId, PM_ROLE))) throw forbidden("Only the Altphones Product Manager can change the catalogue.");
  return actor;
}

export async function saveModel(ctx: Ctx, p: { id?: string | null; name: string; specifications: string; active: boolean; sortOrder: string }) {
  return withTx(async (tx) => {
    const actor = await requirePm(tx, ctx);
    const e: Record<string, string> = {};
    const name = (p.name ?? "").trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 80) e.name = "Enter the phone model name (2–80 characters).";
    const specs = (p.specifications ?? "").trim();
    if (specs.length < 3) e.specifications = "Enter the approved specifications, one per line.";
    if (specs.length > 2000) e.specifications = "Keep the specifications under 2,000 characters.";
    const sort = Number(p.sortOrder || 0);
    if (!Number.isInteger(sort) || sort < 0 || sort > 99) e.sortOrder = "Use a whole number from 0 to 99.";
    if (Object.keys(e).length) throw invalid("Check the phone details.", e);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('altphones_models'))");
    if (p.active) {
      const n = Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM altphones_models WHERE active AND id IS DISTINCT FROM $1", [p.id || null])).rows[0].n);
      if (n >= MAX_ACTIVE_MODELS) throw invalid(`The catalogue shows ${MAX_ACTIVE_MODELS} approved phones. Deactivate one before adding another.`, { active: "Too many active phones." });
    }
    const clash = (await tx.query("SELECT 1 FROM altphones_models WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2", [name, p.id || null])).rowCount;
    if (clash) throw invalid("Another phone already has this name.", { name: "This name is already used." });
    let id = p.id || null;
    if (id) {
      if (!isUuid(id)) throw notFound("Phone not found.");
      if ((await tx.query("SELECT 1 FROM altphones_models WHERE id = $1 AND stock_pool", [id])).rowCount) throw invalid("The colour-not-recorded stock pool is not a catalogue phone and cannot be edited here.");
      const r = await tx.query("UPDATE altphones_models SET name = $2, specifications = $3, active = $4, sort_order = $5, updated_by = $6, updated_at = $7 WHERE id = $1", [id, name, specs, p.active, sort, actor.staffId, ctx.now]);
      if (!r.rowCount) throw notFound("Phone not found.");
    } else {
      id = (
        await tx.query<{ id: string }>("INSERT INTO altphones_models (name, specifications, active, sort_order, created_by, created_at, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$5,$6) RETURNING id", [
          name,
          specs,
          p.active,
          sort,
          actor.staffId,
          ctx.now,
        ])
      ).rows[0].id;
    }
    await audit(tx, ctx, { action: p.id ? "ALTPHONES_MODEL_UPDATED" : "ALTPHONES_MODEL_CREATED", details: { id, name, active: p.active } });
    return { id };
  });
}

/** PNG, JPEG or WebP by content, not by name. */
export function sniffImage(data: Buffer): string | null {
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length > 12 && data.subarray(0, 4).toString("binary") === "RIFF" && data.subarray(8, 12).toString("binary") === "WEBP") return "image/webp";
  return null;
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function setModelImage(ctx: Ctx, modelId: string, data: Buffer) {
  await requirePm(db, ctx);
  if (!isUuid(modelId)) throw notFound("Phone not found.");
  if (!data.length) throw invalid("Choose an image.");
  if (data.length > MAX_IMAGE_BYTES) throw invalid("The image must be 5 MB or smaller.");
  const mime = sniffImage(data);
  if (!mime) throw invalid("Upload the product photo as PNG, JPEG or WebP.");
  const key = `altphones/models/${modelId}/${randomUUID()}`;
  try {
    await objectStore().put(key, data, mime);
  } catch (e) {
    console.error("[altphones] image storage write failed", e);
    throw new DomainError("CONFIG", "Image storage is not available. An administrator must check the object storage configuration.");
  }
  await withTx(async (tx) => {
    const m = (await tx.query("SELECT image_key FROM altphones_models WHERE id = $1 FOR UPDATE", [modelId])).rows[0];
    if (!m) throw notFound("Phone not found.");
    await tx.query("UPDATE altphones_models SET image_key = $2, image_mime = $3, image_sha256 = $4, updated_by = $5, updated_at = $6 WHERE id = $1", [modelId, key, mime, sha256Hex(data), ctx.actor!.staffId, ctx.now]);
    await audit(tx, ctx, { action: "ALTPHONES_MODEL_IMAGE_SET", details: { id: modelId, bytes: data.length, mime } });
  });
  return { ok: true };
}

/** A photo uploaded by the PM (private storage) or one shipped with the application ("static:<path under /images>"). */
export async function readModelImage(modelId: string): Promise<{ data: Buffer; mime: string; etag: string } | { staticPath: string } | null> {
  if (!isUuid(modelId)) return null;
  const m = (await db.query<ModelRow>("SELECT image_key, image_mime, image_sha256 FROM altphones_models WHERE id = $1", [modelId])).rows[0];
  if (!m?.image_key) return null;
  if (m.image_key.startsWith("static:")) {
    const rel = m.image_key.slice(7);
    return /^[a-z0-9/_.-]+$/i.test(rel) && !rel.includes("..") ? { staticPath: `/images/${rel}` } : null;
  }
  return { data: await objectStore().get(m.image_key), mime: m.image_mime ?? "application/octet-stream", etag: m.image_sha256 ?? "" };
}

// ------------------------------------------------------------------ settings

export interface PricingInput {
  rates: Record<string, string>;
  basis: string;
  weekendRule: string;
  shortMonthRule: string;
  /** Omit to keep the current wording (the contract has its own editor). */
  contractTemplate?: string;
  reason: string;
}

/** Placeholders the contract wording can use (filled from the application at generation). */
export const CONTRACT_PLACEHOLDERS = CONTRACT_PLACEHOLDER_KEYS;

async function insertVersion(q: Db, ctx: Ctx, base: AltSettings, patch: Partial<AltSettings>, reason: string) {
  const s = { ...base, ...patch };
  const row = (
    await q.query<{ id: string; version: number }>(
      `INSERT INTO altphones_settings (version, outright_price_kobo, down_payment_kobo, tenures, markup_rates, markup_basis, score_pass_min, score_fair_min,
          weekend_rule, short_month_rule, contract_template, unit_head_staff_id, team_email, reason, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id, version`,
      [
        base.version + 1,
        s.outright_price_kobo,
        s.down_payment_kobo,
        s.tenures,
        JSON.stringify(s.markup_rates ?? {}),
        s.markup_basis,
        s.score_pass_min,
        s.score_fair_min,
        s.weekend_rule,
        s.short_month_rule,
        s.contract_template,
        s.unit_head_staff_id,
        s.team_email,
        reason,
        ctx.actor?.staffId ?? null,
        ctx.now,
      ],
    )
  ).rows[0];
  await audit(q, ctx, { action: "ALTPHONES_SETTINGS_VERSION", reason, details: { version: row.version, changed: Object.keys(patch) } });
  return row;
}

export async function savePricing(ctx: Ctx, p: PricingInput) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, PM_ROLE))) throw forbidden("Only the Altphones Product Manager can change pricing.");
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('altphones_settings'))");
    const base = await currentSettings(tx);
    const e: Record<string, string> = {};
    const rates: Record<string, number> = {};
    for (const t of ALTPHONES_TENURES) {
      const raw = (p.rates[String(t)] ?? "").trim();
      if (!raw) continue;
      const v = parseRateE4(raw);
      if (v === null) e[`rate${t}`] = "Enter a percentage with up to 4 decimal places.";
      else rates[String(t)] = v;
    }
    const basis = p.basis || null;
    if (basis && !["FLAT_TOTAL", "FLAT_PER_MONTH"].includes(basis)) e.basis = "Choose how the rate applies.";
    if (Object.keys(rates).length && !basis) e.basis = "Choose how the rate applies.";
    const wr = p.weekendRule || null;
    if (wr && !["NEXT_BUSINESS_DAY", "PREVIOUS_BUSINESS_DAY", "NO_ADJUSTMENT"].includes(wr)) e.weekendRule = "Choose a rule.";
    const sr = p.shortMonthRule || null;
    if (sr && !["LAST_DAY_OF_MONTH", "FIRST_DAY_OF_NEXT_MONTH"].includes(sr)) e.shortMonthRule = "Choose a rule.";
    const tpl = p.contractTemplate === undefined ? base.contract_template : p.contractTemplate.trim() || null;
    const tplError = tpl ? contractProblem(tpl) : null;
    if (tplError) e.contractTemplate = tplError;
    if ((p.reason ?? "").trim().length < 3) e.reason = "Record the approval this change is based on.";
    if (Object.keys(e).length) throw invalid("Check the pricing settings.", e);
    return insertVersion(tx, ctx, base, { markup_rates: rates, markup_basis: basis as MarkupBasis | null, weekend_rule: wr as WeekendRule | null, short_month_rule: sr as ShortMonthRule | null, contract_template: tpl }, p.reason.trim());
  });
}

export async function savePolicy(ctx: Ctx, p: { passMin: string; fairMin: string; unitHeadId: string; teamEmail: string; reason: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can change credit-policy and routing settings.");
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('altphones_settings'))");
    const base = await currentSettings(tx);
    const e: Record<string, string> = {};
    const num = (s: string) => (s.trim() === "" ? null : /^-?\d{1,8}(\.\d{1,2})?$/.test(s.trim()) ? s.trim() : NaN);
    const pass = num(p.passMin ?? "");
    const fair = num(p.fairMin ?? "");
    if (Number.isNaN(pass)) e.passMin = "Enter a number (up to 2 decimals).";
    if (Number.isNaN(fair)) e.fairMin = "Enter a number (up to 2 decimals).";
    if ((pass === null) !== (fair === null)) e.passMin = "Set both thresholds, or neither.";
    if (typeof pass === "string" && typeof fair === "string" && Number(pass) <= Number(fair)) e.passMin = "The Pass threshold must be higher than the Fair threshold.";
    const uh = (p.unitHeadId ?? "").trim() || null;
    if (uh) {
      const ok = isUuid(uh) && (await tx.query("SELECT 1 FROM staff s WHERE s.id = $1 AND s.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM role_assignments ra WHERE ra.staff_id = s.id AND ra.role = 'UNIT_HEAD' AND ra.active)", [uh])).rowCount;
      if (!ok) e.unitHeadId = "Choose an active holder of the Unit Head role.";
    }
    const team = (p.teamEmail ?? "").trim().toLowerCase();
    if (!isEmail(team)) e.teamEmail = "Enter the Altphones team mailbox.";
    if ((p.reason ?? "").trim().length < 3) e.reason = "Record the approved policy this change is based on.";
    if (Object.keys(e).length) throw invalid("Check the settings.", e);
    return insertVersion(tx, ctx, base, { score_pass_min: pass as string | null, score_fair_min: fair as string | null, unit_head_staff_id: uh, team_email: team }, p.reason.trim());
  });
}

export async function listHolidays(q: Db, fromDate?: string) {
  return (await q.query<{ holiday_date: string; name: string }>("SELECT to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date, name FROM altphones_holidays WHERE ($1::date IS NULL OR holiday_date >= $1) ORDER BY holiday_date", [fromDate ?? null])).rows;
}

export async function saveHoliday(ctx: Ctx, p: { date: string; name: string; remove?: boolean }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, PM_ROLE)) && !(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date ?? "")) throw invalid("Choose the date.", { date: "Choose the date." });
    if (p.remove) {
      await tx.query("DELETE FROM altphones_holidays WHERE holiday_date = $1", [p.date]);
    } else {
      if ((p.name ?? "").trim().length < 2) throw invalid("Name the public holiday.", { name: "Enter the holiday name." });
      const r = await tx.query("INSERT INTO altphones_holidays (holiday_date, name, created_by, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [p.date, p.name.trim(), actor.staffId, ctx.now]);
      if (!r.rowCount) throw conflict("This date is already listed.");
    }
    await audit(tx, ctx, { action: p.remove ? "ALTPHONES_HOLIDAY_REMOVED" : "ALTPHONES_HOLIDAY_ADDED", details: { date: p.date, name: p.name } });
    return { ok: true };
  });
}

export function integrationStatus() {
  const s = config.seedfi;
  const p = config.paystack;
  return {
    seedfi: s.enabled && s.baseUrl && s.apiKey ? "CONFIGURED" : "NOT_CONFIGURED",
    paystack: p.enabled && p.secretKey ? "CONFIGURED" : "NOT_CONFIGURED",
    directDebit: p.enabled && p.secretKey && p.directDebitEnabled ? "CONFIGURED" : "NOT_CONFIGURED",
  } as const;
}

function contractProblem(tpl: string): string | null {
  if (tpl.length > 50_000) return "The contract wording is too long.";
  const unknown = unknownPlaceholders(tpl);
  if (unknown.length) return `Unknown placeholders: ${unknown.map((u) => `{{${u}}}`).join(", ")}. Use only the listed placeholders.`;
  return null;
}

/**
 * Contract wording: editable by a Super Admin or the Altphones Product Manager. Saved as a new settings
 * version; applications that already accepted keep the exact text they accepted.
 */
export async function saveContract(ctx: Ctx, p: { template: string; reason: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN")) && !(await holdsRole(tx, actor.staffId, PM_ROLE))) throw forbidden("Only a Super Admin or the Altphones Product Manager can change the contract wording.");
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('altphones_settings'))");
    const base = await currentSettings(tx);
    const tpl = (p.template ?? "").replace(/\r\n/g, "\n").trim();
    const e: Record<string, string> = {};
    if (tpl.length < 200) e.template = "Enter the full contract wording.";
    else {
      const problem = contractProblem(tpl);
      if (problem) e.template = problem;
      else if (/\[DRAFT FOR LEGAL AND SHARIAH REVIEW/.test(tpl)) e.template = "Remove the draft notice once Legal and Shariah have approved the wording.";
    }
    if ((p.reason ?? "").trim().length < 3) e.reason = "Record the approval reference for this wording.";
    if (Object.keys(e).length) throw invalid("Check the contract wording.", e);
    if (tpl === (base.contract_template ?? "")) throw invalid("No change to save.", { template: "The wording is unchanged." });
    return insertVersion(tx, ctx, base, { contract_template: tpl }, `Contract wording: ${p.reason.trim()}`);
  });
}
