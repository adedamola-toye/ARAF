/**
 * Retail Asset Factory workflow (Vendor Financing, Alt Drive, Alt Power) built on the shared engine.
 *
 *   DRAFT → [OSS_REVIEW (Delight Officer route)] → TEAM_LEAD_REVIEW → HRS_REVIEW → [HEAD_OF_UNIT_APPROVAL]
 *     → FIRST_CREDIT_REVIEW → SECOND_CREDIT_REVIEW → UNIT_HEAD_REVIEW → DIVISIONAL_HEAD_REVIEW
 *     → OFFER_PREPARATION → CO3_PACK_REVIEW → DISBURSEMENT_CHECK → DISBURSEMENT_BOOKING (facility booked)
 *     → PAYMENT_RECONCILIATION (payment confirmed with evidence and reconciled) → COMPLETION → FULFILMENT → COMPLETED
 *
 * Business review routes are configured independently of credit appraisal. Every transition runs inside the
 * caller's transaction (see workflow.ts) with idempotency, row locks and lock_version.
 */
import type { Db, Tx } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { decryptField, encryptField, hmac } from "../crypto";
import { DomainError, conflict, forbidden, gate, invalid, notFound } from "../errors";
import { last4 } from "../mask";
import { formatKobo } from "../money";
import { lagosDate } from "../time";
import { enqueueEmail } from "../notify/outbox";
import { caseLink, simpleEmail } from "../notify/templates";
import { PLATFORM_NAME, RETAIL_REF_PREFIX } from "../brand";
import { TIN_RE, type ApplicantType } from "./application-data";
import { holdsRole } from "./access";
import { chooseAssignee, type AppRow } from "./assignment";
import { currentCleanDocuments, listDocuments } from "./documents";
import { checkPhotos, evaluateMatrix, type MatrixItem, type PhotoCheck } from "./doc-matrix";
import { computeAffordability, rulesSnapshot, type AffordabilityInput, type AffordabilityOutput } from "./affordability";
import { configById, configGaps, effectiveConfig, getProduct, gapsBlocking, profileRules, structureRules, type ConfigGap, type ProductConfigRow, type ProfileRules } from "./products";
import { bvnError, phoneError, EMAIL_RE, retailDataSchema, retailDisplayName, retailMaterialDigest, type RetailData } from "./retail-data";
import { beneficiaryFor, beneficiaryProblems, type BeneficiarySnapshot } from "./vendors";
import { listLocations, snapshotOf, type LocationRow } from "./locations";
import { isRetailInitiatorRole, ROLE_LABELS, type Role } from "./roles";
import { routeForAmount } from "./routing";
import { STAGE_LABELS, type Stage } from "./stages";
import { recordRequestLedger, noteLatestRequestedAmount } from "./wallet";
import { retailCreditBlockers } from "./retail-credit";
import {
  activeCorrection,
  completeTask,
  ensureWorkingVersion,
  assertCanEdit,
  lockApp,
  moveTo,
  persistApp,
  recordDecision,
  resolveAllCorrections,
  resolveCorrection,
  returnToInitiator,
  staffEmail,
  workingVersion,
  type ActionResult,
  type TaskActionInput,
  type TaskRow,
  type VersionRow,
  type DirectorFormRow,
} from "./workflow";
import { bookFacility, reconcilePayment, completeFulfilment, beneficiaryRevalidation } from "./retail-ops";

// ------------------------------------------------------------------ drafts

export async function createRetailDraft(ctx: Ctx, p: { initiatorRole: string; productCode: string; profile: string; structure?: string | null; applicantType: ApplicantType }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!isRetailInitiatorRole(p.initiatorRole)) throw invalid("Retail products are initiated by Relationship Managers and Delight Officers.");
  return withTx(async (tx) => {
    const ra = (
      await tx.query(
        `SELECT ra.region, ra.business_unit, ra.team FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id
          WHERE ra.staff_id = $1 AND ra.role = $2 AND ra.active AND s.status = 'ACTIVE'`,
        [actor.staffId, p.initiatorRole],
      )
    ).rows[0];
    // The provisioned role decides what the user may do; choosing a role on screen grants nothing.
    if (!ra) throw forbidden("You do not hold the selected initiator role.");
    const product = await getProduct(tx, p.productCode);
    if (!product || product.workflow !== "RETAIL") throw invalid("Choose a product from the catalogue.", { productCode: "Choose a product." });
    if (!product.active) throw invalid(`${product.name} is not open for new applications.`, { productCode: "Product inactive." });
    const cfg = await effectiveConfig(tx, product.code, ctx.now);
    if (!cfg) throw gate(`${product.name} has no approved configuration yet.`);
    const rules = profileRules(cfg.config, p.profile);
    if (!rules) throw invalid(`${product.name} is not available for this customer profile.`, { profile: "Profile not eligible for this product." });
    if (!rules.eligibleApplicantTypes.includes(p.applicantType)) {
      throw invalid(`${product.name} (${p.profile === "SALARY_EARNER" ? "salary earners" : "business owners"}) is available only to: ${rules.eligibleApplicantTypes.join(", ").toLowerCase()} customers.`, { applicantType: "Customer type not eligible." });
    }
    if (p.structure && !rules.structures.some((s) => s.code === p.structure)) throw invalid("Choose a financing structure offered for this product.", { structure: "Structure not offered." });
    const structure = p.structure || (rules.structures.length === 1 ? rules.structures[0].code : null);
    const seq = (await tx.query<{ n: string }>("SELECT nextval('application_ref_seq') AS n")).rows[0].n;
    const ref = `${RETAIL_REF_PREFIX}-${lagosDate(ctx.now).slice(0, 4)}-${String(seq).padStart(6, "0")}`;
    const app = (
      await tx.query<{ id: string }>(
        `INSERT INTO applications (ref, applicant_type, initiator_id, initiator_role, region, business_unit, team, status, stage, created_at, updated_at,
           workflow, product_code, product_label, product_config_id, customer_profile, financing_structure)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT','DRAFT',$8,$8,'RETAIL',$9,$10,$11,$12,$13) RETURNING id`,
        [ref, p.applicantType, actor.staffId, p.initiatorRole, ra.region, ra.business_unit, ra.team, ctx.now, product.code, product.name, cfg.id, p.profile, structure],
      )
    ).rows[0];
    await tx.query(`INSERT INTO application_versions (application_id, version_no, data, created_by, created_at) VALUES ($1,1,$2,$3,$4)`, [app.id, JSON.stringify(retailDataSchema.parse({})), actor.staffId, ctx.now]);
    await audit(tx, ctx, { action: "DRAFT_CREATED", actorRole: p.initiatorRole, applicationId: app.id, stage: "DRAFT", details: { ref, productCode: product.code, profile: p.profile, structure, applicantType: p.applicantType, configVersion: cfg.version } });
    return { id: app.id, ref };
  });
}

export interface RetailDraftInput {
  data: Partial<RetailData>;
  structure?: string | null;
  bvn?: string | null;
  tin?: string | null;
  directors?: DirectorFormRow[];
  expectedLockVersion?: number | null;
}

