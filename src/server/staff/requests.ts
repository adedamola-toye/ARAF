/**
 * Staff Personal Financing: origination (draft, calculator, submission) and the three review stages
 * (Product Manager → Unit Head → Divisional Head), returns, declines and controlled amendment.
 *
 * Account verification, salary history and repayment capacity are NOT checked by any system here:
 * no payroll, core-banking or identity API is connected. The Product Manager confirms them manually
 * through an explicit three-item checklist, and nothing marks those checks as passed automatically.
 */
import { createHash } from "node:crypto";
import { requireStaffFinancing } from "./permission";
import type { Db, Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { DomainError, conflict, forbidden, gate, invalid } from "../errors";
import { parseNairaToKobo } from "../money";
import { holdsRole } from "../domain/access";
import { phoneError } from "../domain/retail-data";
import { computeStaffFinancing, formatNairaKobo, bpsLabel, STAFF_DOC_CATEGORIES, type StaffStatus } from "@/lib/staff-financing";
import {
  auditDenied,
  checkLock,
  currentSettings,
  expectStatus,
  lockRequest,
  notifyRole,
  notifyStaff,
  requireActor,
  settingsById,
  routeUnitHead,
  routeDivisionalHead,
  alertOperations,
  transition,
  recordEvent,
  type StaffRequestRow,
} from "./core";
import { issueOffer } from "./offer";
import { staffCreditProblem } from "./credit";

const MAX_GROSS_KOBO = 100_000_000_000 * 100; // ₦100bn sanity ceiling against typing errors; product limits come from settings

/** Run a domain operation; record refused attempts (they roll back) in the audit trail. */
async function guarded<T>(ctx: Ctx, requestId: string | null, action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") await auditDenied(ctx, requestId, action, e.message);
    throw e;
  }
}

// ------------------------------------------------------------------ profile and drafts

export interface StaffProfile {
  fullName: string;
  email: string;
  department: string | null;
  unit: string | null;
  /** Fields the platform has no verified source for: the applicant enters them. */
  unverified: string[];
}

/** Profile from the authorised staff record and the bank directory. Nothing is invented. */
export async function staffProfile(q: Db, staffId: string): Promise<StaffProfile> {
  const s = (
    await q.query(
      `SELECT s.full_name, s.email, s.business_unit, d.department FROM staff s LEFT JOIN bank_directory d ON d.email = s.email WHERE s.id = $1`,
      [staffId],
    )
  ).rows[0];
  return {
    fullName: s.full_name,
    email: s.email,
    department: s.department ?? null,
    unit: s.business_unit ?? null,
    unverified: ["staffNumber", "phone", "salaryAccountNumber", "salaryAccountName"],
  };
}

async function nextRef(tx: Tx, now: Date) {
  const n = Number((await tx.query("SELECT nextval('staff_request_ref_seq') AS n")).rows[0].n);
  return `SPR-${now.getUTCFullYear()}-${String(n).padStart(6, "0")}`;
}

