/**
 * Product catalogue and versioned product configuration (AltBank Retail Asset Factory).
 *
 * Every business parameter is explicit. A parameter that has not been supplied by the bank is stored as
 * `null` and reported by `configGaps()` together with the transaction it blocks. Nothing is inherited
 * from another product to fill a gap. Configuration changes are proposed by an administrator and take
 * effect only after a different person holding PRODUCT_CONFIG_APPROVER approves them (maker-checker),
 * from a stated effective date. Applications keep the configuration version they were assessed under.
 */
import { z } from "zod";
import type { Db, Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { holdsRole } from "./access";
import { isRole, ROLE_LABELS, type Role } from "./roles";
import { CREDIT_ROUTES } from "./routing";
import { formatKobo } from "../money";
import type { ApplicantType } from "./application-data";

// ------------------------------------------------------------------ vocabulary

export const CUSTOMER_PROFILES = ["SALARY_EARNER", "BUSINESS_OWNER"] as const;
export type CustomerProfile = (typeof CUSTOMER_PROFILES)[number];
export const PROFILE_LABELS: Record<CustomerProfile, string> = {
  SALARY_EARNER: "Salary earner",
  BUSINESS_OWNER: "Business owner / registered business",
};

export const STRUCTURE_CODES = ["STANDARD", "MURABAHA", "IJARAH"] as const;
export type StructureCode = (typeof STRUCTURE_CODES)[number];
export const STRUCTURE_LABELS: Record<StructureCode, string> = { STANDARD: "Standard", MURABAHA: "Murabaha", IJARAH: "Ijarah" };

/**
 * How a quoted rate relates to the tenor. The bank must choose one per structure before final
 * calculation and offer generation; the platform never assumes annual, monthly, flat or reducing.
 */
export const RATE_CONVENTIONS = ["FLAT_PER_ANNUM", "FLAT_FOR_TENOR", "FLAT_PER_MONTH"] as const;
export type RateConvention = (typeof RATE_CONVENTIONS)[number];
export const RATE_CONVENTION_LABELS: Record<RateConvention, string> = {
  FLAT_PER_ANNUM: "Flat, per annum (profit = principal × rate × tenor ÷ 12)",
  FLAT_FOR_TENOR: "Flat, once for the whole tenor (profit = principal × rate)",
  FLAT_PER_MONTH: "Flat, per month (profit = principal × rate × tenor)",
};

export const INSURANCE_BEARERS = ["CUSTOMER", "BANK", "NOT_APPLICABLE"] as const;
export type InsuranceBearer = (typeof INSURANCE_BEARERS)[number];
export const INSURANCE_LABELS: Record<InsuranceBearer, string> = {
  CUSTOMER: "Customer bears the insurance cost",
  BANK: "Bank bears the insurance cost",
  NOT_APPLICABLE: "Insurance not applicable",
};

/** Approved DSR denominators. All are monthly so numerator and denominator use the same period. */
export const DSR_DENOMINATORS = [
  "VERIFIED_MONTHLY_NET_SALARY",
  "VERIFIED_MONTHLY_GROSS_SALARY",
  "AVERAGE_MONTHLY_BUSINESS_TURNOVER",
  "AVERAGE_MONTHLY_NET_CASH_INFLOW",
  "AVERAGE_MONTHLY_NET_PROFIT",
] as const;
export type DsrDenominator = (typeof DSR_DENOMINATORS)[number];
export const DSR_DENOMINATOR_LABELS: Record<DsrDenominator, string> = {
  VERIFIED_MONTHLY_NET_SALARY: "Verified monthly net salary",
  VERIFIED_MONTHLY_GROSS_SALARY: "Verified monthly gross salary",
  AVERAGE_MONTHLY_BUSINESS_TURNOVER: "Average monthly business turnover (statement credits)",
  AVERAGE_MONTHLY_NET_CASH_INFLOW: "Average monthly net cash inflow",
  AVERAGE_MONTHLY_NET_PROFIT: "Average monthly net profit",
};

export const DOC_STAGES = ["SUBMISSION", "CREDIT", "OFFER", "PRE_DISBURSEMENT"] as const;
export type DocStage = (typeof DOC_STAGES)[number];
export const REQUIREMENT_LEVELS = ["MANDATORY", "CONDITIONAL", "OPTIONAL"] as const;

export const FULFILMENT_KINDS = ["POS_DEPLOYMENT", "ASSET_DELIVERY", "ASSET_HANDOVER", "INSTALLATION"] as const;
export type FulfilmentKind = (typeof FULFILMENT_KINDS)[number];
export const FULFILMENT_LABELS: Record<FulfilmentKind, string> = {
  POS_DEPLOYMENT: "POS deployment",
  ASSET_DELIVERY: "Asset delivery",
  ASSET_HANDOVER: "Asset handover",
  INSTALLATION: "Installation",
};

// ------------------------------------------------------------------ schema

const pct = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, "Enter a percentage with up to 4 decimal places.");
const kobo = z.number().int().positive();
const roleRef = z.string().refine((r) => isRole(r), "Unknown role.");