export async function saveRetailDraft(ctx: Ctx, appId: string, input: RetailDraftInput) {
  if (!ctx.actor) throw forbidden();
  return withTx(async (tx) => {
    const app = await lockApp(tx, appId);
    if (app.workflow !== "RETAIL") throw invalid("This is not a retail application.");
    await assertCanEdit(tx, ctx, app);
    if (input.expectedLockVersion != null && input.expectedLockVersion !== app.lock_version) throw conflict("This request was changed elsewhere. Reload and try again.");
    const v = await ensureWorkingVersion(tx, ctx, app);
    const parsed = retailDataSchema.safeParse({ ...(v.data as object), ...input.data });
    if (!parsed.success) throw invalid("Some fields are not valid.", Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message])));
    const data = parsed.data;
    const errors: Record<string, string> = {};
    const pe = phoneError(data.phone);
    if (pe) errors.phone = pe;
    if (data.email && !EMAIL_RE.test(data.email)) errors.email = "Customer email is not valid.";
    let bvnEnc = v.bvn_enc;
    let bvnL4 = v.bvn_last4;
    let tinEnc = v.tin_enc;
    let tinL4 = v.tin_last4;
    if (input.bvn) {
      const b = input.bvn.replace(/\s/g, "");
      const be = bvnError(b);
      if (be) errors.bvn = be;
      else {
        bvnEnc = encryptField(b);
        bvnL4 = last4(b);
      }
    }
    if (input.tin) {
      const t = input.tin.replace(/\s/g, "");
      if (!TIN_RE.test(t)) errors.tin = "TIN must be 8–14 digits (optionally followed by -NNNN).";
      else {
        tinEnc = encryptField(t);
        tinL4 = last4(t);
      }
    }
    if (app.applicant_type === "LIMITED") {
      bvnEnc = null;
      bvnL4 = null;
    }
    // Structure choice (draft / correction)
    const cfgRow = await draftConfig(tx, app, ctx.now);
    const rules = cfgRow ? profileRules(cfgRow.config, app.customer_profile) : null;
    if (input.structure !== undefined && input.structure !== app.financing_structure) {
      if (input.structure && !rules?.structures.some((s) => s.code === input.structure)) errors.structure = "Choose a structure offered for this product.";
      else app.financing_structure = input.structure || null;
    }
    // Delight Officer channel: originating outlet and explicitly assigned RM
    if (data.outletLocationId) {
      const loc = (await tx.query<LocationRow>("SELECT * FROM locations WHERE id = $1", [data.outletLocationId])).rows[0];
      if (!loc || !loc.active) errors.outletLocationId = "Select an active outlet location.";
      else if (app.stage === "DRAFT") {
        app.outlet_location_id = loc.id;
        app.location_snapshot = snapshotOf(loc, ctx.now) as unknown as Record<string, unknown>;
        if (app.initiator_role === "DELIGHT_OFFICER" && loc.team) app.team = loc.team;
      }
    }
    if (data.assignedRmId) {
      if (data.assignedRmId === app.initiator_id) errors.assignedRmId = "Select a Relationship Manager other than yourself.";
      else if (!(await holdsRole(tx, data.assignedRmId, "RM"))) errors.assignedRmId = "Select an active Relationship Manager.";
    }
    if (app.initiator_role !== "DELIGHT_OFFICER") data.assignedRmId = null;
    // Directors (limited companies)
    let directorRows: { full_name: string; bvn_enc: string; bvn_last4: string }[] | null = null;
    if (input.directors && app.applicant_type === "LIMITED") {
      const existing = (await tx.query("SELECT * FROM application_directors WHERE version_id = $1", [v.id])).rows;
      directorRows = [];
      input.directors.forEach((d, idx) => {
        const name = (d.fullName ?? "").trim();
        const bvn = (d.bvn ?? "").replace(/\s/g, "");
        if (!name && !bvn) return;
        if (!name) errors[`directors.${idx}.fullName`] = "Director name is required.";
        if (bvn) {
          const be = bvnError(bvn, "Director BVN");
          if (be) errors[`directors.${idx}.bvn`] = be;
          else directorRows!.push({ full_name: name, bvn_enc: encryptField(bvn), bvn_last4: last4(bvn) });
        } else {
          const ex = existing.find((e: { id: string }) => e.id === d.id);
          if (ex) directorRows!.push({ full_name: name, bvn_enc: ex.bvn_enc, bvn_last4: ex.bvn_last4 });
          else errors[`directors.${idx}.bvn`] = "Director BVN is required.";
        }
      });
    }
    if (Object.keys(errors).length) throw invalid("Some fields are not valid.", errors);
    await tx.query(`UPDATE application_versions SET data=$2, bvn_enc=$3, bvn_last4=$4, tin_enc=$5, tin_last4=$6, requested_amount_kobo=$7 WHERE id=$1`, [
      v.id, JSON.stringify(data), bvnEnc, bvnL4, tinEnc, tinL4, data.requestedAmountKobo,
    ]);
    if (directorRows) {
      await tx.query("DELETE FROM application_directors WHERE version_id = $1", [v.id]);
      for (const [i, d] of directorRows.entries()) await tx.query(`INSERT INTO application_directors (version_id, position, full_name, bvn_enc, bvn_last4) VALUES ($1,$2,$3,$4,$5)`, [v.id, i + 1, d.full_name, d.bvn_enc, d.bvn_last4]);
    }
    const previousRm = app.assigned_rm_id;
    if (app.stage === "DRAFT") {
      app.customer_name = retailDisplayName(app.applicant_type, data);
      app.requested_amount_kobo = data.requestedAmountKobo;
      app.assigned_rm_id = data.assignedRmId;
      if (cfgRow) app.product_config_id = cfgRow.id;
    }
    await persistApp(tx, app, ctx.now);
    if (app.assigned_rm_id && app.assigned_rm_id !== previousRm) {
      const email = await staffEmail(tx, app.assigned_rm_id);
      if (email)
        await enqueueEmail(tx, ctx.now, {
          kind: "ASSIGNED_RM",
          dedupeKey: `assigned-rm:${app.id}:${app.assigned_rm_id}`,
          applicationId: app.id,
          to: [email],
          subject: `${PLATFORM_NAME} ${app.ref}: you are the assigned Relationship Manager`,
          text: simpleEmail([
            `${ctx.actor!.name} (Delight Officer) assigned you as the Relationship Manager for ${app.ref} (${app.product_label}).`,
            "Please supply the RM credit proposal, the business-visit evidence and the photograph of you with the business.",
            "",
            `Open the request: ${caseLink(app.id)}`,
          ]),
        });
      await audit(tx, ctx, { action: "ASSIGNED_RM_SET", applicationId: app.id, stage: app.stage, assignmentFrom: previousRm, assignmentTo: app.assigned_rm_id });
    }
    await audit(tx, ctx, { action: "DRAFT_SAVED", actorRole: app.initiator_role, applicationId: app.id, stage: app.stage, details: { versionNo: v.version_no, bvnChanged: !!input.bvn, tinChanged: !!input.tin, structure: app.financing_structure } });
    return { versionId: v.id, savedAt: ctx.now.toISOString() };
  });
}

/** Drafts follow the configuration currently in force; submitted cases keep the version pinned at submission. */
async function draftConfig(q: Db, app: Pick<AppRow, "product_code" | "product_config_id" | "submitted_at" | "stage">, now: Date): Promise<ProductConfigRow | null> {
  if (app.stage === "DRAFT" || !app.product_config_id) return app.product_code ? effectiveConfig(q, app.product_code, now) : null;
  return configById(q, app.product_config_id);
}

// ------------------------------------------------------------------ readiness (what blocks submission)

export interface ProposalContent {
  customerBackground: string;
  financingPurpose: string;
  requestedTerms: string;
  performanceOrEmployment: string;
  obligationsAndRepaymentSource: string;
  assessmentInputs: string;
  vendorAndInvoice: string;
  visitFindings: string;
  risksAndMitigants: string;
  recommendation: string;
}
export const PROPOSAL_FIELDS: { key: keyof ProposalContent; label: string; hint: string }[] = [
  { key: "customerBackground", label: "Customer and business background", hint: "Who the customer is, ownership, years in business or employment history." },
  { key: "financingPurpose", label: "Financing purpose and requested terms", hint: "What is being financed, amount, tenor and structure." },
  { key: "requestedTerms", label: "Justification for the requested facility", hint: "Why this amount and tenor are appropriate." },
  { key: "performanceOrEmployment", label: "Business performance or verified employment", hint: "Turnover trends, margins, or employer and salary verification." },
  { key: "obligationsAndRepaymentSource", label: "Existing obligations and repayment source", hint: "Current facilities and how repayments will be met." },
  { key: "assessmentInputs", label: "DSR and assessment inputs", hint: "Income basis used, statement period and DSR result." },
  { key: "vendorAndInvoice", label: "Vendor and invoice details", hint: "Vendor, invoice or quotation reference and amount." },
  { key: "visitFindings", label: "Visit findings", hint: "What was observed at the business visit (where applicable)." },
  { key: "risksAndMitigants", label: "Risks and mitigants", hint: "Key risks and how they are mitigated." },
  { key: "recommendation", label: "Recommendation", hint: "Your recommendation and any conditions." },
];

export interface Readiness {
  productName: string;
  config: ProductConfigRow | null;
  rules: ProfileRules | null;
  structure: string | null;
  gaps: ConfigGap[];
  blockedBy: ConfigGap[];
  fieldErrors: Record<string, string>;
  matrix: MatrixItem[];
  photos: PhotoCheck | null;
  proposal: { required: boolean; present: boolean; authorId: string | null; requiredAuthorId: string | null; versionNo: number | null; missing: string[] };
  beneficiary: BeneficiarySnapshot | null;
  beneficiaryProblems: string[];
  location: LocationRow | null;
  preliminary: AffordabilityOutput | null;
  dsrException: { status: string } | null;
  exceptions: { id: string; type: string; status: string; reason: string; decision_note: string | null; approver_role: string }[];
  blockers: string[];
  ready: boolean;
}

