/**
 * Retail application data (Vendor Financing, Alt Drive, Alt Power) stored in application_versions.data.
 * Money is integer kobo, identifiers are strings (leading zeros preserved).
 */
import { z } from "zod";
import { createHash } from "node:crypto";

const text = (max = 200) => z.string().trim().max(max);
const koboN = z.number().int().nonnegative().nullable();

export const PHONE_RE = /^\d{11}$/;
export const NUBAN_RE = /^\d{10}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function phoneError(v: string, label = "Phone number"): string | null {
  if (!v) return null;
  if (!/^\d*$/.test(v)) return `${label} must contain digits only.`;
  if (v.length !== 11) return `${label} must be exactly 11 digits (for example 08031234567); ${v.length} entered.`;
  return null;
}
export function bvnError(v: string, label = "BVN"): string | null {
  if (!v) return null;
  if (!/^\d*$/.test(v)) return `${label} must contain digits only.`;
  if (v.length !== 11) return `${label} must be exactly 11 digits; ${v.length} entered.`;
  return null;
}

export const obligationSchema = z.object({
  lender: text(120),
  facilityType: text(80).default(""),
  monthlyRepaymentKobo: z.number().int().nonnegative(),
  outstandingKobo: z.number().int().nonnegative().nullable().default(null),
});
export type Obligation = z.infer<typeof obligationSchema>;

export const salaryMonthSchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), amountKobo: z.number().int().nonnegative() });

export const retailDataSchema = z.object({
  // Customer
  customerName: text().default(""),
  businessName: text().default(""),
  companyName: text().default(""),
  registrationNumber: text(50).default(""),
  phone: text(11).default(""),
  email: text(120).default(""),
  businessAddress: text(300).default(""),
  deliveryAddress: text(300).default(""),
  // Employment (salary earners)
  employerName: text(160).default(""),
  employmentConfirmationRef: text(80).default(""),
  jobTitle: text(120).default(""),
  employmentStartDate: text(10).default(""),
  statedMonthlySalaryKobo: koboN.default(null),
  salaryHistory: z.array(salaryMonthSchema).max(36).default([]),
  // Business (business owners)
  businessSector: text(120).default(""),
  yearsInOperation: z.number().int().min(0).max(200).nullable().default(null),
  statedMonthlyTurnoverKobo: koboN.default(null),
  // Facility
  requestedAmountKobo: z.number().int().nullable().default(null),
  tenorMonths: z.number().int().nullable().default(null),
  purpose: text(500).default(""),
  assetDescription: text(300).default(""),
  assetCostKobo: koboN.default(null),
  equityContributionKobo: koboN.default(null),
  // Obligations + preliminary affordability
  existingObligations: z.array(obligationSchema).max(30).default([]),
  incomeBasisKobo: koboN.default(null),
  incomeBasisNote: text(300).default(""),
  proposedMonthlyObligationKobo: koboN.default(null),
  turnoverForCapKobo: koboN.default(null),
  // Vendor / beneficiary
  vendorId: z.string().uuid().nullable().default(null),
  vendorAccountId: z.string().uuid().nullable().default(null),
  // Channel
  assignedRmId: z.string().uuid().nullable().default(null),
  outletLocationId: z.string().uuid().nullable().default(null),
  // Separately configured privacy / data-access permissions
  consents: z.array(z.object({ code: z.string(), granted: z.boolean(), recordedAt: z.string().nullable().default(null) })).max(20).default([]),
});
export type RetailData = z.infer<typeof retailDataSchema>;

export function retailDisplayName(type: string, d: Pick<RetailData, "customerName" | "businessName" | "companyName">): string {
  if (type === "LIMITED") return d.companyName || "(company name pending)";
  if (type === "ENTERPRISE") return d.customerName && d.businessName ? `${d.customerName} trading as ${d.businessName}` : d.customerName || d.businessName || "(name pending)";
  return d.customerName || "(name pending)";
}

export function totalExistingObligationsKobo(d: Pick<RetailData, "existingObligations">): number {
  return d.existingObligations.reduce((s, o) => s + o.monthlyRepaymentKobo, 0);
}

/**
 * Digest of retail underwriting ("material") fields. A change requires reassessment and invalidates the
 * business and credit approvals and any offer: principal, tenor, structure, rate (via structure and the
 * pinned configuration), repayment capacity (income basis, obligations, proposed obligation), vendor and
 * beneficiary, customer identity, applicant type, product and profile.
 */
export function retailMaterialDigest(m: {
  productCode: string;
  profile: string | null;
  structure: string | null;
  applicantType: string;
  data: RetailData;
  bvnPlain: string | null;
  tinPlain: string | null;
  directors: { fullName: string; bvnPlain: string }[];
  beneficiary: { accountId: string; institutionCode: string; accountNumber: string } | null;
}): string {
  const d = m.data;
  const p = {
    product: m.productCode,
    profile: m.profile,
    structure: m.structure,
    type: m.applicantType,
    names: [d.customerName, d.businessName, d.companyName, d.registrationNumber],
    amount: d.requestedAmountKobo,
    tenor: d.tenorMonths,
    asset: [d.assetDescription, d.assetCostKobo, d.equityContributionKobo],
    capacity: [d.incomeBasisKobo, d.proposedMonthlyObligationKobo, d.turnoverForCapKobo, d.existingObligations.map((o) => [o.lender, o.monthlyRepaymentKobo])],
    vendor: d.vendorId,
    beneficiary: m.beneficiary,
    bvn: m.bvnPlain,
    tin: m.tinPlain,
    directors: m.directors.map((x) => [x.fullName, x.bvnPlain]),
  };
  return createHash("sha256").update(JSON.stringify(p)).digest("hex");
}

/** Which fields changed between two versions (for the reassessment notice). */
export function materialChanges(a: RetailData, b: RetailData): string[] {
  const out: string[] = [];
  if (a.requestedAmountKobo !== b.requestedAmountKobo) out.push("principal");
  if (a.tenorMonths !== b.tenorMonths) out.push("tenor");
  if (a.vendorId !== b.vendorId) out.push("vendor");
  if (a.vendorAccountId !== b.vendorAccountId) out.push("beneficiary account");
  if (a.incomeBasisKobo !== b.incomeBasisKobo || a.proposedMonthlyObligationKobo !== b.proposedMonthlyObligationKobo || JSON.stringify(a.existingObligations) !== JSON.stringify(b.existingObligations)) out.push("repayment capacity");
  if (a.assetCostKobo !== b.assetCostKobo || a.assetDescription !== b.assetDescription) out.push("asset");
  return out;
}