export const structureSchema = z.object({
  code: z.enum(STRUCTURE_CODES),
  ratePercent: pct.nullable(),
  rateConvention: z.enum(RATE_CONVENTIONS).nullable(),
  insuranceBearer: z.enum(INSURANCE_BEARERS).nullable(),
  /** Ordered contract / acquisition steps for the structure (document-backed). Null = not yet approved. */
  contractSequence: z.array(z.string().min(2).max(120)).nullable().default(null),
});
export type StructureRules = z.infer<typeof structureSchema>;

export const docRequirementSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
  requirement: z.enum(REQUIREMENT_LEVELS),
  stage: z.enum(DOC_STAGES),
  minCount: z.number().int().min(1).max(20).default(1),
  /** Statement / payslip coverage: months come from the named profile parameter. */
  coverageFrom: z.enum(["statementMonths", "payslipMonths"]).nullable().default(null),
  /** Conditional requirements (amount band, structure). */
  amountAboveKobo: kobo.nullable().default(null),
  structures: z.array(z.enum(STRUCTURE_CODES)).nullable().default(null),
  /** Exception type that can stand in for this document, when configured (e.g. AFS). */
  exceptionType: z.enum(["AFS", "DOCUMENT"]).nullable().default(null),
  note: z.string().max(300).nullable().default(null),
});
export type DocRequirement = z.infer<typeof docRequirementSchema>;

export const profileRulesSchema = z.object({
  enabled: z.boolean(),
  eligibleApplicantTypes: z.array(z.enum(["INDIVIDUAL", "ENTERPRISE", "LIMITED"])).min(1),
  eligibilityNote: z.string().max(300).nullable().default(null),
  maxAmountKobo: kobo.nullable(),
  maxTenorMonths: z.number().int().min(1).max(360).nullable(),
  structures: z.array(structureSchema),
  dsr: z.object({
    maxPercent: pct.nullable(),
    denominator: z.enum(DSR_DENOMINATORS).nullable(),
    exceptionAllowed: z.boolean().default(false),
    exceptionApproverRole: roleRef.nullable().default(null),
  }),
  /** Principal-to-turnover cap. Independent of DSR and never derived from it. */
  principalTurnoverCap: z.object({ applies: z.boolean(), maxPercent: pct.nullable() }).default({ applies: false, maxPercent: null }),
  statementMonths: z.number().int().min(1).max(36).nullable(),
  payslipMonths: z.number().int().min(1).max(36).nullable().default(null),
  /** Statement recency (days between statement end and submission). Null = not checked. */
  statementMaxAgeDays: z.number().int().min(1).max(365).nullable().default(null),
  equityContribution: z.object({ applies: z.boolean().nullable(), minPercent: pct.nullable() }).default({ applies: false, minPercent: null }),
  /** Asset eligibility criteria (e.g. vehicle age, make). Required for asset products. */
  assetEligibility: z.object({ required: z.boolean(), criteria: z.string().max(2000).nullable() }).default({ required: false, criteria: null }),
  visitRequired: z.boolean().nullable(),
  rmProposalRequired: z.boolean(),
  businessPhotos: z.object({ minDistinct: z.number().int().min(0).max(20), rmPhotoRequired: z.boolean() }).default({ minDistinct: 0, rmPhotoRequired: false }),
  afs: z.object({ thresholdKobo: kobo.nullable(), exceptionApproverRole: roleRef.nullable() }).nullable().default(null),
  documents: z.array(docRequirementSchema),
});
export type ProfileRules = z.infer<typeof profileRulesSchema>;