export async function loadRetailState(q: Db, appId: string) {
  const app = (await q.query<AppRow & { lock_version: number }>("SELECT * FROM applications WHERE id = $1", [appId])).rows[0];
  if (!app) throw notFound();
  const w = await workingVersion(q as Tx, appId);
  const version: VersionRow | null = w ?? (app.current_version_id ? (await q.query<VersionRow>("SELECT * FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0] : null);
  const directors = version ? (await q.query("SELECT * FROM application_directors WHERE version_id = $1 ORDER BY position", [version.id])).rows : [];
  return { app, version, data: retailDataSchema.parse(version?.data ?? {}), directors };
}

export async function retailReadiness(q: Db, appId: string, now: Date): Promise<Readiness> {
  const { app, version, data, directors } = await loadRetailState(q, appId);
  const product = app.product_code ? await getProduct(q, app.product_code) : null;
  const cfg = await draftConfig(q, app, now);
  const rules = cfg ? profileRules(cfg.config, app.customer_profile) : null;
  const structure = app.financing_structure;
  const e: Record<string, string> = {};
  const blockers: string[] = [];
  const gaps = cfg ? configGaps(cfg.config, { profile: app.customer_profile as never, structure, amountKobo: data.requestedAmountKobo }) : [];
  const blockedBy = gapsBlocking(gaps, "SUBMISSION");
  if (!cfg) blockers.push("This product has no approved configuration.");
  if (!rules) blockers.push("The selected customer profile is not enabled for this product.");
  for (const g of blockedBy) blockers.push(`Configuration required: ${g.label}.`);
  blockers.push(...(await retailCreditBlockers(q, appId, now)));

  // --- customer
  const T = app.applicant_type;
  if (T === "INDIVIDUAL" && !data.customerName) e.customerName = "Customer name is required.";
  if (T === "ENTERPRISE") {
    if (!data.customerName) e.customerName = "Proprietor legal name is required.";
    if (!data.businessName) e.businessName = "Registered business name is required.";
  }
  if (T === "LIMITED" && !data.companyName) e.companyName = "Company name is required.";
  if (T !== "INDIVIDUAL" && !data.registrationNumber) e.registrationNumber = "CAC registration number is required.";
  if (!data.phone) e.phone = "Customer phone number is required (11 digits).";
  else {
    const pe = phoneError(data.phone);
    if (pe) e.phone = pe;
  }
  if (data.email && !EMAIL_RE.test(data.email)) e.email = "Customer email is not valid.";
  if (!data.businessAddress) e.businessAddress = app.customer_profile === "SALARY_EARNER" ? "Customer address is required." : "Business address is required.";
  if (T !== "LIMITED" && !version?.bvn_enc) e.bvn = "BVN is required (11 digits).";
  if (T === "LIMITED") {
    if (!directors.length) e.directors = "Add every director with their BVN.";
    else if (directors.some((d: { full_name: string; bvn_enc: string }) => !d.full_name || !d.bvn_enc)) e.directors = "Each director needs a full name and an 11-digit BVN.";
  }
  if (rules && !rules.eligibleApplicantTypes.includes(T)) e.applicantType = `This product and profile is available only to ${rules.eligibleApplicantTypes.join(", ").toLowerCase()} customers${rules.eligibilityNote ? ` (${rules.eligibilityNote})` : ""}.`;

  // --- profile specifics
  if (app.customer_profile === "SALARY_EARNER") {
    if (!data.employerName) e.employerName = "Employer is required.";
    if (!data.statedMonthlySalaryKobo) e.statedMonthlySalaryKobo = "Enter the monthly salary.";
    const need = rules?.payslipMonths ?? 1;
    if (data.salaryHistory.length < need) e.salaryHistory = `Record the salary history for at least ${need} month${need === 1 ? "" : "s"}.`;
  } else if (app.customer_profile === "BUSINESS_OWNER") {
    if (!data.businessSector) e.businessSector = "Enter the business sector.";
    if (!data.statedMonthlyTurnoverKobo) e.statedMonthlyTurnoverKobo = "Enter the average monthly turnover.";
  }

  // --- facility
  if (data.requestedAmountKobo === null || data.requestedAmountKobo <= 0) e.requestedAmountKobo = "Enter the requested amount.";
  else if (rules?.maxAmountKobo != null && data.requestedAmountKobo > rules.maxAmountKobo) e.requestedAmountKobo = `The maximum for this product is ${formatKobo(rules.maxAmountKobo)}.`;
  else {
    try {
      routeForAmount(data.requestedAmountKobo);
    } catch {
      blockers.push(`No credit approval route is configured for ${formatKobo(data.requestedAmountKobo)}. This is an outstanding business decision.`);
    }
  }
  if (!data.tenorMonths || data.tenorMonths < 1) e.tenorMonths = "Enter the tenor in months.";
  else if (rules?.maxTenorMonths != null && data.tenorMonths > rules.maxTenorMonths) e.tenorMonths = `The maximum tenor for this product is ${rules.maxTenorMonths} months.`;
  if (!structure) e.structure = "Choose the financing structure.";
  if (!data.purpose) e.purpose = "Describe the purpose of the financing.";
  const assetProduct = cfg?.config.fulfilmentSteps.some((s) => s !== "POS_DEPLOYMENT") ?? false;
  if (assetProduct) {
    if (!data.assetDescription) e.assetDescription = "Describe the asset or solution being financed.";
    if (!data.assetCostKobo) e.assetCostKobo = "Enter the asset cost.";
    if (!data.deliveryAddress) e.deliveryAddress = "Enter the delivery or installation address.";
  }
  if (rules?.assetEligibility.required && rules.assetEligibility.criteria && !data.assetDescription) e.assetDescription = "Describe the asset against the eligibility criteria.";
  if (rules?.equityContribution.applies && data.equityContributionKobo === null) e.equityContributionKobo = "Enter the customer's equity contribution.";
  if (!data.incomeBasisKobo) e.incomeBasisKobo = "Enter the income or business basis used for DSR.";

  // --- channel
  let location: LocationRow | null = null;
  if (app.outlet_location_id) location = (await listLocations(q)).find((l) => l.id === app.outlet_location_id) ?? null;
  if (app.initiator_role === "DELIGHT_OFFICER") {
    if (!data.outletLocationId) e.outletLocationId = "Select the originating outlet.";
    else if (!location?.active) e.outletLocationId = "The selected outlet is no longer active.";
    else if (!location.oss_staff_id) blockers.push("No Outlet Service Supervisor is mapped to the selected outlet. An administrator must map one.");
    if (rules && (rules.rmProposalRequired || rules.businessPhotos.rmPhotoRequired) && !data.assignedRmId) e.assignedRmId = "Assign the Relationship Manager who supplies the RM proposal and business-visit evidence.";
  }
  if (!app.team && app.initiator_role === "RM") blockers.push("Your Relationship Manager assignment has no team, so no Team Lead can be routed. Ask an administrator to set your team.");
  if (!app.team && app.initiator_role === "DELIGHT_OFFICER" && location && !location.team) blockers.push("The selected outlet is not mapped to a team.");
  const responsibleRm = app.initiator_role === "DELIGHT_OFFICER" ? app.assigned_rm_id : app.initiator_id;

  // --- beneficiary
  let beneficiary: BeneficiarySnapshot | null = null;
  let benProblems: string[] = [];
  if (cfg?.config.beneficiaryRequired) {
    if (!data.vendorId) e.vendorId = "Select the vendor.";
    if (!data.vendorAccountId) e.vendorAccountId = "Select the vendor's approved bank account.";
    else {
      beneficiary = await beneficiaryFor(q, data.vendorAccountId, now);
      benProblems = beneficiaryProblems(beneficiary, data.vendorId).filter((p) => !p.includes("not marked as supported"));
      if (benProblems.length) e.vendorAccountId = benProblems.join(" ");
    }
  }

  // --- consents
  for (const c of cfg?.config.privacyConsents ?? []) {
    if (!data.consents.find((x) => x.code === c.code && x.granted)) e[`consent_${c.code}`] = `Record the customer's permission: ${c.purpose}`;
  }

  // --- obligations declared
  // existing obligations may legitimately be none; the list is always included in DSR.

  // --- documents, photos, proposal
  const docs = await listDocuments(q, appId);
  const exceptions = (await q.query("SELECT id, type, subject, status, reason, decision_note, approver_role FROM policy_exceptions WHERE application_id = $1 ORDER BY requested_at", [appId])).rows;
  const approvedExceptionCodes = exceptions.filter((x: { status: string }) => x.status === "APPROVED").map((x: { type: string; subject: string | null }) => (x.type === "AFS" ? "AFS" : (x.subject ?? x.type)));
  const matrix = rules ? evaluateMatrix({ rules, structure, amountKobo: data.requestedAmountKobo, documents: docs, approvedExceptions: approvedExceptionCodes, asOf: lagosDate(now), stages: ["SUBMISSION"] }) : [];
  for (const m of matrix) if (!m.satisfied) e[`doc_${m.code}`] = `${m.label}: ${m.detail.toLowerCase()}${m.code === "AFS" ? " (or an approved AFS exception)" : ""}.`;
  const photos = rules && (rules.businessPhotos.minDistinct > 0 || rules.businessPhotos.rmPhotoRequired) ? checkPhotos(docs, rules, responsibleRm) : null;
  if (photos && !photos.ok) e.photos = photos.messages.join(" ");
  const prop = (await q.query("SELECT * FROM credit_proposals WHERE application_id = $1 ORDER BY version_no DESC LIMIT 1", [appId])).rows[0] ?? null;
  const proposalRequired = !!rules?.rmProposalRequired;
  const missingProposal: string[] = [];
  if (proposalRequired) {
    if (!prop) missingProposal.push("RM credit proposal");
    else {
      const content = prop.content as ProposalContent;
      for (const f of PROPOSAL_FIELDS) {
        if (f.key === "visitFindings" && !rules?.businessPhotos.rmPhotoRequired) continue;
        if (!(content[f.key] ?? "").trim()) missingProposal.push(f.label);
      }
      if (responsibleRm && prop.author_id !== responsibleRm) missingProposal.push("proposal must be written by the responsible Relationship Manager");
    }
    if (missingProposal.length) e.proposal = `RM credit proposal incomplete: ${missingProposal.join(", ")}.`;
  }

  // --- preliminary affordability
  let preliminary: AffordabilityOutput | null = null;
  if (cfg && rules && app.customer_profile) {
    const snap = rulesSnapshot({ configId: cfg.id, configVersion: cfg.version, productCode: app.product_code!, profile: app.customer_profile, structure, rules });
    preliminary = computeAffordability(snap, preliminaryInput(app.applicant_type, data, docs));
  }
  const dsrEx = exceptions.find((x: { type: string; status: string }) => x.type === "DSR" && x.status === "APPROVED") ?? null;
  if (preliminary) {
    if (preliminary.result === "BLOCKED") for (const b of preliminary.blockedReasons) if (!blockers.includes(b)) blockers.push(b);
    if (preliminary.result === "FAIL") {
      const failing = preliminary.checks.filter((c) => !c.pass);
      const onlyDsr = failing.every((c) => c.rule.startsWith("DSR within"));
      if (onlyDsr && dsrEx) {
        /* authorised exception */
      } else {
        for (const c of failing) blockers.push(`${c.rule}: ${c.detail.replace(/\.$/, "")}.${c.rule.startsWith("DSR within") ? (rules?.dsr.exceptionAllowed ? " An exception may be requested from the configured authority." : " No exception route is configured for this product.") : ""}`);
      }
    }
  }
  const fieldBlockers = Object.keys(e).length;
  return {
    productName: product?.name ?? app.product_label ?? "",
    config: cfg,
    rules,
    structure,
    gaps,
    blockedBy,
    fieldErrors: e,
    matrix,
    photos,
    proposal: { required: proposalRequired, present: !!prop, authorId: prop?.author_id ?? null, requiredAuthorId: responsibleRm, versionNo: prop?.version_no ?? null, missing: missingProposal },
    beneficiary,
    beneficiaryProblems: benProblems,
    location,
    preliminary,
    dsrException: dsrEx ? { status: dsrEx.status } : null,
    exceptions,
    blockers,
    ready: fieldBlockers === 0 && blockers.length === 0,
  };
}

function preliminaryInput(applicantType: string, data: RetailData, docs: { category: string; meta?: Record<string, string>; id: string; superseded_at: Date | null }[]): AffordabilityInput {
  const statements = docs.filter((d) => d.category === "BANK_STATEMENT" && !d.superseded_at && d.meta?.coverageFrom);
  const from = statements.map((d) => d.meta!.coverageFrom!).sort()[0] ?? null;
  const to = statements.map((d) => d.meta!.coverageTo!).sort().at(-1) ?? null;
  return {
    kind: "PRELIMINARY",
    applicantType,
    incomeBasisKobo: data.incomeBasisKobo,
    incomeBasisNote: data.incomeBasisNote,
    statementFrom: from,
    statementTo: to,
    evidenceDocumentIds: statements.map((d) => d.id),
    existingObligations: data.existingObligations,
    principalKobo: data.requestedAmountKobo,
    tenorMonths: data.tenorMonths,
    proposedMonthlyObligationKobo: data.proposedMonthlyObligationKobo,
    turnoverForCapKobo: data.turnoverForCapKobo,
    assetCostKobo: data.assetCostKobo,
    equityContributionKobo: data.equityContributionKobo,
    charges: [],
    firstDueDate: null,
  };
}

// ------------------------------------------------------------------ submission

async function storeAssessment(tx: Tx, ctx: Ctx, app: AppRow, kind: "PRELIMINARY" | "FINAL", cfg: ProductConfigRow, rules: ProfileRules, input: AffordabilityInput, role: string) {
  const snap = rulesSnapshot({ configId: cfg.id, configVersion: cfg.version, productCode: app.product_code!, profile: app.customer_profile!, structure: app.financing_structure, rules });
  const out = computeAffordability(snap, input);
  await tx.query("UPDATE retail_assessments SET superseded_at = $3 WHERE application_id = $1 AND kind = $2 AND superseded_at IS NULL", [app.id, kind, ctx.now]);
  const r = await tx.query<{ id: string }>(
    `INSERT INTO retail_assessments (application_id, version_id, kind, engine_version, product_config_id, rules, inputs, outputs, result, assessor_id, assessor_role, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [app.id, app.current_version_id, kind, out.engineVersion, cfg.id, JSON.stringify(snap), JSON.stringify(input), JSON.stringify(out), out.result, ctx.actor!.staffId, role, ctx.now],
  );
  await audit(tx, ctx, {
    action: kind === "FINAL" ? "FINAL_ASSESSMENT_RECORDED" : "PRELIMINARY_ASSESSMENT_RECORDED",
    actorRole: role,
    applicationId: app.id,
    stage: app.stage,
    details: { assessmentId: r.rows[0].id, result: out.result, dsr: out.dsr?.percent ?? null, threshold: out.dsr?.maxPercent ?? null, configVersion: cfg.version, engine: out.engineVersion, blocked: out.blockedReasons },
  });
  return { id: r.rows[0].id, out };
}

/** Finalise the working version for (re)submission; returns whether material fields changed. */
async function finaliseRetailVersion(tx: Tx, ctx: Ctx, app: AppRow): Promise<{ material: boolean; readiness: Readiness; cfg: ProductConfigRow; rules: ProfileRules; data: RetailData }> {
  const readiness = await retailReadiness(tx, app.id, ctx.now);
  if (!readiness.ready) {
    const fields = { ...readiness.fieldErrors };
    readiness.blockers.forEach((b, i) => (fields[`blocker_${i}`] = b));
    throw invalid("The application is not ready to submit. Resolve the items listed and submit again.", fields);
  }
  const cfg = readiness.config!;
  const rules = readiness.rules!;
  const working = await workingVersion(tx, app.id);
  const version = working ?? (await tx.query<VersionRow>("SELECT * FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0];
  const data = retailDataSchema.parse(version.data);
  const directors = (await tx.query("SELECT * FROM application_directors WHERE version_id = $1 ORDER BY position", [version.id])).rows;
  const ben = readiness.beneficiary;
  const digest = retailMaterialDigest({
    productCode: app.product_code!,
    profile: app.customer_profile,
    structure: app.financing_structure,
    applicantType: app.applicant_type,
    data,
    bvnPlain: version.bvn_enc ? decryptField(version.bvn_enc) : null,
    tinPlain: version.tin_enc ? decryptField(version.tin_enc) : null,
    directors: directors.map((d: { full_name: string; bvn_enc: string }) => ({ fullName: d.full_name, bvnPlain: decryptField(d.bvn_enc) })),
    beneficiary: ben ? { accountId: ben.accountId, institutionCode: ben.institutionCode, accountNumber: ben.accountNumber } : null,
  });
  let material = false;
  if (working) {
    if (app.current_version_id) {
      const prev = (await tx.query<{ material_digest: string }>("SELECT material_digest FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0];
      material = prev.material_digest !== digest;
    }
    // Snapshot the beneficiary and outlet on the submitted version (later register edits never rewrite it).
    const snapData = { ...(working.data as object), beneficiarySnapshot: ben, locationSnapshot: app.location_snapshot ?? null, structureAtSubmission: app.financing_structure };
    await tx.query("UPDATE application_versions SET submitted_at = $2, material_digest = $3, data = $4 WHERE id = $1", [working.id, ctx.now, digest, JSON.stringify(snapData)]);
    app.current_version_id = working.id;
  }
  app.customer_name = retailDisplayName(app.applicant_type, data);
  app.requested_amount_kobo = data.requestedAmountKobo;
  app.product_config_id = cfg.id;
  const identity = app.applicant_type === "LIMITED" ? `RC:${data.registrationNumber.toUpperCase()}` : version.bvn_enc ? `BVN:${decryptField(version.bvn_enc)}` : null;
  const identityHash = identity ? hmac(identity) : null;
  const cust = await tx.query<{ id: string }>(
    `INSERT INTO customers (applicant_type, display_name, identity_hash, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)
     ON CONFLICT (identity_hash) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at RETURNING id`,
    [app.applicant_type, app.customer_name, identityHash, ctx.now],
  );
  app.customer_id = cust.rows[0].id;
  return { material, readiness, cfg, rules, data };
}

function firstBusinessStage(app: AppRow): Stage {
  return app.initiator_role === "DELIGHT_OFFICER" ? "OSS_REVIEW" : "TEAM_LEAD_REVIEW";
}

export async function submitRetail(tx: Tx, ctx: Ctx, app: AppRow): Promise<ActionResult> {
  const { cfg, rules, data } = await finaliseRetailVersion(tx, ctx, app);
  const credit = await retailCreditBlockers(tx, app.id, ctx.now);
  if (credit.length) throw gate(credit.join(" "));
  const docs = await currentCleanDocuments(tx, app.id);
  await storeAssessment(tx, ctx, app, "PRELIMINARY", cfg, rules, preliminaryInput(app.applicant_type, data, docs), app.initiator_role);
  (app as { submitted_at: Date | null }).submitted_at = ctx.now;
  await tx.query("UPDATE applications SET submitted_at = $2 WHERE id = $1", [app.id, ctx.now]);
  await recordRequestLedger(tx, app, ctx.now);
  await audit(tx, ctx, { action: "REQUEST_SUBMITTED", actorRole: app.initiator_role, applicationId: app.id, customerId: app.customer_id, stage: "DRAFT", details: { versionId: app.current_version_id, product: app.product_code, configVersion: cfg.version, channel: app.initiator_role } });
  const stage = firstBusinessStage(app);
  const chosen = await chooseAssignee(tx, app, stage, {});
  if (stage === "OSS_REVIEW") app.oss_reviewer_id = chosen.staffId;
  else app.team_lead_id = chosen.staffId;
  await moveTo(tx, ctx, app, stage, chosen);
  await persistApp(tx, app, ctx.now);
  return { applicationId: app.id, stage: app.stage, message: chosen.staffId ? `Submitted to ${STAGE_LABELS[stage].toLowerCase()} (${chosen.pool.find((p) => p.staff_id === chosen.staffId)?.full_name}).` : `Submitted. No eligible reviewer is in scope for ${STAGE_LABELS[stage].toLowerCase()}; the request is in the assignment exception queue.` };
}

// ------------------------------------------------------------------ material change / resubmission

async function invalidateRetailApprovals(tx: Tx, ctx: Ctx, app: AppRow, why: string) {
  const r = await tx.query(
    `UPDATE decisions SET invalidated_at=$2, invalidated_reason=$3
      WHERE application_id=$1 AND invalidated_at IS NULL AND action IN ('RECOMMEND','ENDORSE','APPROVE','PROCEED') AND decision_kind IN ('BUSINESS_REVIEW','CREDIT')`,
    [app.id, ctx.now, why],
  );
  await tx.query("UPDATE retail_assessments SET superseded_at = $2 WHERE application_id = $1 AND superseded_at IS NULL", [app.id, ctx.now]);
  const offers = await tx.query("UPDATE documents SET superseded_at = $2 WHERE application_id = $1 AND category IN ('GENERATED_OFFER','GENERATED_OFFER_PDF','SIGNED_OFFER') AND superseded_at IS NULL RETURNING id", [app.id, ctx.now]);
  const ex = await tx.query("UPDATE policy_exceptions SET status = 'SUPERSEDED', decision_note = coalesce(decision_note,'') || ' [superseded by material change]' WHERE application_id = $1 AND status IN ('REQUESTED','APPROVED') RETURNING id", [app.id]);
  app.business_approved_at = null;
  await tx.query("UPDATE applications SET business_approved_at = NULL WHERE id = $1", [app.id]);
  await audit(tx, ctx, { action: "APPROVALS_INVALIDATED", applicationId: app.id, stage: app.stage, reason: why, details: { decisions: r.rowCount, offersSuperseded: offers.rowCount, exceptionsSuperseded: ex.rowCount } });
}

export async function retailResubmit(tx: Tx, ctx: Ctx, app: AppRow, task: TaskRow): Promise<string> {
  const corr = await activeCorrection(tx, app, "INITIATOR_CORRECTION");
  const prevData = retailDataSchema.parse((await tx.query("SELECT data FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0]?.data ?? {});
  const { material, cfg, rules, data } = await finaliseRetailVersion(tx, ctx, app);
  await recordDecision(tx, ctx, app, task, "RESUBMIT", null);
  await completeTask(tx, ctx, task, "RESUBMIT", { material });
  await noteLatestRequestedAmount(tx, app.id, data.requestedAmountKobo);
  await audit(tx, ctx, { action: "REQUEST_RESUBMITTED", applicationId: app.id, stage: task.stage, details: { material, versionId: app.current_version_id } });
  if (material) {
    const { materialChanges } = await import("./retail-data");
    const changes = materialChanges(prevData, data);
    await invalidateRetailApprovals(tx, ctx, app, `Material change on resubmission${changes.length ? `: ${changes.join(", ")}` : ""}`);
    await resolveAllCorrections(tx, ctx, app, "SUPERSEDED_BY_MATERIAL_CHANGE");
    const docs = await currentCleanDocuments(tx, app.id);
    await storeAssessment(tx, ctx, app, "PRELIMINARY", cfg, rules, preliminaryInput(app.applicant_type, data, docs), app.initiator_role);
    app.route = null;
    app.first_reviewer_id = null;
    app.second_reviewer_id = null;
    const stage = firstBusinessStage(app);
    const chosen = await chooseAssignee(tx, app, stage, { preferred: stage === "OSS_REVIEW" ? app.oss_reviewer_id : app.team_lead_id });
    if (stage === "OSS_REVIEW") app.oss_reviewer_id = chosen.staffId;
    else app.team_lead_id = chosen.staffId;
    await moveTo(tx, ctx, app, stage, chosen, "Reassessment after material change");
    return `Material change detected${changes.length ? ` (${changes.join(", ")})` : ""}: business and credit approvals and any offer were invalidated; the request restarts at ${STAGE_LABELS[stage].toLowerCase()}.`;
  }
  await resolveCorrection(tx, ctx, corr.id, "RESUBMITTED");
  app.active_correction_id = corr.parent_id;
  const chosen = await chooseAssignee(tx, app, corr.from_stage, { preferred: corr.from_assignee_id, requirePreferred: true });
  await moveTo(tx, ctx, app, corr.from_stage, chosen, "Resubmitted after correction (non-material)");
  return `Resubmitted to ${STAGE_LABELS[corr.from_stage]}.`;
}

// ------------------------------------------------------------------ dispatch for retail stages

async function enterCredit(tx: Tx, ctx: Ctx, app: AppRow): Promise<string> {
  let route;
  try {
    route = routeForAmount(Number(app.requested_amount_kobo));
  } catch {
    throw gate(`No credit approval route is configured for ${formatKobo(Number(app.requested_amount_kobo))}. This is an outstanding business decision.`);
  }
  app.business_approved_at = ctx.now;
  await tx.query("UPDATE applications SET business_approved_at = $2 WHERE id = $1", [app.id, ctx.now]);
  app.endorser_id = app.hrs_id ?? app.team_lead_id;
  if (app.route !== route.route) {
    app.route = route.route;
    app.first_reviewer_id = null;
    app.second_reviewer_id = null;
  }
  const chosen = await chooseAssignee(tx, app, "FIRST_CREDIT_REVIEW", { preferred: app.first_reviewer_id });
  app.first_reviewer_id = chosen.staffId;
  await moveTo(tx, ctx, app, "FIRST_CREDIT_REVIEW", chosen);
  return `Business approval complete. Routed to credit appraisal (Route ${route.route}).`;
}

async function currentConfigFor(tx: Tx, app: AppRow, now: Date) {
  const cfg = app.product_config_id ? await configById(tx, app.product_config_id) : await effectiveConfig(tx, app.product_code!, now);
  if (!cfg) throw gate("This product has no approved configuration.");
  return { cfg, rules: profileRules(cfg.config, app.customer_profile) };
}

export async function preliminaryOk(tx: Db, app: AppRow): Promise<{ ok: boolean; message: string }> {
  const a = (await tx.query("SELECT * FROM retail_assessments WHERE application_id = $1 AND kind = 'PRELIMINARY' AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1", [app.id])).rows[0];
  if (!a) return { ok: false, message: "No preliminary DSR assessment exists for this request." };
  if (a.result === "PASS") return { ok: true, message: "" };
  const ex = await tx.query("SELECT 1 FROM policy_exceptions WHERE application_id = $1 AND type = 'DSR' AND status = 'APPROVED'", [app.id]);
  const out = a.outputs as AffordabilityOutput;
  const onlyDsr = out.checks.filter((c) => !c.pass).every((c) => c.rule.startsWith("DSR within"));
  if (a.result === "FAIL" && onlyDsr && ex.rowCount) return { ok: true, message: "" };
  return { ok: false, message: `The preliminary assessment did not pass (${a.result.toLowerCase()}).` };
}

export async function retailDispatch(tx: Tx, ctx: Ctx, app: AppRow, task: TaskRow, input: TaskActionInput, reason: string | null): Promise<string | null> {
  const a = input.action;
  switch (task.stage) {
    case "OSS_REVIEW":
    case "TEAM_LEAD_REVIEW":
    case "HRS_REVIEW":
    case "HEAD_OF_UNIT_APPROVAL": {
      if (a === "REJECT") return null; // shared decline handling
      if (a === "RETURN") return returnToInitiator(tx, ctx, app, task, reason!);
      const pre = await preliminaryOk(tx, app);
      if (!pre.ok) throw gate(pre.message);
      const { cfg, rules } = await currentConfigFor(tx, app, ctx.now);
      const attestation: Record<string, unknown> = { comments: reason, attestedAt: ctx.now.toISOString(), configVersion: cfg.version };
      if (task.stage === "TEAM_LEAD_REVIEW") {
        const tlGaps = gapsBlocking(configGaps(cfg.config, { profile: app.customer_profile as never, structure: app.financing_structure }), "TEAM_LEAD_REVIEW");
        if (tlGaps.length) throw gate(`Team Lead review is blocked until configured: ${tlGaps.map((g) => g.label).join("; ")}.`);
        if (rules?.visitRequired) {
          const v = (input.visitComments ?? "").trim();
          if (v.length < 20) throw invalid("Management visit comments are mandatory for this product and profile (at least 20 characters).", { visitComments: "Enter the management visit findings." });
          attestation.visitComments = v;
        }
        if (rules?.businessPhotos.rmPhotoRequired) {
          const docs = await listDocuments(tx, app.id);
          const pc = checkPhotos(docs, rules, app.initiator_role === "DELIGHT_OFFICER" ? app.assigned_rm_id : app.initiator_id);
          if (!pc.ok) throw gate(pc.messages.join(" "));
          if (!input.rmPhotoConfirmed) throw gate("Confirm that you have looked at the photographs and one clearly shows the Relationship Manager with the business.");
          attestation.rmPhotoConfirmed = { confirmedBy: ctx.actor!.staffId, at: ctx.now.toISOString(), method: "REVIEWER_VISUAL_CONFIRMATION" };
        }
      }
      await recordDecision(tx, ctx, app, task, a, reason);
      await completeTask(tx, ctx, task, a, attestation);
      if (task.stage === "OSS_REVIEW") {
        app.oss_reviewer_id = ctx.actor!.staffId;
        const chosen = await chooseAssignee(tx, app, "TEAM_LEAD_REVIEW", { preferred: app.team_lead_id });
        app.team_lead_id = chosen.staffId;
        await moveTo(tx, ctx, app, "TEAM_LEAD_REVIEW", chosen);
        return "Recommended. Sent to the Team Lead for first review.";
      }
      if (task.stage === "TEAM_LEAD_REVIEW") {
        app.team_lead_id = ctx.actor!.staffId;
        const chosen = await chooseAssignee(tx, app, "HRS_REVIEW", { preferred: app.hrs_id });
        app.hrs_id = chosen.staffId;
        await moveTo(tx, ctx, app, "HRS_REVIEW", chosen);
        return "Recommended. Sent to the Head of Retail Sales for second review.";
      }
      if (task.stage === "HRS_REVIEW") {
        app.hrs_id = ctx.actor!.staffId;
        if (cfg.config.businessReview.headOfUnitStage === "DISTINCT") {
          const chosen = await chooseAssignee(tx, app, "HEAD_OF_UNIT_APPROVAL", { preferred: app.hou_id });
          app.hou_id = chosen.staffId;
          await moveTo(tx, ctx, app, "HEAD_OF_UNIT_APPROVAL", chosen);
          return chosen.staffId ? "Endorsed. Sent to the Head of Unit for business approval." : "Endorsed. No eligible Head of Unit is available (the Head of Unit must be a different person); the request is in the assignment exception queue.";
        }
        return enterCredit(tx, ctx, app);
      }
      app.hou_id = ctx.actor!.staffId;
      return enterCredit(tx, ctx, app);
    }
    case "FIRST_CREDIT_REVIEW": {
      if (a !== "APPROVE") return null;
      const { cfg, rules } = await currentConfigFor(tx, app, ctx.now);
      const finalRow = (await tx.query("SELECT * FROM retail_assessments WHERE application_id = $1 AND kind = 'FINAL' AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1", [app.id])).rows[0];
      if (!finalRow || finalRow.version_id !== app.current_version_id) throw gate("Record the final credit assessment for the current application version before approval.");
      const out = finalRow.outputs as AffordabilityOutput;
      if (finalRow.result === "BLOCKED") throw gate(`Final calculation is blocked: ${out.blockedReasons.join(" ")}`);
      if (finalRow.result === "FAIL") {
        const failing = out.checks.filter((c) => !c.pass);
        const onlyDsr = failing.every((c) => c.rule.startsWith("DSR within"));
        const ex = await tx.query("SELECT id FROM policy_exceptions WHERE application_id = $1 AND type = 'DSR' AND status = 'APPROVED'", [app.id]);
        if (!(onlyDsr && ex.rowCount)) throw gate(`The final assessment failed: ${failing.map((c) => `${c.rule} (${c.detail})`).join("; ")}. Approval is blocked${onlyDsr && rules?.dsr.exceptionAllowed ? " unless the configured authority approves a DSR exception" : ""}.`);
      }
      const docs = await listDocuments(tx, app.id);
      const exceptionCodes = (await tx.query("SELECT type, subject FROM policy_exceptions WHERE application_id = $1 AND status = 'APPROVED'", [app.id])).rows.map((x: { type: string; subject: string | null }) => (x.type === "AFS" ? "AFS" : (x.subject ?? x.type)));
      const credit = rules ? evaluateMatrix({ rules, structure: app.financing_structure, amountKobo: Number(app.requested_amount_kobo), documents: docs, approvedExceptions: exceptionCodes, asOf: lagosDate(ctx.now), stages: ["CREDIT"] }) : [];
      const missing = credit.filter((m) => !m.satisfied);
      if (missing.length) throw gate(`Credit-stage documents outstanding: ${missing.map((m) => m.label).join(", ")}.`);
      const ben = await beneficiaryRevalidation(tx, app, ctx.now);
      if (ben.length) throw gate(`Beneficiary revalidation required: ${ben.join(" ")}`);
      await recordDecision(tx, ctx, app, task, a, reason, null, finalRow.id);
      await completeTask(tx, ctx, task, a, { retailAssessmentId: finalRow.id, configVersion: cfg.version, attestedAt: ctx.now.toISOString() });
      const chosen = await chooseAssignee(tx, app, "SECOND_CREDIT_REVIEW", { preferred: app.second_reviewer_id, random: true });
      app.second_reviewer_id = chosen.staffId;
      await moveTo(tx, ctx, app, "SECOND_CREDIT_REVIEW", chosen);
      return "Credit appraisal approved. Assigned for independent second credit review.";
    }
    case "CREDIT_CORRECTION": {
      if (a !== "RESUBMIT") return null;
      const corr = await activeCorrection(tx, app, "CREDIT_CORRECTION");
      await recordDecision(tx, ctx, app, task, a, reason);
      await completeTask(tx, ctx, task, a);
      const finalRow = (await tx.query<{ id: string }>("SELECT id FROM retail_assessments WHERE application_id = $1 AND kind = 'FINAL' AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1", [app.id])).rows[0];
      if ((finalRow?.id ?? null) !== corr.baseline_assessment_id) {
        await tx.query(
          `UPDATE decisions SET invalidated_at=$2, invalidated_reason=$3 WHERE application_id=$1 AND invalidated_at IS NULL AND action IN ('APPROVE','PROCEED') AND decision_kind = 'CREDIT'`,
          [app.id, ctx.now, "Final assessment changed during credit correction"],
        );
        await resolveAllCorrections(tx, ctx, app, "REASSESSED");
        const chosen = await chooseAssignee(tx, app, "FIRST_CREDIT_REVIEW", { preferred: ctx.actor!.staffId });
        await moveTo(tx, ctx, app, "FIRST_CREDIT_REVIEW", chosen, "Re-review after reassessment");
        return "Assessment changed: returned to first credit review for fresh approval.";
      }
      await resolveCorrection(tx, ctx, corr.id, "RESUBMITTED");
      app.active_correction_id = corr.parent_id;
      const chosen = await chooseAssignee(tx, app, corr.from_stage, { preferred: corr.from_assignee_id, requirePreferred: corr.from_stage === "SECOND_CREDIT_REVIEW" });
      await moveTo(tx, ctx, app, corr.from_stage, chosen, "Returned after correction");
      return `Correction resolved. Returned to ${STAGE_LABELS[corr.from_stage]}.`;
    }
    case "OFFER_PREPARATION": {
      const { cfg } = await currentConfigFor(tx, app, ctx.now);
      const effective = (await effectiveConfig(tx, app.product_code!, ctx.now)) ?? cfg;
      const gaps = configGaps(effective.config, { profile: app.customer_profile as never, structure: app.financing_structure });
      const contracting = gapsBlocking(gaps, "CONTRACTING");
      if (contracting.length) throw gate(`The contractual sequence for this structure is not configured: ${contracting.map((g) => g.label).join("; ")}.`);
      const rules = profileRules(effective.config, app.customer_profile);
      const seq = structureRules(rules, app.financing_structure)?.contractSequence ?? [];
      const docs = await currentCleanDocuments(tx, app.id);
      const cats = new Set(docs.map((d) => d.category));
      const missing = ["GENERATED_OFFER", "SIGNED_OFFER", "KYC", "PRE_DISBURSEMENT", "GSI_FORM", "INSURANCE_SIGNED"].filter((c) => !cats.has(c));
      if (seq.length && !cats.has("CONTRACT_EVIDENCE")) missing.push("CONTRACT_EVIDENCE");
      if (missing.length) throw gate(`The offer and contract pack is incomplete. Missing: ${missing.map((m) => m.replace(/_/g, " ").toLowerCase()).join(", ")}.`);
      if (seq.length && !input.contractStepsConfirmed) throw gate(`Confirm the contractual steps were completed in order: ${seq.join(" → ")}.`);
      await recordDecision(tx, ctx, app, task, "SUBMIT_PACK", reason);
      await completeTask(tx, ctx, task, "SUBMIT_PACK", { contractSequence: seq, contractStepsConfirmed: !!input.contractStepsConfirmed });
      if (app.active_correction_id) {
        await resolveCorrection(tx, ctx, app.active_correction_id, "RESUBMITTED");
        app.active_correction_id = null;
      }
      let co3: string | null = app.pack_co3_id;
      if (!co3) for (const id of [app.first_reviewer_id, app.second_reviewer_id]) if (id && (await holdsRole(tx, id, "CREDIT_OFFICER_3"))) co3 = id;
      const chosen = await chooseAssignee(tx, app, "CO3_PACK_REVIEW", { preferred: co3 });
      app.pack_co3_id = chosen.staffId;
      await moveTo(tx, ctx, app, "CO3_PACK_REVIEW", chosen);
      return "Offer and contract pack submitted to Credit Officer 3.";
    }
    case "DISBURSEMENT_CHECK": {
      if (a === "RETURN") return returnToInitiator(tx, ctx, app, task, reason!);
      if (a !== "OKAY") return null;
      const ben = await beneficiaryRevalidation(tx, app, ctx.now);
      if (ben.length) throw gate(`Beneficiary revalidation required before disbursement: ${ben.join(" ")} Return the request to the initiator to update the beneficiary (this triggers re-approval).`);
      const crms = (await currentCleanDocuments(tx, app.id)).filter((d) => d.category === "CRMS_EVIDENCE");
      if (!crms.length) throw gate("Upload the CRMS evidence before confirming the pre-disbursement checks.");
      if (!input.crmsLogged) throw gate('Confirm "Logged CRMS" (officer attestation) before selecting Okay.');
      await recordDecision(tx, ctx, app, task, a, reason);
      await completeTask(tx, ctx, task, a, { crmsLogged: true, crmsSource: "OFFICER_ATTESTATION_WITH_EVIDENCE", crmsEvidence: crms.map((d) => ({ id: d.id, version: d.version_no })), attestedAt: ctx.now.toISOString() });
      const chosen = await chooseAssignee(tx, app, "DISBURSEMENT_BOOKING", { preferred: app.do2_id });
      app.do2_id = chosen.staffId;
      await moveTo(tx, ctx, app, "DISBURSEMENT_BOOKING", chosen);
      return "Pre-disbursement checks complete. Sent to Disbursement Officer 2 for facility booking.";
    }
    case "DISBURSEMENT_BOOKING":
      return bookFacility(tx, ctx, app, task, input);
    case "PAYMENT_RECONCILIATION":
      return reconcilePayment(tx, ctx, app, task, input);
    case "FULFILMENT":
      return completeFulfilment(tx, ctx, app, task);
    default:
      return null;
  }
}

// ------------------------------------------------------------------ final credit assessment

export interface FinalAssessmentForm {
  incomeBasisKobo: number | null;
  incomeBasisNote: string;
  statementFrom: string | null;
  statementTo: string | null;
  principalKobo: number | null;
  tenorMonths: number | null;
  existingObligations: { lender: string; monthlyRepaymentKobo: number }[];
  charges: { label: string; amountKobo: number }[];
  turnoverForCapKobo: number | null;
}

/** Recorded by the assigned first credit reviewer (credit appraisal). Uses the configuration in force now. */
export async function recordFinalAssessment(ctx: Ctx, appId: string, f: FinalAssessmentForm) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    const app = await lockApp(tx, appId);
    if (app.workflow !== "RETAIL") throw invalid("Not a retail application.");
    const task = (await tx.query("SELECT * FROM tasks WHERE application_id = $1 AND status = 'OPEN' AND stage IN ('FIRST_CREDIT_REVIEW','CREDIT_CORRECTION')", [appId])).rows[0];
    if (!task || task.assignee_id !== actor.staffId || app.first_reviewer_id !== actor.staffId) throw forbidden("Only the assigned first credit reviewer can record the final assessment.");
    if (!(await holdsRole(tx, actor.staffId, task.assignee_role))) throw forbidden();
    const cfg = await effectiveConfig(tx, app.product_code!, ctx.now);
    if (!cfg) throw gate("No approved configuration.");
    const rules = profileRules(cfg.config, app.customer_profile);
    if (!rules) throw gate("The customer profile is not enabled for this product.");
    const data = retailDataSchema.parse((await tx.query("SELECT data FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0].data);
    if (f.principalKobo !== null && data.requestedAmountKobo !== null && f.principalKobo > data.requestedAmountKobo) {
      throw invalid("Check the assessment inputs.", { principalKobo: `The principal cannot exceed the requested amount (${formatKobo(data.requestedAmountKobo)}). Return the request to change the amount.` });
    }
    if (f.principalKobo && app.route) {
      try {
        if (routeForAmount(f.principalKobo).route !== app.route) throw invalid("Check the assessment inputs.", { principalKobo: "This principal falls in a different credit route. Return the request to the initiator to amend the amount." });
      } catch (e) {
        if (e instanceof DomainError) throw e;
      }
    }
    const docs = await currentCleanDocuments(tx, app.id);
    const input: AffordabilityInput = {
      kind: "FINAL",
      applicantType: app.applicant_type,
      incomeBasisKobo: f.incomeBasisKobo,
      incomeBasisNote: f.incomeBasisNote,
      statementFrom: f.statementFrom,
      statementTo: f.statementTo,
      evidenceDocumentIds: docs.filter((d) => ["BANK_STATEMENT", "PAYSLIP", "EMPLOYMENT_CONFIRMATION", "AFS", "BUSINESS_OPERATIONS_EVIDENCE"].includes(d.category)).map((d) => d.id),
      existingObligations: f.existingObligations.map((o) => ({ lender: o.lender, facilityType: "", monthlyRepaymentKobo: o.monthlyRepaymentKobo, outstandingKobo: null })),
      principalKobo: f.principalKobo,
      tenorMonths: f.tenorMonths,
      proposedMonthlyObligationKobo: null,
      turnoverForCapKobo: f.turnoverForCapKobo,
      assetCostKobo: data.assetCostKobo,
      equityContributionKobo: data.equityContributionKobo,
      charges: f.charges,
      firstDueDate: null,
    };
    const r = await storeAssessment(tx, ctx, app, "FINAL", cfg, rules, input, task.assignee_role);
    return { id: r.id, result: r.out.result, dsr: r.out.dsr?.percent ?? null, blocked: r.out.blockedReasons };
  });
}

/** The final assessment the credit approval was based on (offers and booking use this snapshot). */
export async function approvedRetailAssessment(q: Db, appId: string) {
  return (
    await q.query(
      `SELECT ra.* FROM decisions d JOIN retail_assessments ra ON ra.id = d.retail_assessment_id
        WHERE d.application_id = $1 AND d.stage = 'FIRST_CREDIT_REVIEW' AND d.action = 'APPROVE' AND d.invalidated_at IS NULL
        ORDER BY d.seq DESC LIMIT 1`,
      [appId],
    )
  ).rows[0] ?? null;
}

// ------------------------------------------------------------------ proposals

export async function saveProposal(ctx: Ctx, appId: string, content: Partial<ProposalContent>) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    const app = await lockApp(tx, appId);
    if (app.workflow !== "RETAIL") throw invalid("Not a retail application.");
    if (!["DRAFT", "INITIATOR_CORRECTION"].includes(app.stage)) throw forbidden("The credit proposal can be edited while the request is a draft or under correction.");
    const responsible = app.initiator_role === "DELIGHT_OFFICER" ? app.assigned_rm_id : app.initiator_id;
    const isResponsibleRm = responsible === actor.staffId && (await holdsRole(tx, actor.staffId, "RM"));
    if (!isResponsibleRm) throw forbidden(app.initiator_role === "DELIGHT_OFFICER" ? "The credit proposal is written by the assigned Relationship Manager." : "Only the initiating Relationship Manager can write the credit proposal.");
    const clean: Record<string, string> = {};
    for (const f of PROPOSAL_FIELDS) clean[f.key] = String(content[f.key] ?? "").trim().slice(0, 4000);
    const next = (await tx.query<{ v: number }>("SELECT coalesce(max(version_no),0)+1 AS v FROM credit_proposals WHERE application_id = $1", [appId])).rows[0].v;
    await tx.query("INSERT INTO credit_proposals (application_id, version_no, content, author_id, author_role, created_at) VALUES ($1,$2,$3,$4,'RM',$5)", [appId, next, JSON.stringify(clean), actor.staffId, ctx.now]);
    await audit(tx, ctx, { action: "CREDIT_PROPOSAL_SAVED", actorRole: "RM", applicationId: appId, stage: app.stage, details: { versionNo: next } });
    return { versionNo: next };
  });
}

// ------------------------------------------------------------------ exceptions

export async function requestException(ctx: Ctx, appId: string, p: { type: "AFS" | "DSR"; reason: string; evidenceDocumentIds: string[] }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    const app = await lockApp(tx, appId);
    if (app.workflow !== "RETAIL") throw invalid("Not a retail application.");
    const task = (await tx.query("SELECT * FROM tasks WHERE application_id = $1 AND status = 'OPEN'", [appId])).rows[0];
    const isInitiatorEditing = app.initiator_id === actor.staffId && (app.stage === "DRAFT" || (task?.stage === "INITIATOR_CORRECTION" && task.assignee_id === actor.staffId));
    const isFirstReviewer = p.type === "DSR" && task?.stage === "FIRST_CREDIT_REVIEW" && task.assignee_id === actor.staffId;
    if (!isInitiatorEditing && !isFirstReviewer) throw forbidden("Exceptions are requested by the initiator (draft or correction) or, for DSR, by the first credit reviewer.");
    const cfg = app.stage === "DRAFT" ? await effectiveConfig(tx, app.product_code!, ctx.now) : await configById(tx, app.product_config_id!);
    const rules = cfg ? profileRules(cfg.config, app.customer_profile) : null;
    if (!rules) throw gate("No configuration for this product and profile.");
    let approverRole: string | null = null;
    if (p.type === "AFS") {
      if (!rules.afs || rules.afs.thresholdKobo === null) throw gate("AFS exceptions do not apply to this product and profile.");
      if (Number(app.requested_amount_kobo ?? 0) <= rules.afs.thresholdKobo) throw invalid(`AFS is required only above ${formatKobo(rules.afs.thresholdKobo)}.`);
      approverRole = rules.afs.exceptionApproverRole;
      if (!approverRole) throw gate("The AFS exception authority is not configured. An administrator must configure the approving role before an exception can be requested.");
    } else {
      if (!rules.dsr.exceptionAllowed) throw gate("DSR exceptions are not permitted by this product's configuration.");
      approverRole = rules.dsr.exceptionApproverRole;
      if (!approverRole) throw gate("The DSR exception authority is not configured.");
    }
    if ((p.reason ?? "").trim().length < 10) throw invalid("Explain the exception (at least 10 characters).", { reason: "Reason required." });
    const ev = p.evidenceDocumentIds.length ? (await tx.query("SELECT id FROM documents WHERE application_id = $1 AND id = ANY($2::uuid[]) AND scan_status = 'CLEAN'", [appId, p.evidenceDocumentIds])).rows.map((r: { id: string }) => r.id) : [];
    if (!ev.length) throw invalid("Attach at least one clean supporting document as evidence (upload it as exception evidence first).", { evidence: "Evidence required." });
    const vid = (await workingVersion(tx, appId))?.id ?? app.current_version_id;
    let id: string;
    try {
      id = (
        await tx.query<{ id: string }>(
          `INSERT INTO policy_exceptions (application_id, type, subject, version_id, approver_role, reason, evidence_document_ids, requested_by, requested_at, product_config_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [appId, p.type, p.type, vid, approverRole, p.reason.trim(), ev, actor.staffId, ctx.now, cfg!.id],
        )
      ).rows[0].id;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw conflict("An exception of this type is already awaiting a decision.");
      throw e;
    }
    const approvers = (await tx.query<{ email: string }>("SELECT s.email FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.active AND ra.role = $1 AND s.status = 'ACTIVE' AND s.id <> $2", [approverRole, actor.staffId])).rows;
    if (approvers.length)
      await enqueueEmail(tx, ctx.now, {
        kind: "EXCEPTION_REQUESTED",
        dedupeKey: `exception:${id}`,
        applicationId: appId,
        to: approvers.map((x) => x.email),
        subject: `${PLATFORM_NAME} ${app.ref}: ${p.type} exception awaiting your decision`,
        text: simpleEmail([`${actor.name} requested a ${p.type} exception for ${app.ref} (${app.customer_name}).`, `Reason: ${p.reason.trim()}`, "", `Decide: ${caseLink(appId)}`]),
      });
    await audit(tx, ctx, { action: "EXCEPTION_REQUESTED", applicationId: appId, stage: app.stage, reason: p.reason.trim(), details: { exceptionId: id, type: p.type, approverRole, evidence: ev } });
    return { id };
  });
}

