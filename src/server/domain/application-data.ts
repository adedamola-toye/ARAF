import { z } from "zod";
import { createHash } from "node:crypto";
import { isValidDateString, lagosDate } from "../time";

export const APPLICANT_TYPES = ["INDIVIDUAL", "ENTERPRISE", "LIMITED"] as const;
export type ApplicantType = (typeof APPLICANT_TYPES)[number];
export const APPLICANT_TYPE_LABELS: Record<ApplicantType, string> = {
  INDIVIDUAL: "Individual",
  ENTERPRISE: "Enterprise",
  LIMITED: "Limited",
};

const text = (max = 200) => z.string().trim().max(max);

export const itemSchema = z.object({
  description: text(200),
  quantity: z.number().int().nonnegative(),
  unitCostKobo: z.number().int().nonnegative(),
});

/** Non-sensitive application fields stored in application_versions.data (jsonb). */
export const draftDataSchema = z.object({
  customerName: text().default(""), // Individual: customer name. Enterprise: proprietor legal name.
  businessName: text().default(""), // Enterprise: registered business name
  companyName: text().default(""), // Limited: company name
  registrationNumber: text(50).default(""), // CAC BN / RC number
  phone: text(30).default(""),
  email: text(120).default(""),
  address: text(300).default(""),
  requestedAmountKobo: z.number().int().nullable().default(null),
  daoCode: text(30).default(""),
  posSerial: text(60).default(""),
  tenorMonths: z.number().int().nullable().default(null),
  items: z.array(itemSchema).max(100).default([]),
  supplierName: text().default(""),
  supplierAddress: text(300).default(""),
  supplierPhone: text(30).default(""),
  supplierAccount: text(60).default(""),
  invoiceRef: text(80).default(""),
  rentStart: text(10).default(""),
  rentEnd: text(10).default(""),
  statementsCover12Months: z.boolean().default(false),
  rbeId: z.string().uuid().nullable().default(null),
});
export type DraftData = z.infer<typeof draftDataSchema>;

export interface DirectorInput {
  fullName: string;
  bvn: string; // plaintext only while in transit; persisted encrypted
}

export interface SensitiveInput {
  bvn?: string | null;
  tin?: string | null;
  directors?: DirectorInput[];
}

export function assetCostKobo(items: DraftData["items"]): number {
  return items.reduce((s, i) => s + i.quantity * i.unitCostKobo, 0);
}

export function displayCustomerName(type: ApplicantType, d: Pick<DraftData, "customerName" | "businessName" | "companyName">): string {
  if (type === "LIMITED") return d.companyName || "(company name pending)";
  if (type === "ENTERPRISE") {
    return d.customerName && d.businessName ? `${d.customerName} trading as ${d.businessName}` : d.customerName || d.businessName || "(name pending)";
  }
  return d.customerName || "(name pending)";
}

export const BVN_RE = /^\d{11}$/;
export const TIN_RE = /^[0-9]{8,14}(-[0-9]{4})?$/;

/** Required documents at submission by applicant type. */
export function requiredSubmissionDocuments(type: ApplicantType): string[] {
  const base = ["BANK_STATEMENT", "SUPPLIER_INVOICE", "APPLICATION_FORM", "CONSENT_FORM", "RENT_RECEIPT"];
  return type === "INDIVIDUAL" ? base : [...base, "CAC_CERTIFICATE"];
}

export interface SubmissionCheckInput {
  type: ApplicantType;
  initiatorRole: string;
  data: DraftData;
  hasBvn: boolean;
  hasTin: boolean;
  directors: { fullName: string; hasBvn: boolean }[];
  currentDocumentCategories: string[];
  now: Date;
}

/**
 * Full submission validation. Returns a map of field -> message (empty when valid).
 * Rental coverage is checked against the dates entered by the officer, in Lagos time.
 */
