export const ROLES = [
  "RM",
  "ANM",
  "MERCHANT_OFFICER",
  "RBE",
  "MERCHANT_OFFICER_LEAD",
  "MERCHANT_OFFICER_HEAD",
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
  // Retail Asset Factory
  "DELIGHT_OFFICER",
  "OUTLET_SERVICE_SUPERVISOR",
  "TEAM_LEAD",
  "HEAD_OF_RETAIL_SALES",
  "HEAD_OF_UNIT",
  "HEAD_OF_CORPORATE_BANKING",
  "PRODUCT_CONFIG_APPROVER",
  "VENDOR_MANAGER",
  "COLLECTIONS_OFFICER",
  // Staff Salary Advance
  "PRODUCT_MANAGER",
  "STAFF_APPLICANT",
  // Altphones
  "SMILE_ASSOCIATE",
  "BUSINESS_PERFORMANCE_MANAGER",
  "ALTPHONES_PRODUCT_MANAGER",
  // Retail approval policy RETAIL_CX_V1
  "CX_CREDIT_REVIEWER",
  // Retail CX oversight: sees the CX credit reviewers' activity; never approves or edits a request
  "CX_GROUP_HEAD",
  // Read-only institution-wide reporting (never approves or edits)
  "EXECUTIVE_VIEW",
  // Confirms supplier / vehicle invoices with the issuer after final approval (one queue, all products)
  "INVOICE_CONFIRMATION_OFFICER",
  // CRM: organisation-wide complaint oversight, analytics and reports (no Super Admin or financing authority)
  "CX_HEAD",
  // CRM only: lets staff who have no other ARAF role sign in to work complaints (no financing or admin rights)
  "CRM_AGENT",
  // Staff Salary Advance: maintains the confidential salary register and records confirmed repayments
  "SALARY_REGISTER_ADMIN",
] as const;
export type Role = (typeof ROLES)[number];

export const INITIATOR_ROLES = ["RM", "ANM", "MERCHANT_OFFICER", "DELIGHT_OFFICER"] as const;
/** Initiators of retail products (Vendor Financing, Alt Drive, Alt Power), in display order. */
/** Team Leads and Unit Heads may originate retail requests; routing never sends a request back to its originator.
 *  Delight Officers / Smile Associates sell Altphones only: they no longer start retail requests (requests they
 *  started earlier keep their Outlet Service Supervisor route). */
export const RETAIL_INITIATOR_ROLES = ["RM", "TEAM_LEAD", "UNIT_HEAD", "MERCHANT_OFFICER_LEAD", "MERCHANT_OFFICER_HEAD"] as const;
export type RetailInitiatorRole = (typeof RETAIL_INITIATOR_ROLES)[number];
/** WakeelBoost (legacy) initiators. */
export const LEGACY_INITIATOR_ROLES = ["RM", "ANM", "MERCHANT_OFFICER", "MERCHANT_OFFICER_LEAD", "MERCHANT_OFFICER_HEAD"] as const;
/** Merchant Officer hierarchy: officers originate WakeelBoost only; Leads and Heads originate the wider suite. */
export const MERCHANT_HIERARCHY_ROLES = ["MERCHANT_OFFICER", "MERCHANT_OFFICER_LEAD", "MERCHANT_OFFICER_HEAD"] as const;
export type InitiatorRole = (typeof INITIATOR_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  RM: "Relationship Manager",
  ANM: "Agent Network Manager",
  MERCHANT_OFFICER: "Merchant Officer",
  RBE: "Regional Business Executive",
  MERCHANT_OFFICER_LEAD: "Merchant Officer Lead",
  MERCHANT_OFFICER_HEAD: "Merchant Officer Head",
  ANM_LEAD_NORTH: "North ANM Lead",
  ANM_LEAD_SOUTH: "South ANM Lead",
  CREDIT_OFFICER_1: "Credit Officer 1",
  CREDIT_OFFICER_2: "Credit Officer 2",
  CREDIT_OFFICER_3: "Credit Officer 3",
  CREDIT_LEAD_1: "Credit Lead 1",
  CREDIT_LEAD_2: "Credit Lead 2",
  UNIT_HEAD: "Unit Head (credit approval)",
  DIVISIONAL_HEAD: "Divisional Head",
  DISBURSEMENT_OFFICER_1: "Disbursement Officer 1",
  DISBURSEMENT_OFFICER_2: "Disbursement Officer 2",
  SUPER_ADMIN: "Super Admin",
  REPORTING_ADMIN: "Reporting Admin",
  LEGAL_REVIEWER: "Legal (closure recipient)",
  SHARIAH_REVIEWER: "Shariah Compliance (closure recipient)",
  DELIGHT_OFFICER: "Delight Officer",
  OUTLET_SERVICE_SUPERVISOR: "Outlet Service Supervisor",
  TEAM_LEAD: "Team Lead",
  HEAD_OF_RETAIL_SALES: "Head of Retail Sales",
  HEAD_OF_UNIT: "Head of Unit (business approval)",
  HEAD_OF_CORPORATE_BANKING: "Head of Corporate Banking",
  PRODUCT_CONFIG_APPROVER: "Product configuration approver",
  VENDOR_MANAGER: "Vendor register officer",
  COLLECTIONS_OFFICER: "Collections and servicing officer",
  PRODUCT_MANAGER: "Product Manager (salary advance)",
  STAFF_APPLICANT: "Staff member (salary advance)",
  SMILE_ASSOCIATE: "Smile Associate (Altphones)",
  BUSINESS_PERFORMANCE_MANAGER: "Business Performance Manager (Altphones)",
  ALTPHONES_PRODUCT_MANAGER: "Altphones Product Manager",
  CX_CREDIT_REVIEWER: "CX Credit Reviewer (retail)",
  CX_GROUP_HEAD: "CX Group Head (retail CX oversight)",
  EXECUTIVE_VIEW: "Executive View (God's Eye, read-only)",
  INVOICE_CONFIRMATION_OFFICER: "Invoice Confirmation Officer",
  CX_HEAD: "CX Head (complaints oversight)",
  CRM_AGENT: "CRM team member (complaints only)",
  SALARY_REGISTER_ADMIN: "Salary Register Administrator",
};

