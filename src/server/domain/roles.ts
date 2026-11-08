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

export const REGIONS = ["NORTH", "SOUTH"] as const;
export type Region = (typeof REGIONS)[number];

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
