/**
 * The four products a Relationship Manager can originate, in display order. Each opens its existing journey:
 * WakeelBoost uses its own (WakeelBoost) workflow; the others are retail products driven by their approved
 * product configuration. Altphones is sold only from the Delight Officer / Smile Associate workspace.
 */
export interface OriginationProduct {
  slug: string;
  code: string;
  name: string;
  description: string;
  kind: "WAKEELBOOST" | "RETAIL";
}

export const ORIGINATION_PRODUCTS: readonly OriginationProduct[] = [
  {
    slug: "wakeelboost",
    code: "WAKEELBOOST",
    name: "WakeelBoost",
    description: "Merchant stock financing.",
    kind: "WAKEELBOOST",
  },
  {
    slug: "vendor-financing",
    code: "VENDOR_FINANCING",
    name: "Vendor Financing",
    description: "Business vendor financing.",
    kind: "RETAIL",
  },
  {
    slug: "alt-drive",
    code: "ALT_DRIVE",
    name: "AltDrive",
    description: "Vehicle financing.",
    kind: "RETAIL",
  },
  {
    slug: "alt-power",
    code: "ALT_POWER",
    name: "AltPower",
    description: "Energy and power financing.",
    kind: "RETAIL",
  },
];

export const originationProduct = (slug: string) =>
  ORIGINATION_PRODUCTS.find((p) => p.slug === slug) ?? null;
