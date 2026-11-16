/**
 * Product Settings: shared, database-free helpers used by the configuration screens (inline errors, completeness,
 * "View changes") and by the server (the same checks run again before publication).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Cfg = any;

export interface General {
  name: string;
  description: string;
  owner: string;
  /** null = every role the product type allows. */
  originationRoles: string[] | null;
  active: boolean;
}

export type SectionKey = "general" | "eligibility" | "financing" | "workflow" | "documents" | "controls";
export const SECTIONS: { key: SectionKey; title: string; intro: string }[] = [
  { key: "general", title: "General", intro: "Name, description, availability, who can originate it, owner and effective date." },
  { key: "eligibility", title: "Eligibility & KYC", intro: "Which customers qualify, and the identity, statement and credit-check evidence required." },
  { key: "financing", title: "Financing & Pricing", intro: "Amount limits, tenor, contract structures and pricing, and affordability." },
  { key: "workflow", title: "Approval Workflow", intro: "Which approval chain the product uses, and its approval stages and amount thresholds." },
  { key: "documents", title: "Documentation", intro: "Documents required at each stage, and when conditional documents apply." },
  { key: "controls", title: "Controls & Exceptions", intro: "Operational controls, permitted exceptions and who may approve them." },
];

export const PROFILE_NAMES: Record<string, string> = { SALARY_EARNER: "Salary earners", BUSINESS_OWNER: "Business owners" };
export const APPLICANT_TYPES: [string, string][] = [["INDIVIDUAL", "Individual"], ["ENTERPRISE", "Enterprise (business name)"], ["LIMITED", "Limited company"]];