export const productConfigSchema = z.object({
  profiles: z.object({ SALARY_EARNER: profileRulesSchema.optional(), BUSINESS_OWNER: profileRulesSchema.optional() }),
  businessReview: z.object({
    /** DISTINCT: Head of Unit approval is a separate stage after Head of Retail Sales. */
    headOfUnitStage: z.enum(["DISTINCT", "NOT_REQUIRED"]).nullable(),
  }),
  /** Requires the vendor/beneficiary to be selected from the approved register. */
  beneficiaryRequired: z.boolean().default(true),
  /** Post-disbursement fulfilment tasks created only after payment is confirmed and reconciled. */
  fulfilmentSteps: z.array(z.enum(FULFILMENT_KINDS)).default([]),
  servicing: z.object({ restructureApproverRole: roleRef.nullable() }).default({ restructureApproverRole: null }),
  draftExpiryDays: z.number().int().min(1).max(365).nullable().default(null),
  privacyConsents: z.array(z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]+$/), purpose: z.string().min(10).max(500) })).default([]),
});
export type ProductConfig = z.infer<typeof productConfigSchema>;

// ------------------------------------------------------------------ initial rules (as supplied)

const NAIRA = (n: number) => n * 100;
const doc = (code: string, stage: DocStage, extra: Partial<DocRequirement> = {}): DocRequirement =>
  docRequirementSchema.parse({ code, requirement: "MANDATORY", stage, ...extra });
const unset = <T>(): T | null => null;

/**
 * Version 1 of each product, containing only the parameters supplied in the AltBank Retail Asset Factory
 * requirements. Everything else is null (a visible configuration gap).
 */
