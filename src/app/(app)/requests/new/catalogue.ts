import type { Db } from "@/server/db";
import { BLOCKED_ACTION_LABELS, configGaps, effectiveConfig, getProduct, PROFILE_LABELS, RATE_CONVENTION_LABELS, INSURANCE_LABELS, structureLabel, type CustomerProfile } from "@/server/domain/products";
import { LEGACY_INITIATOR_ROLES, RETAIL_INITIATOR_ROLES, type Role } from "@/server/domain/roles";
import { formatKobo } from "@/server/money";
import { ORIGINATION_PRODUCTS, type OriginationProduct } from "@/lib/origination-products";
import type { CatalogueProduct } from "./NewRetailForm";

export type Availability = { status: "OPEN" } | { status: "NOT_PERMITTED" } | { status: "UNAVAILABLE"; reason: string };

/** Roles the user holds that may initiate this product (provisioned roles only; the workspace grants nothing). */
export function initiatorRolesFor(p: OriginationProduct, roles: readonly string[]): Role[] {
  const allowed: readonly string[] = p.kind === "WAKEELBOOST" ? LEGACY_INITIATOR_ROLES : RETAIL_INITIATOR_ROLES;
  return allowed.filter((r) => roles.includes(r)) as Role[];
}

/** Whether a product can be opened now. Missing configuration is reported as a gap, never filled in. */
export async function availability(q: Db, p: OriginationProduct, roles: readonly string[], now: Date): Promise<Availability> {
  if (!initiatorRolesFor(p, roles).length) return { status: "NOT_PERMITTED" };
  const row = await getProduct(q, p.code);
  if (!row) return { status: "UNAVAILABLE", reason: "This product is not set up in ARAF." };
  if (!row.active) return { status: "UNAVAILABLE", reason: "This product is not open for new applications." };
  if (p.kind === "RETAIL" && !(await effectiveConfig(q, p.code, now))) return { status: "UNAVAILABLE", reason: "Awaiting product configuration: the product rules have not been approved yet." };
  return { status: "OPEN" };
}

export function visibleProducts(roles: readonly string[]) {
  return ORIGINATION_PRODUCTS.filter((p) => initiatorRolesFor(p, roles).length > 0);
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