export async function decideException(ctx: Ctx, exceptionId: string, approve: boolean, note: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    const ex = (await tx.query("SELECT * FROM policy_exceptions WHERE id = $1 FOR UPDATE", [exceptionId])).rows[0];
    if (!ex) throw notFound();
    if (ex.status !== "REQUESTED") throw conflict("This exception has already been decided.");
    if (!(await holdsRole(tx, actor.staffId, ex.approver_role))) throw forbidden(`Only a holder of the configured authority (${ROLE_LABELS[ex.approver_role as Role] ?? ex.approver_role}) can decide this exception.`);
    const app = (await tx.query<AppRow>("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [ex.application_id])).rows[0];
    if ([ex.requested_by, app.initiator_id, app.assigned_rm_id].includes(actor.staffId)) throw forbidden("The requester, initiator or assigned RM cannot approve their own exception.");
    if ((note ?? "").trim().length < 5) throw invalid("Record the basis for your decision.", { note: "Decision note required." });
    await tx.query("UPDATE policy_exceptions SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5 WHERE id = $1", [exceptionId, approve ? "APPROVED" : "DECLINED", actor.staffId, ctx.now, note.trim()]);
    await audit(tx, ctx, { action: approve ? "EXCEPTION_APPROVED" : "EXCEPTION_DECLINED", actorRole: ex.approver_role, applicationId: ex.application_id, reason: note.trim(), details: { exceptionId, type: ex.type, evidence: ex.evidence_document_ids } });
    const email = await staffEmail(tx, ex.requested_by);
    if (email)
      await enqueueEmail(tx, ctx.now, {
        kind: "EXCEPTION_DECIDED",
        dedupeKey: `exception-decided:${exceptionId}`,
        applicationId: ex.application_id,
        to: [email],
        subject: `${PLATFORM_NAME} ${app.ref}: ${ex.type} exception ${approve ? "approved" : "declined"}`,
        text: simpleEmail([`${actor.name} ${approve ? "approved" : "declined"} the ${ex.type} exception.`, `Note: ${note.trim()}`, "", caseLink(ex.application_id)]),
      });
  });
}