export const INITIAL_PRODUCT_CONFIGS: Record<string, ProductConfig> = {
  VENDOR_FINANCING: productConfigSchema.parse({
    profiles: {
      BUSINESS_OWNER: {
        enabled: true,
        eligibleApplicantTypes: ["ENTERPRISE", "LIMITED"],
        eligibilityNote: "Registered businesses only.",
        maxAmountKobo: NAIRA(50_000_000),
        maxTenorMonths: 12,
        structures: [{ code: "STANDARD", ratePercent: "23", rateConvention: unset(), insuranceBearer: unset(), contractSequence: null }],
        dsr: { maxPercent: "30", denominator: unset(), exceptionAllowed: false, exceptionApproverRole: null },
        statementMonths: unset(),
        visitRequired: unset(),
        rmProposalRequired: true,
        businessPhotos: { minDistinct: 4, rmPhotoRequired: true },
        afs: { thresholdKobo: NAIRA(20_000_000), exceptionApproverRole: unset() },
        documents: [
          doc("CAC_CERTIFICATE", "SUBMISSION"),
          doc("VENDOR_CONFIRMATION_EMAIL", "SUBMISSION"),
          doc("CUSTOMER_REQUEST_LETTER", "SUBMISSION", { note: "Formal customer request letter (replaces the consent form)." }),
          doc("BANK_STATEMENT", "SUBMISSION", { coverageFrom: "statementMonths" }),
          doc("BUSINESS_PHOTO", "SUBMISSION", { minCount: 4 }),
          doc("AFS", "SUBMISSION", { requirement: "CONDITIONAL", amountAboveKobo: NAIRA(20_000_000), exceptionType: "AFS", note: "Audited financial statements, normally required above ₦20 million." }),
          doc("SUPPLIER_INVOICE", "SUBMISSION", { requirement: "OPTIONAL" }),
          doc("CREDIT_REPORT", "CREDIT", { requirement: "OPTIONAL" }),
        ],
      },
    },
    businessReview: { headOfUnitStage: "DISTINCT" },
    beneficiaryRequired: true,
    fulfilmentSteps: ["POS_DEPLOYMENT"],
    servicing: { restructureApproverRole: null },
  }),
  ALT_DRIVE: productConfigSchema.parse({
    profiles: {
      SALARY_EARNER: {
        enabled: true,
        eligibleApplicantTypes: ["INDIVIDUAL"],
        eligibilityNote: "Confirmed salary earners.",
        maxAmountKobo: unset(),
        maxTenorMonths: unset(),
        structures: [
          { code: "MURABAHA", ratePercent: "34", rateConvention: unset(), insuranceBearer: "CUSTOMER", contractSequence: null },
          { code: "IJARAH", ratePercent: "39.5", rateConvention: unset(), insuranceBearer: "BANK", contractSequence: null },
        ],
        dsr: { maxPercent: "33", denominator: unset(), exceptionAllowed: false, exceptionApproverRole: null },
        statementMonths: 6,
        payslipMonths: 3,
        equityContribution: { applies: unset(), minPercent: null },
        assetEligibility: { required: true, criteria: unset() },
        visitRequired: unset(),
        rmProposalRequired: false,
        documents: [
          doc("EMPLOYMENT_CONFIRMATION", "SUBMISSION"),
          doc("CREDIT_REPORT", "SUBMISSION"),
          doc("PAYSLIP", "SUBMISSION", { coverageFrom: "payslipMonths", minCount: 3 }),
          doc("BANK_STATEMENT", "SUBMISSION", { coverageFrom: "statementMonths" }),
          doc("VEHICLE_INVOICE", "SUBMISSION"),
        ],
      },
      BUSINESS_OWNER: {
        enabled: true,
        eligibleApplicantTypes: ["ENTERPRISE", "LIMITED"],
        eligibilityNote: "Business owners with CAC registration.",
        maxAmountKobo: unset(),
        maxTenorMonths: unset(),
        structures: [
          { code: "MURABAHA", ratePercent: "34", rateConvention: unset(), insuranceBearer: "CUSTOMER", contractSequence: null },
          { code: "IJARAH", ratePercent: "39.5", rateConvention: unset(), insuranceBearer: "BANK", contractSequence: null },
        ],
        dsr: { maxPercent: "10", denominator: unset(), exceptionAllowed: false, exceptionApproverRole: null },
        statementMonths: 12,
        equityContribution: { applies: unset(), minPercent: null },
        assetEligibility: { required: true, criteria: unset() },
        visitRequired: unset(),
        rmProposalRequired: true,
        documents: [
          doc("CAC_CERTIFICATE", "SUBMISSION"),
          doc("BANK_STATEMENT", "SUBMISSION", { coverageFrom: "statementMonths" }),
          doc("VEHICLE_INVOICE", "SUBMISSION"),
          doc("CREDIT_REPORT", "CREDIT", { note: "Required in the credit appraisal." }),
        ],
      },
    },
    businessReview: { headOfUnitStage: "DISTINCT" },
    beneficiaryRequired: true,
    fulfilmentSteps: ["ASSET_HANDOVER"],
    servicing: { restructureApproverRole: null },
  }),
  ALT_POWER: productConfigSchema.parse({
    profiles: {
      SALARY_EARNER: {
        enabled: true,
        eligibleApplicantTypes: ["INDIVIDUAL"],
        eligibilityNote: "Salary earners seeking power and alternative-energy financing.",
        maxAmountKobo: unset(),
        maxTenorMonths: unset(),
        structures: [],
        dsr: { maxPercent: "33", denominator: unset(), exceptionAllowed: false, exceptionApproverRole: null },
        statementMonths: unset(),
        payslipMonths: unset(),
        visitRequired: unset(),
        rmProposalRequired: false,
        documents: [
          doc("EMPLOYMENT_CONFIRMATION", "SUBMISSION"),
          doc("CREDIT_REPORT", "SUBMISSION"),
          doc("PAYSLIP", "SUBMISSION", { coverageFrom: "payslipMonths", note: "Evidence of income and salary history." }),
          doc("BANK_STATEMENT", "SUBMISSION", { coverageFrom: "statementMonths" }),
          doc("SUPPLIER_QUOTATION", "SUBMISSION", { note: "Quotation or invoice identifying the power solution." }),
        ],
      },
      BUSINESS_OWNER: {
        enabled: true,
        eligibleApplicantTypes: ["ENTERPRISE", "LIMITED"],
        eligibilityNote: "Business owners with CAC registration.",
        maxAmountKobo: unset(),
        maxTenorMonths: unset(),
        structures: [],
        dsr: { maxPercent: unset(), denominator: unset(), exceptionAllowed: false, exceptionApproverRole: null },
        statementMonths: unset(),
        visitRequired: unset(),
        rmProposalRequired: true,
        documents: [
          doc("CAC_CERTIFICATE", "SUBMISSION"),
          doc("BANK_STATEMENT", "SUBMISSION", { coverageFrom: "statementMonths", note: "Business bank statements." }),
          doc("CREDIT_REPORT", "SUBMISSION"),
          doc("BUSINESS_OPERATIONS_EVIDENCE", "SUBMISSION", { note: "Evidence of business operations and financial capacity." }),
          doc("SUPPLIER_QUOTATION", "SUBMISSION"),
        ],
      },
    },
    businessReview: { headOfUnitStage: "DISTINCT" },
    beneficiaryRequired: true,
    fulfilmentSteps: ["INSTALLATION"],
    servicing: { restructureApproverRole: null },
  }),
};