export function validateForSubmission(i: SubmissionCheckInput): Record<string, string> {
  const e: Record<string, string> = {};
  const d = i.data;
  if (i.type === "INDIVIDUAL" && !d.customerName) e.customerName = "Customer name is required.";
  if (i.type === "ENTERPRISE") {
    if (!d.customerName) e.customerName = "Proprietor legal name is required.";
    if (!d.businessName) e.businessName = "Registered business name is required.";
  }
  if (i.type === "LIMITED" && !d.companyName) e.companyName = "Company name is required.";
  if (i.type !== "INDIVIDUAL" && !d.registrationNumber) e.registrationNumber = "CAC registration number is required.";
  if (!d.phone) e.phone = "Customer phone number is required.";
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) e.email = "Customer email is not valid.";
  if (d.requestedAmountKobo === null) e.requestedAmountKobo = "Requested amount is required.";
  if (!d.daoCode) e.daoCode = "DAO code is required.";
  if (!d.posSerial) e.posSerial = "POS serial number is required.";
  if (!d.tenorMonths || d.tenorMonths < 1 || d.tenorMonths > 60) e.tenorMonths = "Tenor must be between 1 and 60 months.";
  if (d.items.length === 0) e.items = "Add at least one item to finance.";
  else if (d.items.some((it) => !it.description || it.quantity < 1 || it.unitCostKobo < 1))
    e.items = "Each item needs a description, quantity of at least 1 and a unit cost.";
  if (!d.supplierName) e.supplierName = "Supplier name is required.";
  if (!d.invoiceRef) e.invoiceRef = "Invoice reference is required.";
  if (!d.statementsCover12Months) e.statementsCover12Months = "Confirm the statements cover the last 12 months.";

  // Rental coverage (Lagos business date)
  if (!isValidDateString(d.rentStart)) e.rentStart = "Enter a valid rental coverage start date.";
  if (!isValidDateString(d.rentEnd)) e.rentEnd = "Enter a valid rental coverage end date.";
  if (!e.rentStart && !e.rentEnd) {
    const today = lagosDate(i.now);
    if (d.rentEnd < d.rentStart) e.rentEnd = "Rental coverage end date must be on or after the start date.";
    else if (d.rentStart > today) e.rentStart = "Rental coverage has not started yet (Lagos time).";
    else if (d.rentEnd < today) e.rentEnd = "Rental coverage has expired (Lagos time).";
  }

  // Restricted identifiers
  if (i.type !== "LIMITED" && !i.hasBvn) e.bvn = "BVN is required.";
  if (i.type !== "INDIVIDUAL" && !i.hasTin) e.tin = "TIN is required.";
  if (i.type === "LIMITED") {
    if (i.directors.length === 0) e.directors = "Add every director with their BVN.";
    else if (i.directors.some((x) => !x.fullName || !x.hasBvn)) e.directors = "Each director needs a full name and an 11-digit BVN.";
  }

  if (i.initiatorRole === "RM" && !d.rbeId) e.rbeId = "Select the Regional Business Executive.";

  for (const cat of requiredSubmissionDocuments(i.type)) {
    if (!i.currentDocumentCategories.includes(cat)) e[`doc_${cat}`] = `Upload the required document: ${cat.replace(/_/g, " ").toLowerCase()}.`;
  }
  return e;
}

export interface MaterialProjectionInput {
  type: ApplicantType;
  data: DraftData;
  bvnPlain: string | null;
  tinPlain: string | null;
  directors: { fullName: string; bvnPlain: string }[];
}

/**
 * Digest of underwriting ("material") fields. A change in this digest between submitted
 * versions requires a fresh credit review and invalidates approvals on superseded information.
 * Contact details, DAO code, POS serial, rental dates and the selected RBE are non-material.
 */
export function materialDigest(m: MaterialProjectionInput): string {
  const p = {
    type: m.type,
    customerName: m.data.customerName,
    businessName: m.data.businessName,
    companyName: m.data.companyName,
    registrationNumber: m.data.registrationNumber,
    amount: m.data.requestedAmountKobo,
    tenor: m.data.tenorMonths,
    items: m.data.items,
    assetCost: assetCostKobo(m.data.items),
    supplier: m.data.supplierName,
    invoiceRef: m.data.invoiceRef,
    bvn: m.bvnPlain,
    tin: m.tinPlain,
    directors: m.directors.map((x) => [x.fullName, x.bvnPlain]),
  };
  return createHash("sha256").update(JSON.stringify(p)).digest("hex");
}
