export const ROLES = [
  "RM",
  "ANM",
  "MERCHANT_OFFICER",
  "RBE",
  "MERCHANT_OFFICER_LEAD",
  "ANM_LEAD_NORTH",
  "ANM_LEAD_SOUTH",
  "CREDIT_OFFICER_1",
  "CREDIT_OFFICER_2",
  "CREDIT_OFFICER_3",
  "CREDIT_LEAD_1",
  "CREDIT_LEAD_2",
  "UNIT_HEAD",
  "DIVISIONAL_HEAD",
  "DISBURSEMENT_OFFICER_1",
  "DISBURSEMENT_OFFICER_2",
  "SUPER_ADMIN",
  "REPORTING_ADMIN",
  "LEGAL_REVIEWER",
  "SHARIAH_REVIEWER",
] as const;
export type Role = (typeof ROLES)[number];

export const INITIATOR_ROLES = ["RM", "ANM", "MERCHANT_OFFICER"] as const;
export type InitiatorRole = (typeof INITIATOR_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  RM: "Relationship Manager",
  ANM: "Agent Network Manager",
  MERCHANT_OFFICER: "Merchant Officer",
  RBE: "Regional Business Executive",
  MERCHANT_OFFICER_LEAD: "Merchant Officer Lead",
  ANM_LEAD_NORTH: "North ANM Lead",
  ANM_LEAD_SOUTH: "South ANM Lead",
  CREDIT_OFFICER_1: "Credit Officer 1",
  CREDIT_OFFICER_2: "Credit Officer 2",
  CREDIT_OFFICER_3: "Credit Officer 3",
  CREDIT_LEAD_1: "Credit Lead 1",
  CREDIT_LEAD_2: "Credit Lead 2",
  UNIT_HEAD: "Unit Head",
  DIVISIONAL_HEAD: "Divisional Head",
  DISBURSEMENT_OFFICER_1: "Disbursement Officer 1",
  DISBURSEMENT_OFFICER_2: "Disbursement Officer 2",
  SUPER_ADMIN: "Super Admin",
  REPORTING_ADMIN: "Reporting Admin",
  LEGAL_REVIEWER: "Legal (closure recipient)",
  SHARIAH_REVIEWER: "Shariah Compliance (closure recipient)",
};

/** Positions that may be held by at most one active person at a time. */
export const SINGLE_HOLDER_ROLES: readonly Role[] = ["CREDIT_LEAD_1", "CREDIT_LEAD_2", "ANM_LEAD_NORTH", "ANM_LEAD_SOUTH"];

/** Nigeria's 36 states plus the Federal Capital Territory. */
export const REGIONS = [
  "ABIA",
  "ADAMAWA",
  "AKWA IBOM",
  "ANAMBRA",
  "BAUCHI",
  "BAYELSA",
  "BENUE",
  "BORNO",
  "CROSS RIVER",
  "DELTA",
  "EBONYI",
  "EDO",
  "EKITI",
  "ENUGU",
  "FCT (ABUJA)",
  "GOMBE",
  "IMO",
  "JIGAWA",
  "KADUNA",
  "KANO",
  "KATSINA",
  "KEBBI",
  "KOGI",
  "KWARA",
  "LAGOS",
  "NASARAWA",
  "NIGER",
  "OGUN",
  "ONDO",
  "OSUN",
  "OYO",
  "PLATEAU",
  "RIVERS",
  "SOKOTO",
  "TARABA",
  "YOBE",
  "ZAMFARA",
] as const;
export type Region = (typeof REGIONS)[number];
export type GeoZone = "NORTH" | "SOUTH";

const NORTH_STATES = new Set<string>([
  "ADAMAWA", "BAUCHI", "BORNO", "GOMBE", "TARABA", "YOBE",
  "JIGAWA", "KADUNA", "KANO", "KATSINA", "KEBBI", "SOKOTO", "ZAMFARA",
  "BENUE", "KOGI", "KWARA", "NASARAWA", "NIGER", "PLATEAU", "FCT (ABUJA)",
]);
const SOUTH_STATES = new Set<string>([
  "ABIA", "ANAMBRA", "EBONYI", "ENUGU", "IMO",
  "AKWA IBOM", "BAYELSA", "CROSS RIVER", "DELTA", "EDO", "RIVERS",
  "EKITI", "LAGOS", "OGUN", "ONDO", "OSUN", "OYO",
]);

/** Map a state (or a legacy NORTH/SOUTH value) to the zone used by ANM routing. */
export function zoneForRegion(region: string | null | undefined): GeoZone | null {
  if (!region) return null;
  const r = region.trim().toUpperCase();
  if (r === "NORTH" || r === "SOUTH") return r;
  if (NORTH_STATES.has(r)) return "NORTH";
  if (SOUTH_STATES.has(r)) return "SOUTH";
  return null;
}

/** Every state covered by a zone, for region-scoped reporting. */
export function statesForZone(zone: GeoZone): string[] {
  return [...(zone === "NORTH" ? NORTH_STATES : SOUTH_STATES)];
}

/** Expand zone values to their states while keeping legacy NORTH/SOUTH records matchable. */
export function expandRegions(regions: readonly string[]): string[] {
  return [...new Set(regions.flatMap((r) => (r === "NORTH" || r === "SOUTH" ? [r, ...statesForZone(r)] : [r])))];
}

/** Accepts the state list plus legacy NORTH/SOUTH values already stored in older records. */
export function isRegion(v: unknown): v is string {
  return typeof v === "string" && ((REGIONS as readonly string[]).includes(v) || v === "NORTH" || v === "SOUTH");
}

/** Roles that require a region scope on assignment. */
export const REGION_REQUIRED_ROLES: readonly Role[] = ["ANM"];

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}
export function isInitiatorRole(v: unknown): v is InitiatorRole {
  return typeof v === "string" && (INITIATOR_ROLES as readonly string[]).includes(v);
}

export const ADMIN_ROLES: readonly Role[] = ["SUPER_ADMIN", "REPORTING_ADMIN"];
export const REPORTING_ROLES: readonly Role[] = ["SUPER_ADMIN", "REPORTING_ADMIN"];