// ------------------------------------------------------------------ configuration gaps

export type BlockedAction = "SUBMISSION" | "TEAM_LEAD_REVIEW" | "FINAL_ASSESSMENT" | "OFFER" | "AFS_EXCEPTION" | "DSR_EXCEPTION" | "RESTRUCTURE" | "CONTRACTING";
export const BLOCKED_ACTION_LABELS: Record<BlockedAction, string> = {
  SUBMISSION: "Application submission",
  TEAM_LEAD_REVIEW: "Team Lead review",
  FINAL_ASSESSMENT: "Final credit calculation",
  OFFER: "Offer and contract generation",
  AFS_EXCEPTION: "AFS exception approval",
  DSR_EXCEPTION: "DSR exception approval",
  RESTRUCTURE: "Restructuring approval",
  CONTRACTING: "Structure-specific contracting steps",
};

export interface ConfigGap {
  key: string;
  label: string;
  blocks: BlockedAction;
  profile?: CustomerProfile;
  structure?: StructureCode;
}

/** Every missing parameter for a product (optionally narrowed to a profile / structure / amount). */
export function configGaps(cfg: ProductConfig, opts: { profile?: CustomerProfile | null; structure?: string | null; amountKobo?: number | null } = {}): ConfigGap[] {
  const gaps: ConfigGap[] = [];
  const profiles = (Object.entries(cfg.profiles) as [CustomerProfile, ProfileRules | undefined][]).filter(([p, r]) => r?.enabled && (!opts.profile || p === opts.profile));
  if (cfg.businessReview.headOfUnitStage === null) gaps.push({ key: "businessReview.headOfUnitStage", label: "Head of Unit stage (distinct or not required)", blocks: "SUBMISSION" });
  for (const [p, r] of profiles) {
    if (!r) continue;
    const g = (key: string, label: string, blocks: BlockedAction, structure?: StructureCode) => gaps.push({ key: `profiles.${p}.${key}`, label: `${PROFILE_LABELS[p]}: ${label}`, blocks, profile: p, structure });
    if (r.maxAmountKobo === null) g("maxAmountKobo", "maximum financing amount", "SUBMISSION");
    if (r.maxTenorMonths === null) g("maxTenorMonths", "maximum tenor", "SUBMISSION");
    if (r.dsr.maxPercent === null) g("dsr.maxPercent", "maximum DSR", "SUBMISSION");
    if (r.dsr.denominator === null) g("dsr.denominator", "DSR income / business denominator", "SUBMISSION");
    if (r.dsr.exceptionAllowed && !r.dsr.exceptionApproverRole) g("dsr.exceptionApproverRole", "DSR exception approver role", "DSR_EXCEPTION");
    if (r.principalTurnoverCap.applies && r.principalTurnoverCap.maxPercent === null) g("principalTurnoverCap.maxPercent", "principal-to-turnover cap", "SUBMISSION");
    if (r.documents.some((d) => d.coverageFrom === "statementMonths") && r.statementMonths === null) g("statementMonths", "bank statement period (months)", "SUBMISSION");
    if (r.documents.some((d) => d.coverageFrom === "payslipMonths") && r.payslipMonths === null) g("payslipMonths", "payslip / salary history period (months)", "SUBMISSION");
    if (r.equityContribution.applies === null) g("equityContribution.applies", "equity contribution rule", "SUBMISSION");
    if (r.equityContribution.applies && r.equityContribution.minPercent === null) g("equityContribution.minPercent", "minimum equity contribution", "SUBMISSION");
    if (r.assetEligibility.required && !r.assetEligibility.criteria) g("assetEligibility.criteria", "asset eligibility criteria", "SUBMISSION");
    if (r.visitRequired === null) g("visitRequired", "whether a management visit is required", "TEAM_LEAD_REVIEW");
    if (r.afs && r.afs.thresholdKobo !== null && !r.afs.exceptionApproverRole) g("afs.exceptionApproverRole", "AFS exception authority (approver role)", "AFS_EXCEPTION");
    if (r.structures.length === 0) g("structures", "financing structure(s)", "SUBMISSION");
    for (const s of r.structures) {
      if (opts.structure && s.code !== opts.structure) continue;
      const sl = STRUCTURE_LABELS[s.code];
      if (s.ratePercent === null) g(`structures.${s.code}.ratePercent`, `${sl} profit rate`, "FINAL_ASSESSMENT", s.code);
      if (s.rateConvention === null) g(`structures.${s.code}.rateConvention`, `${sl} rate convention (relationship between rate and tenor)`, "FINAL_ASSESSMENT", s.code);
      if (s.insuranceBearer === null) g(`structures.${s.code}.insuranceBearer`, `${sl} insurance treatment`, "OFFER", s.code);
      if (s.contractSequence === null) g(`structures.${s.code}.contractSequence`, `${sl} contractual sequence`, "CONTRACTING", s.code);
    }
    if (opts.amountKobo && r.maxAmountKobo !== null && opts.amountKobo <= r.maxAmountKobo) {
      const maxRoute = CREDIT_ROUTES[CREDIT_ROUTES.length - 1].maxKobo;
      if (opts.amountKobo > maxRoute) g("creditRoute", `credit approval route for amounts above ${formatKobo(maxRoute)}`, "SUBMISSION");
    }
  }
  if (cfg.servicing.restructureApproverRole === null) gaps.push({ key: "servicing.restructureApproverRole", label: "Restructuring approval authority", blocks: "RESTRUCTURE" });
  return gaps;
}