export async function pendingExceptionsFor(q: Db, staffId: string) {
  return (
    await q.query(
      `SELECT pe.*, a.ref, a.customer_name, a.product_label, a.requested_amount_kobo, s.full_name AS requested_by_name
         FROM policy_exceptions pe JOIN applications a ON a.id = pe.application_id JOIN staff s ON s.id = pe.requested_by
        WHERE pe.status = 'REQUESTED' AND pe.approver_role IN (SELECT role FROM role_assignments WHERE staff_id = $1 AND active)
          AND pe.requested_by <> $1 AND a.initiator_id <> $1 AND (a.assigned_rm_id IS NULL OR a.assigned_rm_id <> $1)
        ORDER BY pe.requested_at`,
      [staffId],
    )
  ).rows;
}

// ------------------------------------------------------------------ withdrawal, suspension, expiry

export async function withdrawApplication(ctx: Ctx, appId: string, reason: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    const app = await lockApp(tx, appId);
    if (app.initiator_id !== actor.staffId) throw forbidden("Only the initiator can withdraw a request.");
    if (["COMPLETED", "CLOSED", "REJECTED", "WITHDRAWN", "EXPIRED"].includes(app.stage)) throw conflict("This request is already closed.");
    const fac = await tx.query("SELECT 1 FROM facilities WHERE application_id = $1", [appId]);
    if (fac.rowCount) throw gate("A facility has been booked. It can no longer be withdrawn; contact Operations.");
    if ((reason ?? "").trim().length < 5) throw invalid("Give the reason for withdrawal.", { reason: "Reason required." });
    await tx.query("UPDATE tasks SET status = 'CANCELLED', completed_at = $2, completed_by = $3, outcome = 'WITHDRAWN' WHERE application_id = $1 AND status = 'OPEN'", [appId, ctx.now, actor.staffId]);
    await resolveAllCorrections(tx, ctx, app, "WITHDRAWN");
    await tx.query("UPDATE applications SET withdrawn_at = $2 WHERE id = $1", [appId, ctx.now]);
    await moveTo(tx, ctx, app, "WITHDRAWN", null);
    await persistApp(tx, app, ctx.now);
    await audit(tx, ctx, { action: "REQUEST_WITHDRAWN", actorRole: app.initiator_role, applicationId: appId, reason: reason.trim() });
  });
}