export async function createStaffDraft(ctx: Ctx): Promise<{ id: string; ref: string }> {
  await requireStaffFinancing(ctx, "CREATE_STAFF_DRAFT", null);
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    const st = (await tx.query("SELECT status FROM staff WHERE id = $1", [actor.staffId])).rows[0];
    if (!st || st.status !== "ACTIVE") throw forbidden("Only active staff can apply.");
    const profile = await staffProfile(tx, actor.staffId);
    const settings = await currentSettings(tx);
    const ref = await nextRef(tx, ctx.now);
    const req = (
      await tx.query<StaffRequestRow>(
        `INSERT INTO staff_requests (ref, applicant_id, status, settings_id, full_name, email, department, unit, created_at, updated_at)
         VALUES ($1,$2,'DRAFT',$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
        [ref, actor.staffId, settings.id, profile.fullName, profile.email, profile.department, profile.unit, ctx.now],
      )
    ).rows[0];
    await recordEvent(tx, ctx, req, { action: "DRAFT_CREATED", to: "DRAFT", role: "APPLICANT", details: { settingsVersion: settings.version } });
    return { id: req.id, ref };
  });
}

export interface DraftInput {
  staffNumber?: string;
  department?: string;
  unit?: string;
  phone?: string;
  salaryAccountNumber?: string;
  salaryAccountName?: string;
  purpose?: string;
  amount?: string;
  tenorMonths?: string;
  /** Net amount (kobo) the applicant saw when ticking the acknowledgement; must match the server's figure. */
  acknowledgedNetKobo?: string | null;
  acceptDeclaration?: boolean;
  lockVersion?: number | null;
}

const clean = (v: string | undefined, max = 120) => (v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Save the applicant's entries. Amounts are recalculated here; nothing from the browser is trusted. */
export async function saveStaffDraft(ctx: Ctx, id: string, input: DraftInput) {
  await requireStaffFinancing(ctx, "SAVE_STAFF_DRAFT", id);
  return guarded(ctx, id, "DRAFT_SAVE", () =>
    withTx(async (tx) => {
      const actor = ctx.actor;
      if (!actor) throw forbidden();
      const req = await lockRequest(tx, id);
      if (req.applicant_id !== actor.staffId) throw forbidden("Only the applicant can edit this request.");
      expectStatus(req, ["DRAFT", "RETURNED_FOR_CORRECTION"], "Editing");
      checkLock(req, input.lockVersion);
      // drafts and corrections are priced under the settings in force now; submission freezes them
      const settings = await currentSettings(tx);
      const fields: Record<string, string> = {};
      const set: Record<string, unknown> = {
        staff_number: clean(input.staffNumber, 30) || null,
        department: clean(input.department) || null,
        unit: clean(input.unit) || null,
        phone: (input.phone ?? "").replace(/\D/g, "").slice(0, 11) || null,
        salary_account_number: (input.salaryAccountNumber ?? "").replace(/\D/g, "").slice(0, 10) || null,
        salary_account_name: clean(input.salaryAccountName) || null,
        purpose: clean(input.purpose, 500) || null,
        settings_id: settings.id,
      };
      const amountRaw = (input.amount ?? "").trim();
      let grossKobo: number | null = null;
      if (amountRaw) {
        grossKobo = parseNairaToKobo(amountRaw);
        if (grossKobo === null || grossKobo <= 0) fields.amount = "Enter the amount in naira, for example 1,500,000.00.";
        else if (grossKobo > MAX_GROSS_KOBO) fields.amount = "The amount is too large.";
      }
      if (fields.amount) throw invalid("Check the financing amount.", fields);
      if (grossKobo) {
        const f = computeStaffFinancing(grossKobo, settings.deduction_rate_bps);
        Object.assign(set, { gross_kobo: f.grossKobo, deduction_rate_bps: f.deductionRateBps, deduction_kobo: f.deductionKobo, net_kobo: f.netKobo });
      } else {
        Object.assign(set, { gross_kobo: null, deduction_rate_bps: null, deduction_kobo: null, net_kobo: null });
      }
      const tenor = (input.tenorMonths ?? "").trim();
      set.tenor_months = tenor ? Number(tenor) : null;
      if (tenor && (!/^\d{1,3}$/.test(tenor) || (settings.tenor_options_months.length && !settings.tenor_options_months.includes(Number(tenor))))) {
        throw invalid("Choose a repayment tenor from the list.", { tenorMonths: "Choose a repayment tenor from the list." });
      }
      // Acknowledgement is valid only for the exact net figure the server computes now.
      const ackNet = input.acknowledgedNetKobo ? Number(input.acknowledgedNetKobo) : null;
      set.deduction_acknowledged_at = ackNet !== null && set.net_kobo !== null && ackNet === set.net_kobo ? ctx.now : null;
      set.declaration_accepted_at = input.acceptDeclaration ? ctx.now : null;
      const fresh = await transition(tx, ctx, req, { action: "DRAFT_SAVED", role: "APPLICANT", set, details: { grossKobo: set.gross_kobo, netKobo: set.net_kobo, acknowledged: !!set.deduction_acknowledged_at } });
      return { lockVersion: fresh.lock_version, figures: { grossKobo: fresh.gross_kobo, deductionKobo: fresh.deduction_kobo, netKobo: fresh.net_kobo } };
    }),
  );
}

/** Field-level readiness for submission (formats only: no verification service is connected). */
export async function submissionProblems(q: Db, req: StaffRequestRow): Promise<Record<string, string>> {
  const settings = await settingsById(q, req.settings_id);
  const p: Record<string, string> = {};
  if (!req.staff_number || !/^[A-Za-z0-9/\-]{2,30}$/.test(req.staff_number)) p.staffNumber = "Enter your staff ID (letters, digits, / or -).";
  if (!req.department) p.department = "Enter your department.";
  if (!req.unit) p.unit = "Enter your unit.";
  const ph = phoneError(req.phone ?? "");
  if (!req.phone) p.phone = "Enter your phone number (11 digits).";
  else if (ph) p.phone = ph;
  if (!req.salary_account_number || !/^\d{10}$/.test(req.salary_account_number)) p.salaryAccountNumber = "Enter your 10-digit salary account number.";
  if (!req.salary_account_name) p.salaryAccountName = "Enter the name on your salary account.";
  if (!req.gross_kobo) p.amount = "Enter the financing amount.";
  else {
    if (settings.min_amount_kobo && Number(req.gross_kobo) < Number(settings.min_amount_kobo)) p.amount = `The minimum amount is ${formatNairaKobo(settings.min_amount_kobo)}.`;
    if (settings.max_amount_kobo && Number(req.gross_kobo) > Number(settings.max_amount_kobo)) p.amount = `The maximum amount is ${formatNairaKobo(settings.max_amount_kobo)}.`;
  }
  if (settings.tenor_options_months.length && !req.tenor_months) p.tenorMonths = "Choose a repayment tenor.";
  if (!req.deduction_acknowledged_at) p.acknowledgement = `Confirm that you have read the ${bpsLabel(settings.deduction_rate_bps)} deduction and the net amount you will receive.`;
  if (!req.declaration_accepted_at) p.declaration = "Accept the declaration and consent.";
  const credit = await staffCreditProblem(q, req.id, new Date());
  if (credit) p.creditCheck = credit;
  if (settings.required_document_types.length) {
    const docs = (await q.query<{ category: string }>("SELECT DISTINCT category FROM staff_request_documents WHERE request_id = $1 AND removed_at IS NULL AND scan_status = 'CLEAN'", [req.id])).rows.map((r) => r.category);
    const missing = settings.required_document_types.filter((c) => !docs.includes(c));
    if (missing.length) p.documents = `Upload: ${missing.map((c) => STAFF_DOC_CATEGORIES[c as keyof typeof STAFF_DOC_CATEGORIES] ?? c).join(", ")}.`;
  }
  return p;
}

/**
 * Submit (or resubmit after a return). The server recomputes the figures and checks that the
 * applicant acknowledged exactly this net amount. Repeating a submission is harmless: a second call
 * on an already submitted request changes nothing and reports the existing submission.
 */
export async function submitStaffRequest(ctx: Ctx, id: string, opts: { lockVersion?: number | null; acknowledgedNetKobo?: string | null } = {}) {
  await requireStaffFinancing(ctx, "SUBMIT_STAFF_REQUEST", id);
  return guarded(ctx, id, "SUBMIT", async () => {
    const res = await withTx(async (tx) => {
      const actor = ctx.actor;
      if (!actor) throw forbidden();
      const req = await lockRequest(tx, id);
      if (req.applicant_id !== actor.staffId) throw forbidden("Only the applicant can submit this request.");
      if (req.status === "SUBMITTED" && req.submitted_at) return { req, duplicate: true };
      expectStatus(req, ["DRAFT", "RETURNED_FOR_CORRECTION"], "Submission");
      checkLock(req, opts.lockVersion);
      const settings = await settingsById(tx, req.settings_id);
      // Only a change that affects the figures or the submission rules requires a re-save.
      const cur = await currentSettings(tx);
      const terms = (x: typeof cur) => JSON.stringify([x.deduction_rate_bps, x.min_amount_kobo, x.max_amount_kobo, x.tenor_options_months, x.required_document_types]);
      if (cur.id !== settings.id && terms(cur) !== terms(settings)) throw conflict("The staff financing settings changed since you last saved. Save the form again to see the updated figures, then submit.");
      const problems = await submissionProblems(tx, req);
      if (Object.keys(problems).length) throw invalid("Complete the highlighted items before submitting.", problems);
      const f = computeStaffFinancing(Number(req.gross_kobo), settings.deduction_rate_bps);
      if (f.deductionKobo !== Number(req.deduction_kobo) || f.netKobo !== Number(req.net_kobo) || req.deduction_rate_bps !== settings.deduction_rate_bps) {
        throw conflict("The figures changed. Review the recalculated amounts and acknowledge them again.");
      }
      if (opts.acknowledgedNetKobo !== undefined && opts.acknowledgedNetKobo !== null && Number(opts.acknowledgedNetKobo) !== f.netKobo) {
        throw conflict("The net amount you acknowledged does not match the server's calculation. Review the figures and try again.");
      }
      const resubmission = req.submission_count > 0;
      const fresh = await transition(tx, ctx, req, {
        action: resubmission ? "RESUBMITTED" : "SUBMITTED",
        to: "SUBMITTED",
        role: "APPLICANT",
        outcome: "SUBMITTED",
        set: {
          submitted_at: ctx.now,
          first_submitted_at: req.first_submitted_at ?? ctx.now,
          submission_count: req.submission_count + 1,
          pm_reviewer_id: null,
          pm_claimed_at: null,
          unit_head_id: null,
          divisional_head_id: null,
        },
        details: { grossKobo: f.grossKobo, deductionRateBps: f.deductionRateBps, deductionKobo: f.deductionKobo, netKobo: f.netKobo, tenorMonths: req.tenor_months, settingsVersion: settings.version },
      });
      await notifyStaff(tx, ctx, fresh, "SUBMITTED", [req.applicant_id], "Staff financing request submitted", [
        `Your staff financing request ${req.ref} was ${resubmission ? "resubmitted" : "submitted"} and is in the Product Manager queue.`,
        "You can track its progress in the Staff Personal Request workspace.",
      ]);
      await notifyRole(tx, ctx, fresh, "QUEUE_PM", ["PRODUCT_MANAGER"], "Staff financing request awaiting review", [`A staff financing request (${req.ref}) is awaiting Product Manager review.`], [req.applicant_id]);
      return { req: fresh, duplicate: false };
    });
    return { ref: res.req.ref, submittedAt: res.req.submitted_at as Date, duplicate: res.duplicate };
  });
}

// ------------------------------------------------------------------ Product Manager

export async function claimPmReview(ctx: Ctx, id: string) {
  await requireStaffFinancing(ctx, "CLAIM_PM_REVIEW", id);
  return guarded(ctx, id, "PM_CLAIM", () =>
    withTx(async (tx) => {
      const req = await lockRequest(tx, id);
      if (req.status === "UNDER_PM_REVIEW" && req.pm_reviewer_id === ctx.actor?.staffId) return req;
      expectStatus(req, ["SUBMITTED"], "Starting the review");
      const actor = await requireActor(tx, ctx, req, "PRODUCT_MANAGER");
      return transition(tx, ctx, req, { action: "PM_REVIEW_STARTED", to: "UNDER_PM_REVIEW", role: "PRODUCT_MANAGER", set: { pm_reviewer_id: actor.staffId, pm_claimed_at: ctx.now } });
    }),
  );
}

export async function releasePmReview(ctx: Ctx, id: string) {
  await requireStaffFinancing(ctx, "RELEASE_PM_REVIEW", id);
  return guarded(ctx, id, "PM_RELEASE", () =>
    withTx(async (tx) => {
      const req = await lockRequest(tx, id);
      expectStatus(req, ["UNDER_PM_REVIEW"], "Releasing the review");
      const isAdmin = ctx.actor && (await holdsRole(tx, ctx.actor.staffId, "SUPER_ADMIN"));
      if (req.pm_reviewer_id !== ctx.actor?.staffId && !isAdmin) throw forbidden("Only the reviewing Product Manager or a Super Admin can release this review.");
      return transition(tx, ctx, req, { action: "PM_REVIEW_RELEASED", to: "SUBMITTED", role: isAdmin && req.pm_reviewer_id !== ctx.actor?.staffId ? "SUPER_ADMIN" : "PRODUCT_MANAGER", set: { pm_reviewer_id: null, pm_claimed_at: null } });
    }),
  );
}

export interface PmChecklist {
  accountVerified: boolean;
  salaryHistoryReviewed: boolean;
  repaymentWithinLimit: boolean;
}

export interface PmDecisionInput {
  action: "FORWARD" | "RETURN" | "DECLINE";
  checklist: PmChecklist;
  /** Optional figures the PM read from the salary records (manual, informational). */
  verifiedTakeHome?: string;
  monthlyRepayment?: string;
  recommendation?: string;
  comments?: string;
  confirmed?: boolean;
  lockVersion?: number | null;
}

export async function pmDecision(ctx: Ctx, id: string, input: PmDecisionInput) {
  await requireStaffFinancing(ctx, "PM_DECISION", id);
  return guarded(ctx, id, `PM_${input.action}`, () =>
    withTx(async (tx) => {
      const req = await lockRequest(tx, id);
      expectStatus(req, ["UNDER_PM_REVIEW"], "The Product Manager decision");
      checkLock(req, input.lockVersion);
      if (req.pm_reviewer_id !== ctx.actor?.staffId) throw forbidden("Only the Product Manager who started this review can decide it.");
      await requireActor(tx, ctx, req, "PRODUCT_MANAGER", { allowSelfIn: [req.pm_reviewer_id] });
      const comments = (input.comments ?? "").trim();
      const recommendation = (input.recommendation ?? "").trim();
      const takeHome = input.verifiedTakeHome?.trim() ? parseNairaToKobo(input.verifiedTakeHome) : null;
      const repayment = input.monthlyRepayment?.trim() ? parseNairaToKobo(input.monthlyRepayment) : null;
      if (input.verifiedTakeHome?.trim() && takeHome === null) throw invalid("Enter the take-home pay in naira.", { verifiedTakeHome: "Enter a naira amount." });
      if (input.monthlyRepayment?.trim() && repayment === null) throw invalid("Enter the monthly repayment in naira.", { monthlyRepayment: "Enter a naira amount." });
      const checklist = {
        accountVerified: !!input.checklist.accountVerified,
        salaryHistoryReviewed: !!input.checklist.salaryHistoryReviewed,
        repaymentWithinLimit: !!input.checklist.repaymentWithinLimit,
        verifiedTakeHomeKobo: takeHome,
        monthlyRepaymentKobo: repayment,
        method: "MANUAL (no payroll or core-banking API is connected)",
      };
      let to: StaffStatus;
      const set: Record<string, unknown> = {};
      let designated: string | null = null;
      if (input.action === "FORWARD") {
        const missing = [
          !checklist.accountVerified && "staff account verified",
          !checklist.salaryHistoryReviewed && "three months of salary history reviewed",
          !checklist.repaymentWithinLimit && "repayment obligation within 50% of take-home pay",
        ].filter(Boolean);
        if (missing.length) throw gate(`Forwarding is blocked until every check is confirmed: ${missing.join("; ")}.`);
        if (!input.confirmed) throw invalid("Confirm that you want to forward this request to the Unit Head.", { confirmed: "Confirmation required." });
        if (!recommendation) throw invalid("Enter your recommendation for the Unit Head.", { recommendation: "Recommendation required." });
        // The staff route has one configured Unit Head; the Product Manager does not choose.
        const uh = await routeUnitHead(tx, req);
        if (uh.problem || !uh.id) {
          await alertOperations(tx, ctx, req, "NO_ROUTE_UNIT_HEAD", "Staff financing route has no usable Unit Head", [`${req.ref} cannot be forwarded: ${uh.problem}`]);
          throw gate(`Forwarding is blocked: ${uh.problem}`);
        }
        designated = uh.id;
        set.unit_head_id = uh.id;
        to = "UNDER_UNIT_HEAD_REVIEW";
      } else {
        if (comments.length < 3) throw invalid("Explain the reason; the applicant will see it.", { comments: "Reason required." });
        to = input.action === "RETURN" ? "RETURNED_FOR_CORRECTION" : "DECLINED";
        Object.assign(set, returnOrDeclineColumns(input.action, req, ctx, comments));
      }
      await tx.query(
        `INSERT INTO staff_request_reviews (request_id, stage, action, actor_id, actor_role, submission_no, checklist, recommendation, comments, designated_next_id, from_status, to_status, created_at)
         VALUES ($1,'PRODUCT_MANAGER',$2,$3,'PRODUCT_MANAGER',$4,$5,$6,$7,$8,$9,$10,$11)`,
        [req.id, input.action, ctx.actor!.staffId, req.submission_count, JSON.stringify(checklist), recommendation || null, comments || null, designated, req.status, to, ctx.now],
      );
      const fresh = await transition(tx, ctx, req, {
        action: `PM_${input.action}`,
        to,
        role: "PRODUCT_MANAGER",
        outcome: input.action,
        comments: comments || recommendation || null,
        set,
        details: { checklist, designatedUnitHeadId: designated },
      });
      await afterDecisionNotices(tx, ctx, fresh, input.action, comments);
      if (input.action === "FORWARD") {
        await notifyStaff(tx, ctx, fresh, "QUEUE_UNIT_HEAD", [designated], "Staff financing request awaiting your decision", [`Staff financing request ${req.ref} has been reviewed by the Product Manager and awaits your decision as Unit Head.`]);
      }
      return fresh;
    }),
  );
}

function returnOrDeclineColumns(action: "RETURN" | "DECLINE", req: StaffRequestRow, ctx: Ctx, reason: string) {
  if (action === "RETURN") return { returned_at: ctx.now, returned_by: ctx.actor!.staffId, returned_from_status: req.status, return_reason: reason };
  return { declined_at: ctx.now, declined_by: ctx.actor!.staffId, decline_reason: reason };
}

async function afterDecisionNotices(tx: Tx, ctx: Ctx, req: StaffRequestRow, action: string, reason: string) {
  if (action === "RETURN") {
    await notifyStaff(tx, ctx, req, "RETURNED", [req.applicant_id], "Staff financing request returned for correction", [
      `Your staff financing request ${req.ref} was returned for correction.`,
      "Open the request to read the reason, correct it and resubmit.",
    ]);
  } else if (action === "DECLINE") {
    await notifyStaff(tx, ctx, req, "DECLINED", [req.applicant_id], "Staff financing request declined", [`Your staff financing request ${req.ref} was declined. Open the request to read the reason.`]);
  }
  void reason;
}

// ------------------------------------------------------------------ Unit Head and Divisional Head

export interface HeadDecisionInput {
  action: "APPROVE" | "RETURN" | "DECLINE";
  comments?: string;
  confirmed?: boolean;
  lockVersion?: number | null;
}

export async function unitHeadDecision(ctx: Ctx, id: string, input: HeadDecisionInput) {
  await requireStaffFinancing(ctx, "UNIT_HEAD_DECISION", id);
  return guarded(ctx, id, `UNIT_HEAD_${input.action}`, () =>
    withTx(async (tx) => {
      const req = await lockRequest(tx, id);
      expectStatus(req, ["UNDER_UNIT_HEAD_REVIEW"], "The Unit Head decision");
      checkLock(req, input.lockVersion);
      // Pending requests follow the Unit Head configured for the route now.
      const uh = await routeUnitHead(tx, req);
      if (uh.id !== ctx.actor?.staffId) throw forbidden("Only the Unit Head configured for the staff financing route can decide this request.");
      if (uh.problem) throw gate(uh.problem);
      await requireActor(tx, ctx, req, "UNIT_HEAD", { allowSelfIn: [req.unit_head_id, uh.id] });
      const comments = (input.comments ?? "").trim();
      let to: StaffStatus;
      let set: Record<string, unknown> = {};
      if (input.action === "APPROVE") {
        if (!input.confirmed) throw invalid("Confirm that you approve and forward the request to the Divisional Head.", { confirmed: "Confirmation required." });
        to = "UNDER_DIVISIONAL_HEAD_REVIEW";
        set.unit_head_id = ctx.actor!.staffId;
      } else {
        if (comments.length < 3) throw invalid("A reason is required; the applicant will see it.", { comments: "Reason required." });
        to = input.action === "RETURN" ? "RETURNED_FOR_CORRECTION" : "DECLINED";
        set = returnOrDeclineColumns(input.action, req, ctx, comments);
      }
      await insertReview(tx, ctx, req, "UNIT_HEAD", "UNIT_HEAD", input.action, comments, to);
      const fresh = await transition(tx, ctx, req, { action: `UNIT_HEAD_${input.action}`, to, role: "UNIT_HEAD", outcome: input.action, comments: comments || null, set });
      await afterDecisionNotices(tx, ctx, fresh, input.action, comments);
      if (input.action === "APPROVE") {
        const dh = await routeDivisionalHead(tx, fresh);
        if (dh.problem || !dh.id) {
          await alertOperations(tx, ctx, fresh, "NO_DIVISIONAL_HEAD", "Staff financing request cannot reach a Divisional Head", [`${req.ref} awaits final approval but ${dh.problem}`]);
        } else {
          await notifyStaff(tx, ctx, fresh, "QUEUE_DIVISIONAL_HEAD", [dh.id], "Staff financing request awaiting final approval", [`Staff financing request ${req.ref} awaits your final approval as Divisional Head.`]);
        }
      }
      return fresh;
    }),
  );
}

async function insertReview(tx: Tx, ctx: Ctx, req: StaffRequestRow, stage: string, role: string, action: string, comments: string, to: StaffStatus) {
  await tx.query(
    `INSERT INTO staff_request_reviews (request_id, stage, action, actor_id, actor_role, submission_no, comments, from_status, to_status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [req.id, stage, action, ctx.actor!.staffId, role, req.submission_count, comments || null, req.status, to, ctx.now],
  );
}

/** The financing terms frozen at final approval, and their fingerprint. */
export function approvedTermsOf(req: StaffRequestRow) {
  const terms = {
    ref: req.ref,
    applicantId: req.applicant_id,
    staffName: req.full_name,
    staffNumber: req.staff_number,
    grossKobo: Number(req.gross_kobo),
    deductionRateBps: req.deduction_rate_bps,
    deductionKobo: Number(req.deduction_kobo),
    netKobo: Number(req.net_kobo),
    tenorMonths: req.tenor_months ?? null,
    salaryAccountNumber: req.salary_account_number,
    salaryAccountName: req.salary_account_name,
  };
  return { terms, sha256: createHash("sha256").update(JSON.stringify(terms)).digest("hex") };
}

/** True when the stored approval fingerprint still matches the request's current figures. */
export function termsIntact(req: StaffRequestRow): boolean {
  if (!req.approved_at || !req.approved_terms_sha256) return false;
  const { sha256, terms } = approvedTermsOf(req);
  if (sha256 !== req.approved_terms_sha256) return false;
  const f = computeStaffFinancing(terms.grossKobo, terms.deductionRateBps);
  return f.deductionKobo === terms.deductionKobo && f.netKobo === terms.netKobo;
}

export async function divisionalHeadDecision(ctx: Ctx, id: string, input: HeadDecisionInput) {
  await requireStaffFinancing(ctx, "DIVISIONAL_HEAD_DECISION", id);
  const fresh = await guarded(ctx, id, `DIVISIONAL_HEAD_${input.action}`, () =>
    withTx(async (tx) => {
      const req = await lockRequest(tx, id);
      expectStatus(req, ["UNDER_DIVISIONAL_HEAD_REVIEW"], "The Divisional Head decision");
      checkLock(req, input.lockVersion);
      const actor = await requireActor(tx, ctx, req, "DIVISIONAL_HEAD");
      const comments = (input.comments ?? "").trim();
      let to: StaffStatus;
      let set: Record<string, unknown> = { divisional_head_id: actor.staffId };
      if (input.action === "APPROVE") {
        if (!input.confirmed) throw invalid("Confirm the final approval.", { confirmed: "Confirmation required." });
        const f = computeStaffFinancing(Number(req.gross_kobo), req.deduction_rate_bps);
        if (f.netKobo !== Number(req.net_kobo) || f.deductionKobo !== Number(req.deduction_kobo)) throw gate("The stored figures do not reproduce; approval stopped. Contact the system administrator.");
        const { terms, sha256 } = approvedTermsOf(req);
        set = { ...set, approved_at: ctx.now, approved_by: actor.staffId, approved_terms: JSON.stringify(terms), approved_terms_sha256: sha256 };
        to = "APPROVED";
      } else {
        if (comments.length < 3) throw invalid("A reason is required; the applicant will see it.", { comments: "Reason required." });
        to = input.action === "RETURN" ? "RETURNED_FOR_CORRECTION" : "DECLINED";
        set = { ...set, ...returnOrDeclineColumns(input.action, req, ctx, comments) };
      }
      await insertReview(tx, ctx, req, "DIVISIONAL_HEAD", "DIVISIONAL_HEAD", input.action, comments, to);
      let next = await transition(tx, ctx, req, { action: `DIVISIONAL_HEAD_${input.action}`, to, role: "DIVISIONAL_HEAD", outcome: input.action === "APPROVE" ? "FINAL_APPROVAL" : input.action, comments: comments || null, set });
      await afterDecisionNotices(tx, ctx, next, input.action, comments);
      if (input.action === "APPROVE") {
        await notifyStaff(tx, ctx, next, "APPROVED", [next.applicant_id], "Staff financing request approved", [`Your staff financing request ${next.ref} has received final approval. Your offer letter will follow.`]);
        next = await issueOffer(tx, ctx, next);
      }
      return next;
    }),
  );
  return fresh;
}

/**
 * Controlled amendment: a Divisional Head withdraws an approval before disbursement starts. The
 * approved terms are released (not changed), the offer is withdrawn, any disbursement assignment ends
 * and the request returns to the applicant; it must pass the full review route again.
 */
export async function amendApproval(ctx: Ctx, id: string, input: { reason: string; lockVersion?: number | null }) {
  await requireStaffFinancing(ctx, "AMEND_APPROVAL", id);
  return guarded(ctx, id, "AMEND", () =>
    withTx(async (tx) => {
      const req = await lockRequest(tx, id);
      expectStatus(req, ["APPROVED", "AWAITING_SIGNED_OFFER", "ASSIGNED_FOR_DISBURSEMENT"], "An amendment");
      checkLock(req, input.lockVersion);
      const actor = ctx.actor;
      if (!actor) throw forbidden();
      if (req.applicant_id === actor.staffId) throw forbidden("You cannot amend your own financing request.");
      if (!(await holdsRole(tx, actor.staffId, "DIVISIONAL_HEAD"))) throw forbidden("Only a Divisional Head can withdraw an approval for amendment.");
      const reason = (input.reason ?? "").trim();
      if (reason.length < 3) throw invalid("Explain what must be amended; the applicant will see it.", { reason: "Reason required." });
      await tx.query("UPDATE staff_request_assignments SET ended_at = $2 WHERE request_id = $1 AND ended_at IS NULL", [req.id, ctx.now]);
      await tx.query(
        `INSERT INTO staff_request_reviews (request_id, stage, action, actor_id, actor_role, submission_no, comments, from_status, to_status, created_at)
         VALUES ($1,'DIVISIONAL_HEAD','AMEND',$2,'DIVISIONAL_HEAD',$3,$4,$5,'RETURNED_FOR_CORRECTION',$6)`,
        [req.id, actor.staffId, req.submission_count, reason, req.status, ctx.now],
      );
      const fresh = await transition(tx, ctx, req, {
        action: "APPROVAL_WITHDRAWN_FOR_AMENDMENT",
        to: "RETURNED_FOR_CORRECTION",
        role: "DIVISIONAL_HEAD",
        outcome: "AMENDMENT",
        comments: reason,
        set: {
          approved_at: null,
          approved_by: null,
          approved_terms: null,
          approved_terms_sha256: null,
          offer_issued_at: null,
          offer_deadline_at: null,
          offer_document_id: null,
          offer_blocked_reason: null,
          offer_reminder_sent_at: null,
          signed_offer_document_id: null,
          signed_offer_received_at: null,
          disbursement_officer_id: null,
          disbursement_assigned_at: null,
          documentation_reviewed_at: null,
          documentation_reviewed_by: null,
          returned_at: ctx.now,
          returned_by: actor.staffId,
          returned_from_status: req.status,
          return_reason: `Amendment required: ${reason}`,
        },
        details: { previousTerms: req.approved_terms, previousTermsSha256: req.approved_terms_sha256 },
      });
      await afterDecisionNotices(tx, ctx, fresh, "RETURN", reason);
      return fresh;
    }),
  );
}

/** Applicant view of queue position for the dashboards. */
export async function myRequests(q: Db, staffId: string) {
  return (await q.query<StaffRequestRow>("SELECT * FROM staff_requests WHERE applicant_id = $1 ORDER BY created_at DESC", [staffId])).rows;
}