export function gapsBlocking(gaps: ConfigGap[], action: BlockedAction) {
  return gaps.filter((g) => g.blocks === action);
}

export function describeGaps(gaps: ConfigGap[]) {
  return gaps.map((g) => g.label).join("; ");
}

// ------------------------------------------------------------------ persistence

export interface ProductRow {
  code: string;
  name: string;
  description: string | null;
  workflow: "WAKEELBOOST" | "RETAIL";
  active: boolean;
  sort_order: number;
}

export interface ProductConfigRow {
  id: string;
  product_code: string;
  version: number;
  status: "PROPOSED" | "APPROVED" | "REJECTED" | "WITHDRAWN";
  config: ProductConfig;
  effective_from: Date;
  reason: string;
  proposed_by: string | null;
  proposed_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  proposed_by_name?: string | null;
  decided_by_name?: string | null;
}

export async function listProducts(q: Db, opts: { retailOnly?: boolean; activeOnly?: boolean } = {}): Promise<ProductRow[]> {
  const where: string[] = [];
  if (opts.retailOnly) where.push("workflow = 'RETAIL'");
  if (opts.activeOnly) where.push("active");
  return (await q.query<ProductRow>(`SELECT * FROM products ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY sort_order, name`)).rows;
}

export async function getProduct(q: Db, code: string): Promise<ProductRow | null> {
  return (await q.query<ProductRow>("SELECT * FROM products WHERE code = $1", [code])).rows[0] ?? null;
}