/** The Delight Officer / Smile Associate channel originates Altphones only. */
export const ALTPHONES_ORIGINATOR_ROLES = ["DELIGHT_OFFICER", "SMILE_ASSOCIATE"] as const;

/** Roles whose holders review retail cases across the organisation (dashboards and case visibility). */
export const RETAIL_ORG_VIEW_ROLES: readonly Role[] = ["HEAD_OF_RETAIL_SALES", "HEAD_OF_UNIT"];
/** Roles that need a team on assignment (routing scope). */
export const TEAM_SCOPED_ROLES: readonly Role[] = ["RM", "TEAM_LEAD", "DELIGHT_OFFICER"];

/** Positions that may be held by at most one active person at a time. */
export const SINGLE_HOLDER_ROLES: readonly Role[] = ["CREDIT_LEAD_1", "CREDIT_LEAD_2", "ANM_LEAD_NORTH", "ANM_LEAD_SOUTH", "DIVISIONAL_HEAD"];

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

/**
 * Every region value that may match a request in `region`: a state also matches a role scoped to its zone
 * (a legacy record can hold SOUTH/NORTH while the request holds LAGOS, or the reverse), and a zone matches
 * all its states.
 */
export function regionScopeValues(region: string): string[] {
  const r = region.trim().toUpperCase();
  const out = new Set<string>(expandRegions([r]));
  const zone = zoneForRegion(r);
  if (zone) out.add(zone);
  return [...out];
}

/** Accepts the state list plus legacy NORTH/SOUTH values already stored in older records. */
export function isRegion(v: unknown): v is string {
  return typeof v === "string" && ((REGIONS as readonly string[]).includes(v) || v === "NORTH" || v === "SOUTH");
}

/** Roles that require a region scope on assignment. */
export const REGION_REQUIRED_ROLES: readonly Role[] = ["ANM", "TEAM_LEAD"];

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}
export function isRetailInitiatorRole(v: unknown): v is RetailInitiatorRole {
  return typeof v === "string" && (RETAIL_INITIATOR_ROLES as readonly string[]).includes(v);
}
export function isLegacyInitiatorRole(v: unknown): v is (typeof LEGACY_INITIATOR_ROLES)[number] {
  return typeof v === "string" && (LEGACY_INITIATOR_ROLES as readonly string[]).includes(v);
}
export function isInitiatorRole(v: unknown): v is InitiatorRole {
  return typeof v === "string" && (INITIATOR_ROLES as readonly string[]).includes(v);
}

export const ADMIN_ROLES: readonly Role[] = ["SUPER_ADMIN", "REPORTING_ADMIN"];
export const REPORTING_ROLES: readonly Role[] = ["SUPER_ADMIN", "REPORTING_ADMIN"];

/**
 * A state as people write it ("Lagos", "lagos state", "Abuja", "Port Harcourt", "Jos", "Lagos/Ogun") →
 * the state as ARAF stores it, or null when it cannot be resolved. City labels used in place of a state
 * map to their state (Port Harcourt → RIVERS, Jos → PLATEAU); "Lagos/Ogun" (Ogijo) is recorded as OGUN.
 */
const STATE_ALIASES: Record<string, string> = {
  ABUJA: "FCT (ABUJA)",
  FCT: "FCT (ABUJA)",
  "FCT ABUJA": "FCT (ABUJA)",
  "FEDERAL CAPITAL TERRITORY": "FCT (ABUJA)",
  "PORT HARCOURT": "RIVERS",
  PH: "RIVERS",
  JOS: "PLATEAU",
  "LAGOS/OGUN": "OGUN",
  "LAGOS / OGUN": "OGUN",
  "AKWA-IBOM": "AKWA IBOM",
  "CROSS-RIVER": "CROSS RIVER",
  // City names used as states in the Altphones profiling workbook.
  CALABAR: "CROSS RIVER",
  MINNA: "NIGER",
  ZARIA: "KADUNA",
  UYO: "AKWA IBOM",
  NASSARAWA: "NASARAWA",
  "FCT SALES AGENT": "FCT (ABUJA)",
};
export function normaliseNigerianState(label: string | null | undefined): string | null {
  const s = String(label ?? "").toUpperCase().replace(/_/g, " ").replace(/\s+/g, " ").replace(/\s+STATE$/, "").trim();
  if (!s) return null;
  if (STATE_ALIASES[s]) return STATE_ALIASES[s];
  const plain = s.replace(/-/g, " ");
  if (STATE_ALIASES[plain]) return STATE_ALIASES[plain];
  return (REGIONS as readonly string[]).includes(plain) ? plain : (REGIONS as readonly string[]).includes(s) ? s : null;
}
