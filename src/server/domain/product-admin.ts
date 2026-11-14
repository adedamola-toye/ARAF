/**
 * Super Admin product administration on top of the versioned, maker-checker product configuration:
 * - the contract type catalogue (Murabaha, Ijarah, … and new ones), never deleted;
 * - new retail products (closed to applications until a configuration is approved and the product opened);
 * - focused changes to mark-up per contract type and to tenor, each submitted as a configuration proposal
 *   that a different Product Configuration Approver must approve. Nothing takes effect on proposal.
 */
import type { Db } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { holdsRole } from "./access";
import {
  CONTRACT_CODE_RE,
  CUSTOMER_PROFILES,
  RATE_CONVENTIONS,
  configById,
  effectiveConfig,
  productConfigSchema,
  proposeProductConfig,
  type CustomerProfile,
  type ProductConfig,
  type RateConvention,
} from "./products";

export interface ContractTypeRow {
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  created_at: Date;
  created_by_name: string | null;
  updated_at: Date;
  updated_by_name: string | null;
}

export async function listContractTypes(q: Db, opts: { activeOnly?: boolean } = {}): Promise<ContractTypeRow[]> {
  return (
    await q.query<ContractTypeRow>(
      `SELECT c.*, cb.full_name AS created_by_name, ub.full_name AS updated_by_name FROM contract_types c
         LEFT JOIN staff cb ON cb.id = c.created_by LEFT JOIN staff ub ON ub.id = c.updated_by
        WHERE ($1::boolean IS NOT TRUE OR c.active) ORDER BY c.active DESC, c.name`,
      [opts.activeOnly ?? false],
    )
  ).rows;
}