function parseRow(r: ProductConfigRow): ProductConfigRow {
  return { ...r, config: productConfigSchema.parse(r.config) };
}

/** The approved configuration in force at `at` (latest effective date, then latest version). */
export async function effectiveConfig(q: Db, productCode: string, at: Date): Promise<ProductConfigRow | null> {
  const r = (
    await q.query<ProductConfigRow>(
      `SELECT * FROM product_configs WHERE product_code = $1 AND status = 'APPROVED' AND effective_from <= $2
        ORDER BY effective_from DESC, version DESC LIMIT 1`,
      [productCode, at],
    )
  ).rows[0];
  return r ? parseRow(r) : null;
}

export async function configById(q: Db, id: string): Promise<ProductConfigRow> {
  const r = (await q.query<ProductConfigRow>("SELECT * FROM product_configs WHERE id = $1", [id])).rows[0];
  if (!r) throw notFound("Product configuration not found.");
  return parseRow(r);
}

export async function configHistory(q: Db, productCode: string): Promise<ProductConfigRow[]> {
  return (
    await q.query<ProductConfigRow>(
      `SELECT c.*, p.full_name AS proposed_by_name, d.full_name AS decided_by_name FROM product_configs c
         LEFT JOIN staff p ON p.id = c.proposed_by LEFT JOIN staff d ON d.id = c.decided_by
        WHERE c.product_code = $1 ORDER BY c.version DESC`,
      [productCode],
    )
  ).rows;
}

/** Insert version 1 of each product from the supplied requirements (idempotent). */
export async function seedInitialProductConfigs(q: Db) {
  for (const [code, cfg] of Object.entries(INITIAL_PRODUCT_CONFIGS)) {
    await q.query(
      `INSERT INTO product_configs (product_code, version, status, config, effective_from, reason, decided_at, decision_note)
       SELECT $1, 1, 'APPROVED', $2, '2026-01-01T00:00:00Z', $3, now(), 'Initial parameters as supplied; unsupplied parameters are left unset.'
        WHERE NOT EXISTS (SELECT 1 FROM product_configs WHERE product_code = $1)`,
      [code, JSON.stringify(cfg), "Initial parameters supplied in the AltBank Retail Asset Factory operating requirements"],
    );
  }
}

/** Administrator proposes a new configuration version (maker). */
export async function proposeProductConfig(ctx: Ctx, p: { productCode: string; config: unknown; effectiveFrom: Date; reason: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can propose product configuration changes.");
    const product = await getProduct(tx, p.productCode);
    if (!product || product.workflow !== "RETAIL") throw notFound("Retail product not found.");
    const parsed = productConfigSchema.safeParse(p.config);
    if (!parsed.success) throw invalid("The configuration is not valid.", Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message])));
    if ((p.reason ?? "").trim().length < 3) throw invalid("Give a reason for the change.", { reason: "Reason is required." });
    if (!(p.effectiveFrom instanceof Date) || Number.isNaN(p.effectiveFrom.getTime())) throw invalid("Enter a valid effective date.", { effectiveFrom: "Invalid date." });
    const open = await tx.query("SELECT 1 FROM product_configs WHERE product_code = $1 AND status = 'PROPOSED'", [p.productCode]);
    if (open.rowCount) throw conflict("A proposed change is already awaiting approval for this product. Approve, reject or withdraw it first.");
    const next = (await tx.query<{ v: number }>("SELECT coalesce(max(version),0)+1 AS v FROM product_configs WHERE product_code = $1", [p.productCode])).rows[0].v;
    const r = await tx.query<{ id: string }>(
      `INSERT INTO product_configs (product_code, version, status, config, effective_from, reason, proposed_by, proposed_at)
       VALUES ($1,$2,'PROPOSED',$3,$4,$5,$6,$7) RETURNING id`,
      [p.productCode, next, JSON.stringify(parsed.data), p.effectiveFrom, p.reason.trim(), actor.staffId, ctx.now],
    );
    await audit(tx, ctx, { action: "PRODUCT_CONFIG_PROPOSED", actorRole: "SUPER_ADMIN", details: { productCode: p.productCode, version: next, configId: r.rows[0].id, effectiveFrom: p.effectiveFrom.toISOString(), reason: p.reason.trim(), gaps: configGaps(parsed.data).map((g) => g.key) } });
    return { id: r.rows[0].id, version: next };
  });
}

