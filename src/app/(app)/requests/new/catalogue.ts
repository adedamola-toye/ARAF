import type { Db } from "@/server/db";
import { BLOCKED_ACTION_LABELS, configGaps, effectiveConfig, getProduct, INITIAL_PRODUCT_CONFIGS, PROFILE_LABELS, RATE_CONVENTION_LABELS, INSURANCE_LABELS, structureLabel, type CustomerProfile } from "@/server/domain/products";
import { LEGACY_INITIATOR_ROLES, RETAIL_INITIATOR_ROLES, type Role } from "@/server/domain/roles";
import { formatKobo } from "@/server/money";
import { ORIGINATION_PRODUCTS, type OriginationProduct } from "@/lib/origination-products";
import type { CatalogueProduct } from "./NewRetailForm";
import { BUSINESS_ONLY_PRODUCTS, type CustomerCategory } from "@/lib/customer-types";

export type Availability = { status: "OPEN" } | { status: "NOT_PERMITTED" } | { status: "UNAVAILABLE"; reason: string };

/** Roles each product's settings allow to originate it (null = every role the product type allows). */
export async function originationSettings(q: Db): Promise<Record<string, string[] | null>> {
  const r = await q.query<{ code: string; origination_roles: string[] | null }>("SELECT code, origination_roles FROM products");
  return Object.fromEntries(r.rows.map((x) => [x.code, x.origination_roles]));
}

/**
 * Roles the user holds that may initiate this product: provisioned roles only (the workspace grants nothing),
 * within what the product type allows, narrowed by the product's settings.
 */
export function initiatorRolesFor(p: OriginationProduct, roles: readonly string[], configured?: string[] | null): Role[] {
  const allowed: readonly string[] = p.kind === "WAKEELBOOST" ? LEGACY_INITIATOR_ROLES : RETAIL_INITIATOR_ROLES;
  return allowed.filter((r) => roles.includes(r) && (!configured || configured.includes(r))) as Role[];
}

/** Whether a product can be opened now. Missing configuration is reported as a gap, never filled in. */
export async function availability(q: Db, p: OriginationProduct, roles: readonly string[], now: Date): Promise<Availability> {
  const row = await getProduct(q, p.code);
  if (!initiatorRolesFor(p, roles, row?.origination_roles).length) return { status: "NOT_PERMITTED" };
  if (!row) return { status: "UNAVAILABLE", reason: "This product is not set up in ARAF." };
  if (!row.active) return { status: "UNAVAILABLE", reason: "This product is not open for new applications." };
  if (p.kind === "RETAIL" && !(await effectiveConfig(q, p.code, now))) {
    const next = (await q.query<{ d: Date }>("SELECT min(effective_from) AS d FROM product_configs WHERE product_code = $1 AND status = 'APPROVED' AND effective_from > $2", [p.code, now])).rows[0]?.d;
    return { status: "UNAVAILABLE", reason: next ? `Available from ${new Date(next).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "long", year: "numeric" })}.` : "Awaiting product configuration: the product rules have not been published yet." };
  }
  return { status: "OPEN" };
}

export function visibleProducts(roles: readonly string[], settings: Record<string, string[] | null> = {}) {
  return ORIGINATION_PRODUCTS.filter((p) => initiatorRolesFor(p, roles, settings[p.code]).length > 0);
}

/** Catalogue entry (profiles, limits and structures) for one retail product, from its approved configuration. */
export async function retailCatalogue(q: Db, code: string, now: Date): Promise<CatalogueProduct | null> {
  const p = await getProduct(q, code);
  const cfg = p ? await effectiveConfig(q, code, now) : null;
  if (!p || !cfg) return null;
  const profiles = (Object.entries(cfg.config.profiles) as [CustomerProfile, NonNullable<(typeof cfg.config.profiles)[CustomerProfile]>][])
    .filter(([, r]) => r?.enabled)
    .map(([c, r]) => {
      const gaps = configGaps(cfg.config, { profile: c });
      return {
        code: c,
        label: PROFILE_LABELS[c],
        eligibleTypes: r.eligibleApplicantTypes,
        note: r.eligibilityNote,
        limits: [r.maxAmountKobo !== null ? `Up to ${formatKobo(r.maxAmountKobo)}` : "Maximum amount not configured", r.maxTenorMonths !== null ? `up to ${r.maxTenorMonths} months` : "maximum tenor not configured", r.dsr.maxPercent ? `DSR ≤ ${r.dsr.maxPercent}%` : "DSR threshold not configured"].join(" · "),
        structures: r.structures.map((s) => ({
          code: s.code,
          label: structureLabel(s.code, s.label),
          rate: s.ratePercent ? `${s.ratePercent}%` : "rate not configured",
          convention: s.rateConvention ? RATE_CONVENTION_LABELS[s.rateConvention] : "rate convention not configured",
          insurance: s.insuranceBearer ? INSURANCE_LABELS[s.insuranceBearer] : "insurance treatment not configured",
        })),
        blocked: gaps.filter((g) => g.blocks === "SUBMISSION").map((g) => g.label),
        laterBlocks: [...new Set(gaps.filter((g) => g.blocks !== "SUBMISSION").map((g) => BLOCKED_ACTION_LABELS[g.blocks]))],
      };
    });
  return { code: p.code, name: p.name, description: p.description ?? "", configVersion: cfg.version, profiles };
}

/**
 * Customer categories a product serves: the profiles offered by its published rules (Product Settings). WakeelBoost
 * is business-only. A product without published rules is listed under the categories its supplied rules offer, so
 * the card can explain that it is awaiting configuration.
 */
export async function categoriesOffered(q: Db, p: OriginationProduct, now: Date): Promise<CustomerCategory[]> {
  if (BUSINESS_ONLY_PRODUCTS.includes(p.code)) return ["BUSINESS_OWNER"];
  const cfg = await effectiveConfig(q, p.code, now);
  const profiles = cfg?.config.profiles ?? INITIAL_PRODUCT_CONFIGS[p.code]?.profiles ?? {};
  const out = (Object.entries(profiles) as [CustomerCategory, { enabled?: boolean } | undefined][]).filter(([, r]) => r?.enabled).map(([c]) => c);
  return out.length || cfg ? out : ["BUSINESS_OWNER"];
}

/** The customer-type step applies to retail originators (Relationship Managers, Team Leads, Unit Heads). */
export const usesCustomerStep = (products: readonly OriginationProduct[]) => products.some((p) => p.kind === "RETAIL");