async function requireSuperAdmin(q: Db, ctx: Ctx) {
  const actor = ctx.actor;
  if (!actor || !(await holdsRole(q, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can manage products and contract types.");
  return actor;
}

/** Create a contract type (no code given → derived from the name) or update its name, description or status. */
export async function saveContractType(ctx: Ctx, p: { code?: string | null; name: string; description?: string | null; active?: boolean; isNew: boolean }) {
  return withTx(async (tx) => {
    const actor = await requireSuperAdmin(tx, ctx);
    const name = (p.name ?? "").trim();
    const code = (p.code || name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")).slice(0, 31);
    const e: Record<string, string> = {};
    if (name.length < 2 || name.length > 60) e.name = "Enter a name of 2 to 60 characters.";
    if (!CONTRACT_CODE_RE.test(code)) e.code = "The code must start with a letter and use capitals, digits and underscores.";
    if (Object.keys(e).length) throw invalid("Check the contract type.", e);
    const description = (p.description ?? "").trim() || null;
    if (p.isNew) {
      const dup = await tx.query("SELECT 1 FROM contract_types WHERE code = $1 OR lower(name) = lower($2)", [code, name]);
      if (dup.rowCount) throw conflict("A contract type with this name or code already exists.");
      await tx.query("INSERT INTO contract_types (code, name, description, active, created_by, created_at, updated_by, updated_at) VALUES ($1,$2,$3,true,$4,$5,$4,$5)", [code, name, description, actor.staffId, ctx.now]);
      await audit(tx, ctx, { action: "CONTRACT_TYPE_CREATED", actorRole: "SUPER_ADMIN", details: { code, name, description } });
      return { code };
    }
    const before = (await tx.query<ContractTypeRow>("SELECT * FROM contract_types WHERE code = $1 FOR UPDATE", [code])).rows[0];
    if (!before) throw notFound("Contract type not found.");
    const dup = await tx.query("SELECT 1 FROM contract_types WHERE lower(name) = lower($1) AND code <> $2", [name, code]);
    if (dup.rowCount) throw conflict("Another contract type already has this name.");
    const active = p.active ?? before.active;
    await tx.query("UPDATE contract_types SET name = $2, description = $3, active = $4, updated_by = $5, updated_at = $6 WHERE code = $1", [code, name, description, active, actor.staffId, ctx.now]);
    await audit(tx, ctx, { action: "CONTRACT_TYPE_UPDATED", actorRole: "SUPER_ADMIN", details: { code, before: { name: before.name, description: before.description, active: before.active }, after: { name, description, active } } });
    return { code };
  });
}

/**
 * Create a retail product. It starts closed to applications with a proposed first configuration copied
 * from an existing product (mark-ups, tenor, documents, approval chain), which a Product Configuration
 * Approver must approve before the Super Admin opens the product.
 */
export async function createProduct(ctx: Ctx, p: { code?: string | null; name: string; description?: string | null; copyFrom: string; reason: string }) {
  return withTx(async (tx) => {
    const actor = await requireSuperAdmin(tx, ctx);
    const name = (p.name ?? "").trim();
    const code = (p.code || name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")).slice(0, 40);
    const e: Record<string, string> = {};
    if (name.length < 2 || name.length > 80) e.name = "Enter a product name of 2 to 80 characters.";
    if (!/^[A-Z][A-Z0-9_]{1,40}$/.test(code)) e.code = "The code must start with a letter and use capitals, digits and underscores.";
    if ((p.reason ?? "").trim().length < 3) e.reason = "Give the reason or policy reference for the new product.";
    const src = (await tx.query<{ code: string; workflow: string }>("SELECT code, workflow FROM products WHERE code = $1", [p.copyFrom])).rows[0];
    if (!src || src.workflow !== "RETAIL") e.copyFrom = "Choose the retail product to start from.";
    if (Object.keys(e).length) throw invalid("Check the new product.", e);
    if ((await tx.query("SELECT 1 FROM products WHERE code = $1 OR lower(name) = lower($2)", [code, name])).rowCount) throw conflict("A product with this name or code already exists.");
    const base =
      (await effectiveConfig(tx, p.copyFrom, ctx.now)) ??
      (await tx.query<{ id: string }>("SELECT id FROM product_configs WHERE product_code = $1 ORDER BY version DESC LIMIT 1", [p.copyFrom]).then((r) => (r.rows[0] ? configById(tx, r.rows[0].id) : null)));
    if (!base) throw invalid("The product to start from has no configuration.", { copyFrom: "No configuration to copy." });
    const config = productConfigSchema.parse(base.config);
    const sort = (await tx.query<{ n: number }>("SELECT coalesce(max(sort_order),0) + 10 AS n FROM products")).rows[0].n;
    await tx.query("INSERT INTO products (code, name, description, workflow, active, sort_order, updated_by, updated_at) VALUES ($1,$2,$3,'RETAIL',false,$4,$5,$6)", [code, name, (p.description ?? "").trim() || null, sort, actor.staffId, ctx.now]);
    const cfg = await tx.query<{ id: string }>(
      `INSERT INTO product_configs (product_code, version, status, config, effective_from, reason, proposed_by, proposed_at) VALUES ($1,1,'PROPOSED',$2,$3,$4,$5,$3) RETURNING id`,
      [code, JSON.stringify(config), ctx.now, `New product (starting from ${p.copyFrom}): ${p.reason.trim()}`, actor.staffId],
    );
    await audit(tx, ctx, { action: "PRODUCT_CREATED", actorRole: "SUPER_ADMIN", reason: p.reason.trim(), details: { productCode: code, name, copyFrom: p.copyFrom, configId: cfg.rows[0].id } });
    return { code, configId: cfg.rows[0].id };
  });
}

async function baseConfig(q: Db, productCode: string, now: Date): Promise<ProductConfig> {
  const open = await q.query("SELECT 1 FROM product_configs WHERE product_code = $1 AND status = 'PROPOSED'", [productCode]);
  if (open.rowCount) throw conflict("A proposed change is already awaiting approval for this product. It must be approved, rejected or withdrawn first.");
  const cfg = await effectiveConfig(q, productCode, now);
  if (!cfg) throw conflict("This product has no approved configuration yet; approve its first configuration before changing it.");
  return structuredClone(cfg.config);
}
const targetProfiles = (cfg: ProductConfig, profile: CustomerProfile | "ALL") => (profile === "ALL" ? CUSTOMER_PROFILES.filter((p) => cfg.profiles[p]) : [profile]).filter((p) => cfg.profiles[p]);

export interface MarkupChange {
  productCode: string;
  profile: CustomerProfile | "ALL";
  contractType: string;
  /** "remove" takes the contract type off the product for the chosen profile(s). */
  action: "SET" | "REMOVE";
  markupPercent?: string | null;
  rateConvention?: RateConvention | null;
  effectiveFrom: Date;
  reason: string;
}

/** Propose a mark-up for a contract type on a product (adding the contract type if the product does not offer it yet). */
export async function proposeMarkup(ctx: Ctx, c: MarkupChange) {
  const cfg = await withTx(async (tx) => {
    await requireSuperAdmin(tx, ctx);
    const config = await baseConfig(tx, c.productCode, ctx.now);
    const ct = (await tx.query<{ code: string; name: string; active: boolean }>("SELECT code, name, active FROM contract_types WHERE code = $1", [c.contractType])).rows[0];
    if (!ct) throw invalid("Choose a contract type.", { contractType: "Choose a contract type." });
    const profiles = targetProfiles(config, c.profile);
    if (!profiles.length) throw invalid("The product does not serve that customer profile.", { profile: "Not offered for this product." });
    if (c.action === "SET") {
      if (!ct.active) throw invalid("This contract type is inactive.", { contractType: "Inactive contract type." });
      const m = (c.markupPercent ?? "").trim();
      if (!/^\d{1,3}(\.\d{1,4})?$/.test(m) || Number(m) <= 0 || Number(m) > 100) throw invalid("Enter the mark-up as a percentage above 0 and up to 100, with up to 4 decimal places.", { markupPercent: "Enter a percentage, e.g. 34 or 39.5." });
      if (c.rateConvention && !(RATE_CONVENTIONS as readonly string[]).includes(c.rateConvention)) throw invalid("Choose how the mark-up relates to the tenor.", { rateConvention: "Invalid." });
      for (const p of profiles) {
        const r = config.profiles[p]!;
        const existing = r.structures.find((s) => s.code === ct.code);
        if (existing) {
          existing.ratePercent = m;
          existing.label = ct.name;
          if (c.rateConvention) existing.rateConvention = c.rateConvention;
        } else r.structures.push({ code: ct.code, label: ct.name, ratePercent: m, rateConvention: c.rateConvention ?? null, insuranceBearer: null, contractSequence: null });
      }
    } else {
      for (const p of profiles) {
        const r = config.profiles[p]!;
        if (!r.structures.some((s) => s.code === ct.code)) throw invalid(`The product does not offer ${ct.name} for that profile.`, { contractType: "Not offered." });
        r.structures = r.structures.filter((s) => s.code !== ct.code);
      }
    }
    return config;
  });
  return proposeProductConfig(ctx, { productCode: c.productCode, config: cfg, effectiveFrom: c.effectiveFrom, reason: c.reason });
}

/** Propose a new minimum / maximum repayment period for a product (all profiles or one). */
export async function proposeTenor(ctx: Ctx, c: { productCode: string; profile: CustomerProfile | "ALL"; minMonths: number | null; maxMonths: number; effectiveFrom: Date; reason: string }) {
  const cfg = await withTx(async (tx) => {
    await requireSuperAdmin(tx, ctx);
    const config = await baseConfig(tx, c.productCode, ctx.now);
    const e: Record<string, string> = {};
    if (!Number.isInteger(c.maxMonths) || c.maxMonths < 1 || c.maxMonths > 360) e.maxMonths = "Enter the maximum in whole months (1 to 360).";
    if (c.minMonths !== null && (!Number.isInteger(c.minMonths) || c.minMonths < 1 || c.minMonths > 360)) e.minMonths = "Enter the minimum in whole months, or leave it empty for no minimum.";
    if (!e.maxMonths && !e.minMonths && c.minMonths !== null && c.minMonths > c.maxMonths) e.minMonths = "The minimum cannot be above the maximum.";
    if (Object.keys(e).length) throw invalid("Check the tenor.", e);
    const profiles = targetProfiles(config, c.profile);
    if (!profiles.length) throw invalid("The product does not serve that customer profile.", { profile: "Not offered for this product." });
    for (const p of profiles) {
      config.profiles[p]!.minTenorMonths = c.minMonths;
      config.profiles[p]!.maxTenorMonths = c.maxMonths;
    }
    return config;
  });
  return proposeProductConfig(ctx, { productCode: c.productCode, config: cfg, effectiveFrom: c.effectiveFrom, reason: c.reason });
}