/** A different person holding PRODUCT_CONFIG_APPROVER approves or rejects (checker). */
export async function decideProductConfig(ctx: Ctx, p: { configId: string; approve: boolean; note: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    const row = (await tx.query<ProductConfigRow>("SELECT * FROM product_configs WHERE id = $1 FOR UPDATE", [p.configId])).rows[0];
    if (!row) throw notFound();
    if (row.status !== "PROPOSED") throw conflict("This configuration has already been decided.");
    const isOwner = row.proposed_by === actor.staffId;
    if (!p.approve && isOwner) {
      // The proposer may withdraw their own proposal.
      await tx.query("UPDATE product_configs SET status = 'WITHDRAWN', decided_by = $2, decided_at = $3, decision_note = $4 WHERE id = $1", [row.id, actor.staffId, ctx.now, p.note || "Withdrawn by proposer"]);
      await audit(tx, ctx, { action: "PRODUCT_CONFIG_WITHDRAWN", details: { productCode: row.product_code, version: row.version } });
      return { status: "WITHDRAWN" as const };
    }
    if (!(await holdsRole(tx, actor.staffId, "PRODUCT_CONFIG_APPROVER"))) throw forbidden("Only a product configuration approver can decide on configuration changes.");
    if (isOwner) throw forbidden("The person who proposed a configuration change cannot approve it.");
    if (!p.approve && (p.note ?? "").trim().length < 3) throw invalid("Give a reason for rejecting the change.", { note: "Reason required." });
    const status = p.approve ? "APPROVED" : "REJECTED";
    await tx.query("UPDATE product_configs SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5 WHERE id = $1", [row.id, status, actor.staffId, ctx.now, (p.note ?? "").trim() || null]);
    await audit(tx, ctx, { action: p.approve ? "PRODUCT_CONFIG_APPROVED" : "PRODUCT_CONFIG_REJECTED", actorRole: "PRODUCT_CONFIG_APPROVER", reason: p.note || null, details: { productCode: row.product_code, version: row.version, configId: row.id, effectiveFrom: new Date(row.effective_from).toISOString() } });
    return { status };
  });
}

/** Activate / deactivate a product for new initiation (existing cases are unaffected). */
export async function setProductActive(ctx: Ctx, code: string, active: boolean) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden();
    const r = await tx.query("UPDATE products SET active = $2, updated_by = $3, updated_at = $4 WHERE code = $1 RETURNING code", [code, active, actor.staffId, ctx.now]);
    if (!r.rowCount) throw notFound();
    await audit(tx, ctx, { action: active ? "PRODUCT_ACTIVATED" : "PRODUCT_DEACTIVATED", actorRole: "SUPER_ADMIN", details: { productCode: code } });
  });
}

export function profileRules(cfg: ProductConfig, profile: string | null | undefined): ProfileRules | null {
  if (!profile) return null;
  const r = cfg.profiles[profile as CustomerProfile];
  return r && r.enabled ? r : null;
}

export function structureRules(rules: ProfileRules | null, code: string | null | undefined): StructureRules | null {
  if (!rules || !code) return null;
  return rules.structures.find((s) => s.code === code) ?? null;
}

export function eligibleApplicantType(rules: ProfileRules, type: ApplicantType) {
  return rules.eligibleApplicantTypes.includes(type);
}

export function roleLabel(r: string | null | undefined) {
  return r ? (ROLE_LABELS[r as Role] ?? r) : "not configured";
}

export type { Tx };