const kobo = (v: unknown) => {
  if (typeof v !== "number") return "not set";
  const [i, d] = (v / 100).toFixed(2).split(".");
  return `₦${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${d === "00" ? "" : `.${d}`}`;
};
const show = (key: string, v: unknown): string => {
  if (v === null || v === undefined || v === "") return "not set";
  if (/Kobo$/.test(key)) return kobo(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : "none";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

const LABELS: [RegExp, string, SectionKey][] = [
  [/^general\.name$/, "Product name", "general"],
  [/^general\.description$/, "Description", "general"],
  [/^general\.owner$/, "Product owner", "general"],
  [/^general\.originationRoles$/, "Origination roles", "general"],
  [/^general\.active$/, "Open for new applications", "general"],
  [/^draftExpiryDays$/, "Unsubmitted drafts expire after (days)", "general"],
  [/\.enabled$/, "Offered to this customer profile", "eligibility"],
  [/\.eligibleApplicantTypes$/, "Eligible customer types", "eligibility"],
  [/\.eligibilityNote$/, "Eligibility conditions", "eligibility"],
  [/\.statementMonths$/, "Bank statement period (months)", "eligibility"],
  [/\.payslipMonths$/, "Payslip / salary history (months)", "eligibility"],
  [/\.statementMaxAgeDays$/, "Statement recency (days)", "eligibility"],
  [/\.assetEligibility\.required$/, "Asset eligibility check", "eligibility"],
  [/\.assetEligibility\.criteria$/, "Asset eligibility criteria", "eligibility"],
  [/^privacyConsents/, "Customer consents", "eligibility"],
  [/\.minAmountKobo$/, "Minimum financing amount", "financing"],
  [/\.maxAmountKobo$/, "Maximum financing amount", "financing"],
  [/\.minTenorMonths$/, "Minimum tenor (months)", "financing"],
  [/\.maxTenorMonths$/, "Maximum tenor (months)", "financing"],
  [/\.structures\.([A-Z_]+)\.ratePercent$/, "rate (%)", "financing"],
  [/\.structures\.([A-Z_]+)\.rateConvention$/, "rate convention", "financing"],
  [/\.structures\.([A-Z_]+)\.insuranceBearer$/, "insurance", "financing"],
  [/\.structures\.([A-Z_]+)\.contractSequence$/, "contract steps", "financing"],
  [/\.structures\.([A-Z_]+)\.label$/, "label", "financing"],
  [/\.structures\.([A-Z_]+)$/, "contract structure", "financing"],
  [/\.dsr\.maxPercent$/, "Maximum DSR (%)", "financing"],
  [/\.dsr\.denominator$/, "DSR income basis", "financing"],
  [/\.dsr\.inflowRecognitionPercent$/, "Income recognised for affordability (%)", "financing"],
  [/\.equityContribution\.applies$/, "Equity contribution applies", "financing"],
  [/\.equityContribution\.minPercent$/, "Minimum equity (%)", "financing"],
  [/\.principalTurnoverCap\.applies$/, "Principal-to-turnover cap applies", "financing"],
  [/\.principalTurnoverCap\.maxPercent$/, "Principal-to-turnover cap (%)", "financing"],
  [/^beneficiaryRequired$/, "Beneficiary from the approved vendor register", "financing"],
  [/^fulfilmentSteps$/, "After-payment fulfilment steps", "financing"],
  [/^approvalPolicy$/, "Approval chain", "workflow"],
  [/^businessReview\.headOfUnitStage$/, "Head of Unit stage", "workflow"],
  [/\.documents$/, "Required documents", "documents"],
  [/\.structures$/, "Contract structures", "financing"],
  [/\.documents\.([A-Z_]+)$/, "document", "documents"],
  [/\.documents\.([A-Z_]+)\.(\w+)$/, "document rule", "documents"],
  [/\.businessPhotos\.minDistinct$/, "Business photographs (distinct angles)", "documents"],
  [/\.businessPhotos\.rmPhotoRequired$/, "Photograph of the RM at the business", "documents"],
  [/\.rmProposalRequired$/, "RM credit proposal required", "documents"],
  [/\.dsr\.exceptionAllowed$/, "DSR exceptions permitted", "controls"],
  [/\.dsr\.exceptionApproverRole$/, "DSR exception authority", "controls"],
  [/\.afs\.thresholdKobo$/, "Audited accounts required above", "controls"],
  [/\.afs\.exceptionApproverRole$/, "Audited accounts exception authority", "controls"],
  [/\.afs$/, "Audited accounts rule", "controls"],
  [/\.visitRequired$/, "Management visit required", "controls"],
  [/^servicing\.restructureApproverRole$/, "Restructuring authority", "controls"],
];

export function describePath(path: string): { label: string; section: SectionKey } {
  const prof = /^profiles\.(\w+)\./.exec(path)?.[1];
  for (const [re, label, section] of LABELS) {
    const m = re.exec(path);
    if (m) {
      const sub = m[1] && /structures|documents/.test(path) ? `${m[1]} ` : "";
      return { label: `${prof ? `${PROFILE_NAMES[prof] ?? prof}: ` : ""}${sub}${label}`, section };
    }
  }
  return { label: path, section: "controls" };
}

/** Flatten a configuration into path → value. Structures and documents are keyed by their code, not position. */
export function flatten(x: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(x)) {
    if (x.length && x.every((e) => e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string")) {
      for (const e of x as { code: string }[]) flatten(e, `${prefix}.${e.code}`, out);
      if (!x.length) out[prefix] = [];
    } else out[prefix] = x;
    return out;
  }
  if (x && typeof x === "object") {
    for (const [k, v] of Object.entries(x)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out[prefix] = x;
  return out;
}

export interface Change {
  path: string;
  section: SectionKey;
  label: string;
  from: string;
  to: string;
}

/** Human-readable differences between two (config, general) pairs. */
export function diffSettings(a: { config: Cfg; general?: Partial<General> | null }, b: { config: Cfg; general?: Partial<General> | null }): Change[] {
  const fa = flatten({ ...a.config, general: a.general ?? {} });
  const fb = flatten({ ...b.config, general: b.general ?? {} });
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
  const out: Change[] = [];
  for (const k of keys) {
    const x = JSON.stringify(fa[k] ?? null);
    const y = JSON.stringify(fb[k] ?? null);
    if (x === y) continue;
    if (k.startsWith("general.") && (b.general === undefined || b.general === null)) continue;
    const leaf = k.split(".").pop()!;
    const d = describePath(k);
    out.push({ path: k, section: d.section, label: d.label, from: show(leaf, fa[k]), to: show(leaf, fb[k]) });
  }
  return out;
}

const blank = (v: unknown) => v === null || v === undefined || v === "";
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Checks that must pass before Publish Product Rules (errors keyed by field path), plus warnings for steps that
 * stay blocked until configured. Database checks (known contract types, workflow, approver availability) run on the
 * server in addition.
 */
export function publishChecks(cfg: Cfg, general: General, opts: { ceiling: readonly string[]; knownDocuments: readonly string[] }) {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];
  if ((general.name ?? "").trim().length < 2) errors["general.name"] = "Enter the product name.";
  if (general.originationRoles !== null) {
    if (!general.originationRoles.length) errors["general.originationRoles"] = "Choose at least one role that may originate this product.";
    const bad = general.originationRoles.filter((r) => !opts.ceiling.includes(r));
    if (bad.length) errors["general.originationRoles"] = `This product cannot be originated by: ${bad.join(", ")}.`;
  }
  const profiles = Object.entries(cfg?.profiles ?? {}).filter(([, r]: [string, any]) => r?.enabled) as [string, any][];
  if (!profiles.length) errors["profiles"] = "Offer the product to at least one customer profile.";
  for (const [p, r] of profiles) {
    const at = (k: string) => `profiles.${p}.${k}`;
    if (!r.eligibleApplicantTypes?.length) errors[at("eligibleApplicantTypes")] = "Choose at least one eligible customer type.";
    const min = num(r.minAmountKobo);
    const max = num(r.maxAmountKobo);
    if (max === null) errors[at("maxAmountKobo")] = "Enter the maximum financing amount.";
    if (min !== null && max !== null && min >= max) errors[at("minAmountKobo")] = "The minimum must be below the maximum.";
    if (num(r.maxTenorMonths) === null) errors[at("maxTenorMonths")] = "Enter the maximum tenor.";
    if (num(r.minTenorMonths) !== null && num(r.maxTenorMonths) !== null && r.minTenorMonths > r.maxTenorMonths) errors[at("minTenorMonths")] = "The minimum tenor cannot exceed the maximum.";
    if (!r.structures?.length) errors[at("structures")] = "Add at least one contract structure with its pricing.";
    for (const s of r.structures ?? []) {
      if (blank(s.ratePercent)) errors[at(`structures.${s.code}.ratePercent`)] = "Enter the rate.";
      if (blank(s.rateConvention)) errors[at(`structures.${s.code}.rateConvention`)] = "Choose how the rate is applied (approved calculation method).";
      if (blank(s.insuranceBearer)) errors[at(`structures.${s.code}.insuranceBearer`)] = "Choose who bears the insurance cost.";
    }
    if (blank(r.dsr?.maxPercent)) errors[at("dsr.maxPercent")] = "Enter the maximum DSR.";
    if (blank(r.dsr?.denominator)) errors[at("dsr.denominator")] = "Choose the income basis for DSR.";
    if (r.dsr?.exceptionAllowed && blank(r.dsr?.exceptionApproverRole)) errors[at("dsr.exceptionApproverRole")] = "Choose who may approve DSR exceptions.";
    if (r.equityContribution?.applies && blank(r.equityContribution?.minPercent)) errors[at("equityContribution.minPercent")] = "Enter the minimum equity.";
    if (r.principalTurnoverCap?.applies && blank(r.principalTurnoverCap?.maxPercent)) errors[at("principalTurnoverCap.maxPercent")] = "Enter the cap.";
    if (r.assetEligibility?.required && blank(r.assetEligibility?.criteria)) errors[at("assetEligibility.criteria")] = "Describe the asset eligibility criteria.";
    const docs = (r.documents ?? []) as { code: string; requirement: string; stage: string; coverageFrom?: string | null }[];
    if (!docs.some((d) => d.requirement === "MANDATORY" && d.stage === "SUBMISSION")) errors[at("documents")] = "Add at least one mandatory document for submission.";
    const unknown = docs.filter((d) => !opts.knownDocuments.includes(d.code)).map((d) => d.code);
    if (unknown.length) errors[at("documents")] = `Unknown document type: ${unknown.join(", ")}.`;
    if (docs.some((d) => d.coverageFrom === "statementMonths" || d.code === "BANK_STATEMENT") && num(r.statementMonths) === null) errors[at("statementMonths")] = "Enter the bank statement period: a required document depends on it.";
    if (docs.some((d) => d.coverageFrom === "payslipMonths" || d.code === "PAYSLIP") && num(r.payslipMonths) === null) errors[at("payslipMonths")] = "Enter the payslip period: a required document depends on it.";
    if (r.afs && num(r.afs.thresholdKobo) !== null && blank(r.afs.exceptionApproverRole)) warnings.push(`${PROFILE_NAMES[p] ?? p}: no authority is set for audited-accounts exceptions, so none can be requested.`);
    if (r.visitRequired === null) warnings.push(`${PROFILE_NAMES[p] ?? p}: management visit requirement is not set; Team Lead review stays blocked until it is.`);
  }
  if (cfg?.approvalPolicy !== "RETAIL_CX_V1" && blank(cfg?.businessReview?.headOfUnitStage)) errors["businessReview.headOfUnitStage"] = "Choose whether the Head of Unit approves as a separate stage.";
  if (blank(cfg?.servicing?.restructureApproverRole)) warnings.push("No restructuring authority is set, so restructures cannot be approved.");
  return { errors, warnings };
}

/** Configuration completeness for the indicator: the share of required settings filled in. */
export function completeness(cfg: Cfg, general: General, opts: { ceiling: readonly string[]; knownDocuments: readonly string[] }) {
  const { errors } = publishChecks(cfg, general, opts);
  const profiles = Object.values(cfg?.profiles ?? {}).filter((r: any) => r?.enabled).length || 1;
  const total = 3 + profiles * 9;
  const missing = Math.min(total, Object.keys(errors).length);
  return { percent: Math.round(((total - missing) / total) * 100), missing };
}

/** Sections that contain at least one error. */
export function sectionsWithErrors(errors: Record<string, string>): Set<SectionKey> {
  return new Set(Object.keys(errors).map((k) => (k === "profiles" ? "eligibility" : describePath(k).section)));
}

/** A customer profile with every policy value left for the administrator to set (only structural defaults). */
export function blankProfile(types: string[]): Cfg {
  return {
    enabled: true,
    eligibleApplicantTypes: types,
    eligibilityNote: null,
    minAmountKobo: null,
    maxAmountKobo: null,
    maxTenorMonths: null,
    minTenorMonths: null,
    structures: [],
    dsr: { maxPercent: null, denominator: null, inflowRecognitionPercent: "100", exceptionAllowed: false, exceptionApproverRole: null },
    principalTurnoverCap: { applies: false, maxPercent: null },
    statementMonths: null,
    payslipMonths: null,
    statementMaxAgeDays: null,
    equityContribution: { applies: false, minPercent: null },
    assetEligibility: { required: false, criteria: null },
    visitRequired: null,
    rmProposalRequired: false,
    businessPhotos: { minDistinct: 0, rmPhotoRequired: false },
    afs: null,
    documents: [],
  };
}
export const DEFAULT_TYPES: Record<string, string[]> = { SALARY_EARNER: ["INDIVIDUAL"], BUSINESS_OWNER: ["ENTERPRISE", "LIMITED"] };

export type SettingsStatusKey = "NOT_SET_UP" | "DRAFT" | "PUBLISHED" | "INCOMPLETE" | "SCHEDULED" | "CLOSED";
export const STATUS: Record<SettingsStatusKey, { label: string; cls: string }> = {
  NOT_SET_UP: { label: "Not set up", cls: "badge badge-warn" },
  DRAFT: { label: "Draft in progress", cls: "badge badge-blue" },
  PUBLISHED: { label: "Published", cls: "badge badge-green" },
  INCOMPLETE: { label: "Published, incomplete", cls: "badge badge-warn" },
  SCHEDULED: { label: "Scheduled", cls: "badge badge-blue" },
  CLOSED: { label: "Closed to new applications", cls: "badge" },
};