export async function setSuspension(ctx: Ctx, appId: string, suspend: boolean, reason: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN")) && !(await holdsRole(tx, actor.staffId, "HEAD_OF_RETAIL_SALES"))) throw forbidden("Only a Super Admin or the Head of Retail Sales can suspend or resume a request.");
    const app = await lockApp(tx, appId);
    if ((reason ?? "").trim().length < 5) throw invalid("Give a reason.", { reason: "Reason required." });
    if (suspend && app.suspended_at) throw conflict("Already suspended.");
    if (!suspend && !app.suspended_at) throw conflict("Not suspended.");
    await tx.query("UPDATE applications SET suspended_at = $2, suspended_by = $3, suspension_reason = $4, lock_version = lock_version + 1, updated_at = $5 WHERE id = $1", [appId, suspend ? ctx.now : null, suspend ? actor.staffId : null, suspend ? reason.trim() : null, ctx.now]);
    await audit(tx, ctx, { action: suspend ? "REQUEST_SUSPENDED" : "REQUEST_RESUMED", applicationId: appId, stage: app.stage, reason: reason.trim() });
  });
}

/** Worker: expire retail drafts idle longer than the product's configured draft expiry. */
export async function expireStaleDrafts(now: Date) {
  const rows = (await db.query<{ id: string; product_code: string; updated_at: Date }>("SELECT id, product_code, updated_at FROM applications WHERE workflow = 'RETAIL' AND stage = 'DRAFT'")).rows;
  let expired = 0;
  for (const r of rows) {
    const cfg = await effectiveConfig(db, r.product_code, now);
    const days = cfg?.config.draftExpiryDays;
    if (!days) continue;
    if (now.getTime() - new Date(r.updated_at).getTime() < days * 86_400_000) continue;
    await withTx(async (tx) => {
      const app = await lockApp(tx, r.id);
      if (app.stage !== "DRAFT") return;
      await tx.query("UPDATE applications SET expired_at = $2 WHERE id = $1", [app.id, now]);
      const ctx = { actor: null, now, correlationId: `expiry-${app.id}`, ip: null, userAgent: "system/worker" };
      await moveTo(tx, ctx, app, "EXPIRED", null);
      await persistApp(tx, app, now);
      await audit(tx, ctx, { action: "DRAFT_EXPIRED", applicationId: app.id, details: { days } });
      expired++;
    });
  }
  return expired;
}

export { auditOutsideTx };
