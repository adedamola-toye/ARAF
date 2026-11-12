/**
 * Staff Personal Financing disbursement.
 *
 * No payment API is connected to this platform, so no transfer is ever simulated. The assigned
 * Disbursement Officer pays through the bank's core banking system and records the outcome here:
 * the transaction reference, value date, amount and evidence. The platform enforces the financial
 * controls before processing and makes completion idempotent (one disbursement per request, and a
 * transaction reference can never be used twice).
 */
import { randomInt } from "node:crypto";
import type { Db, Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { DomainError, conflict, forbidden, gate, invalid } from "../errors";
import { parseNairaToKobo } from "../money";
import { isValidDateString } from "../time";
import { holdsRole } from "../domain/access";
import { computeStaffFinancing, formatNairaKobo } from "@/lib/staff-financing";
import {
  alertOperations,
  auditDenied,
  checkLock,
  DISBURSEMENT_ROLES,
  expectStatus,
  lockRequest,
  notifyStaff,
  priorActors,
  recordEvent,
  requireActor,
  roleHolders,
  transition,
  type StaffRequestRow,
} from "./core";
import { termsIntact } from "./requests";
import { kickDocumentation } from "./pipeline";

/** Active, authorised Disbursement Officers who have not acted on (or applied for) this request. */
export async function eligibleDisbursementOfficers(q: Db, req: StaffRequestRow) {
  const exclude = new Set([req.applicant_id, ...priorActors(req).filter((p) => p !== req.disbursement_officer_id)]);
  return (await roleHolders(q, DISBURSEMENT_ROLES)).filter((h) => !exclude.has(h.id));
}

/**
 * Random assignment among eligible officers. If none is eligible the request waits (signed offer
 * received) and operations are alerted; it is never assigned to an unauthorised person.
 */
export async function assignDisbursementOfficer(tx: Tx, ctx: Ctx, req: StaffRequestRow): Promise<StaffRequestRow> {
  if (req.disbursement_officer_id) return req;
  const officers = await eligibleDisbursementOfficers(tx, req);
  if (!officers.length) {
    await recordEvent(tx, ctx, req, { action: "DISBURSEMENT_ASSIGNMENT_PENDING", role: "SYSTEM", comments: "No eligible, active Disbursement Officer is configured." });
    await alertOperations(tx, ctx, req, "NO_DISBURSEMENT_OFFICER", "No Disbursement Officer available", [
      `${req.ref} has a signed offer but no eligible, active Disbursement Officer could be assigned. Assign one from the staff financing operations page.`,
    ]);
    return req;
  }
  const pick = officers[randomInt(officers.length)];
  await tx.query(
    `INSERT INTO staff_request_assignments (request_id, officer_id, officer_role, method, eligible_count, assigned_at) VALUES ($1,$2,$3,'RANDOM',$4,$5)`,
    [req.id, pick.id, pick.role, officers.length, ctx.now],
  );
  const fresh = await transition(tx, ctx, req, {
    action: "DISBURSEMENT_OFFICER_ASSIGNED",
    to: "ASSIGNED_FOR_DISBURSEMENT",
    role: "SYSTEM",
    outcome: "RANDOM_ASSIGNMENT",
    set: { disbursement_officer_id: pick.id, disbursement_assigned_at: ctx.now },
    details: { officerId: pick.id, officerRole: pick.role, eligibleCount: officers.length, method: "RANDOM" },
  });
  await notifyStaff(tx, ctx, fresh, "QUEUE_DISBURSEMENT", [pick.id], "Staff financing request assigned to you for disbursement", [`Staff financing request ${req.ref} has been assigned to you for disbursement.`]);
  return fresh;
}

/** Super Admin: assign (when none was available) or reassign, with a recorded reason. */
export async function reassignDisbursementOfficer(ctx: Ctx, id: string, input: { officerId: string; reason: string }) {
  try {
    return await withTx(async (tx) => {
      const actor = ctx.actor;
      if (!actor || !(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can reassign disbursement work.");
      const req = await lockRequest(tx, id);
      const waiting = req.status === "AWAITING_SIGNED_OFFER" && req.signed_offer_received_at;
      if (!waiting) expectStatus(req, ["ASSIGNED_FOR_DISBURSEMENT", "DISBURSEMENT_IN_PROGRESS"], "Reassignment");
      if (req.applicant_id === actor.staffId) throw forbidden("You cannot assign your own financing request.");
      const reason = (input.reason ?? "").trim();
      if (reason.length < 3) throw invalid("Enter the reason for the reassignment.", { reason: "Reason required." });
      if (input.officerId === req.disbursement_officer_id) throw invalid("Choose a different officer.");
      const eligible = (await eligibleDisbursementOfficers(tx, req)).filter((o) => o.id !== req.disbursement_officer_id);
      const officer = eligible.find((o) => o.id === input.officerId);
      if (!officer) throw invalid("That person is not an eligible, active Disbursement Officer for this request.");
      await tx.query("UPDATE staff_request_assignments SET ended_at = $2 WHERE request_id = $1 AND ended_at IS NULL", [req.id, ctx.now]);
      await tx.query(
        `INSERT INTO staff_request_assignments (request_id, officer_id, officer_role, method, eligible_count, assigned_by, reason, assigned_at)
         VALUES ($1,$2,$3,'ADMIN_REASSIGNMENT',$4,$5,$6,$7)`,
        [req.id, officer.id, officer.role, eligible.length, actor.staffId, reason, ctx.now],
      );
      const fresh = await transition(tx, ctx, req, {
        action: "DISBURSEMENT_OFFICER_REASSIGNED",
        to: waiting ? "ASSIGNED_FOR_DISBURSEMENT" : req.status,
        role: "SUPER_ADMIN",
        comments: reason,
        set: { disbursement_officer_id: officer.id, disbursement_assigned_at: ctx.now, documentation_reviewed_at: null, documentation_reviewed_by: null },
        details: { from: req.disbursement_officer_id, to: officer.id },
      });
      await notifyStaff(tx, ctx, fresh, "QUEUE_DISBURSEMENT", [officer.id], "Staff financing request assigned to you for disbursement", [`Staff financing request ${req.ref} has been assigned to you for disbursement.`]);
      return fresh;
    });
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") await auditDenied(ctx, id, "REASSIGN", e.message);
    throw e;
  }
}

async function asAssignedOfficer(tx: Tx, ctx: Ctx, req: StaffRequestRow) {
  if (!ctx.actor || req.disbursement_officer_id !== ctx.actor.staffId) throw forbidden("Only the assigned Disbursement Officer can act on this request.");
  const role = (await Promise.all(DISBURSEMENT_ROLES.map(async (r) => ((await holdsRole(tx, ctx.actor!.staffId, r)) ? r : null)))).find(Boolean);
  if (!role) throw forbidden("Your Disbursement Officer role is no longer active.");
  await requireActor(tx, ctx, req, role, { allowSelfIn: [req.disbursement_officer_id] });
  return role;
}

/** Financial controls checked before processing and again before completion. Returns failures. */
export async function disbursementControls(q: Db, req: StaffRequestRow): Promise<string[]> {
  const fails: string[] = [];
  if (!req.approved_at) fails.push("Final approval is not on record.");
  if (!termsIntact(req)) fails.push("The approved terms fingerprint does not match.");
  if (!req.signed_offer_document_id || !req.signed_offer_received_at) fails.push("No signed offer has been received.");
  else {
    const d = (await q.query("SELECT scan_status, category FROM staff_request_documents WHERE id = $1", [req.signed_offer_document_id])).rows[0];
    if (!d || d.category !== "SIGNED_OFFER" || d.scan_status !== "CLEAN") fails.push("The signed offer is not a clean, accepted document.");
    if (req.offer_deadline_at && new Date(req.signed_offer_received_at) > new Date(req.offer_deadline_at)) fails.push("The signed offer was received after the deadline.");
  }
  if (req.status === "OFFER_EXPIRED" || req.expired_at) fails.push("The offer has expired.");
  if (!req.salary_account_number || !/^\d{10}$/.test(req.salary_account_number) || !req.salary_account_name) fails.push("Beneficiary (salary account) details are incomplete.");
  if (req.gross_kobo) {
    const f = computeStaffFinancing(Number(req.gross_kobo), req.deduction_rate_bps);
    if (f.netKobo !== Number(req.net_kobo)) fails.push("The net disbursement amount does not match the approved calculation.");
  }
  if (req.disbursed_at || req.disbursement_txn_ref) fails.push("This facility has already been disbursed.");
  return fails;
}

export async function reviewDisbursementDocumentation(ctx: Ctx, id: string, input: { lockVersion?: number | null }) {
  return withTx(async (tx) => {
    const req = await lockRequest(tx, id);
    const role = await asAssignedOfficer(tx, ctx, req);
    expectStatus(req, ["ASSIGNED_FOR_DISBURSEMENT"], "Documentation review");
    checkLock(req, input.lockVersion);
    return transition(tx, ctx, req, { action: "DISBURSEMENT_DOCUMENTATION_REVIEWED", role, set: { documentation_reviewed_at: ctx.now, documentation_reviewed_by: ctx.actor!.staffId } });
  });
}

/** Return the signed offer to the applicant (the original deadline still applies). */
export async function returnSignedOffer(ctx: Ctx, id: string, input: { reason: string; lockVersion?: number | null }) {
  return withTx(async (tx) => {
    const req = await lockRequest(tx, id);
    const role = await asAssignedOfficer(tx, ctx, req);
    expectStatus(req, ["ASSIGNED_FOR_DISBURSEMENT"], "Returning for correction");
    checkLock(req, input.lockVersion);
    const reason = (input.reason ?? "").trim();
    if (reason.length < 3) throw invalid("Explain what must be corrected; the applicant will see it.", { reason: "Reason required." });
    await tx.query("UPDATE staff_request_assignments SET ended_at = $2 WHERE request_id = $1 AND ended_at IS NULL", [req.id, ctx.now]);
    await tx.query(
      `INSERT INTO staff_request_reviews (request_id, stage, action, actor_id, actor_role, submission_no, comments, from_status, to_status, created_at)
       VALUES ($1,'DISBURSEMENT','RETURN',$2,$3,$4,$5,$6,'AWAITING_SIGNED_OFFER',$7)`,
      [req.id, ctx.actor!.staffId, role, req.submission_count, reason, req.status, ctx.now],
    );
    const fresh = await transition(tx, ctx, req, {
      action: "SIGNED_OFFER_RETURNED",
      to: "AWAITING_SIGNED_OFFER",
      role,
      outcome: "RETURN",
      comments: reason,
      set: { signed_offer_document_id: null, signed_offer_received_at: null, disbursement_officer_id: null, disbursement_assigned_at: null, documentation_reviewed_at: null, documentation_reviewed_by: null, return_reason: reason, returned_at: ctx.now, returned_by: ctx.actor!.staffId, returned_from_status: req.status },
    });
    await notifyStaff(tx, ctx, fresh, "SIGNED_OFFER_RETURNED", [fresh.applicant_id], "Your signed offer needs correction", [
      `The Disbursement Officer returned the signed offer for ${req.ref}. Open the request to read the reason and upload a corrected copy before the original deadline.`,
    ]);
    return fresh;
  });
}

export async function startDisbursement(ctx: Ctx, id: string, input: { instructionRef?: string; lockVersion?: number | null }) {
  try {
    return await withTx(async (tx) => {
      const req = await lockRequest(tx, id);
      if (req.status === "COMPLETED" || req.disbursed_at) throw conflict("This facility has already been disbursed. Duplicate processing is not allowed.");
      const role = await asAssignedOfficer(tx, ctx, req);
      expectStatus(req, ["ASSIGNED_FOR_DISBURSEMENT"], "Processing the disbursement");
      checkLock(req, input.lockVersion);
      if (!req.documentation_reviewed_at) throw gate("Review the documentation before processing the disbursement.");
      const fails = await disbursementControls(tx, req);
      if (fails.length) throw gate(`Disbursement blocked: ${fails.join(" ")}`);
      return transition(tx, ctx, req, {
        action: "DISBURSEMENT_STARTED",
        to: "DISBURSEMENT_IN_PROGRESS",
        role,
        set: { disbursement_started_at: ctx.now, disbursement_started_by: ctx.actor!.staffId, disbursement_instruction_ref: (input.instructionRef ?? "").trim().slice(0, 80) || null },
        details: { netKobo: Number(req.net_kobo) },
      });
    });
  } catch (e) {
    if (e instanceof DomainError && (e.code === "FORBIDDEN" || e.code === "CONFLICT")) await auditDenied(ctx, id, "DISBURSEMENT_START", e.message);
    throw e;
  }
}

export interface CompleteDisbursementInput {
  transactionRef: string;
  valueDate: string;
  amount: string;
  evidenceDocumentId: string;
  confirmed?: boolean;
  lockVersion?: number | null;
}

/** Record the completed transfer. Repeating the same confirmation is a no-op; anything else is refused. */
export async function completeDisbursement(ctx: Ctx, id: string, input: CompleteDisbursementInput) {
  const txnRef = (input.transactionRef ?? "").trim().toUpperCase();
  let fresh: StaffRequestRow;
  try {
    fresh = await withTx(async (tx) => {
      const req = await lockRequest(tx, id);
      if (req.status === "COMPLETED") {
        if (req.disbursement_txn_ref === txnRef && req.disbursement_confirmed_by === ctx.actor?.staffId) return req; // idempotent replay
        throw conflict("This facility has already been disbursed. Duplicate processing is not allowed.");
      }
      const role = await asAssignedOfficer(tx, ctx, req);
      expectStatus(req, ["DISBURSEMENT_IN_PROGRESS"], "Completing the disbursement");
      checkLock(req, input.lockVersion);
      const fields: Record<string, string> = {};
      if (!/^[A-Z0-9/\-_.]{6,64}$/.test(txnRef)) fields.transactionRef = "Enter the core banking transaction reference (6–64 letters, digits or / - _ .).";
      if (!isValidDateString(input.valueDate) || new Date(`${input.valueDate}T00:00:00+01:00`) > ctx.now) fields.valueDate = "Enter the value date (not in the future).";
      const amount = parseNairaToKobo(input.amount);
      if (amount === null) fields.amount = "Enter the amount paid.";
      else if (amount !== Number(req.net_kobo)) fields.amount = `The amount paid must equal the approved net amount, ${formatNairaKobo(req.net_kobo)}.`;
      const ev = (await tx.query("SELECT * FROM staff_request_documents WHERE id = $1 AND request_id = $2 AND removed_at IS NULL", [input.evidenceDocumentId, req.id])).rows[0];
      if (!ev || ev.category !== "DISBURSEMENT_EVIDENCE") fields.evidenceDocumentId = "Upload and select the disbursement evidence.";
      else if (ev.scan_status !== "CLEAN") fields.evidenceDocumentId = ev.scan_status === "QUARANTINED" ? "The evidence is still being scanned." : "The evidence failed the malware scan.";
      if (!input.confirmed) fields.confirmed = "Confirm that the transfer has been completed in core banking.";
      if (Object.keys(fields).length) throw invalid("Check the disbursement details.", fields);
      const dup = await tx.query("SELECT ref FROM staff_requests WHERE disbursement_txn_ref = $1 AND id <> $2", [txnRef, req.id]);
      if (dup.rowCount) throw conflict("This transaction reference is already recorded against another facility.");
      const fails = await disbursementControls(tx, req);
      if (fails.length) throw gate(`Disbursement blocked: ${fails.join(" ")}`);
      const done = await transition(tx, ctx, req, {
        action: "DISBURSEMENT_COMPLETED",
        to: "COMPLETED",
        role,
        outcome: "DISBURSED",
        documentIds: [ev.id],
        set: {
          disbursement_txn_ref: txnRef,
          disbursement_value_date: input.valueDate,
          disbursed_amount_kobo: amount,
          disbursement_evidence_document_id: ev.id,
          disbursed_at: ctx.now,
          disbursement_confirmed_by: ctx.actor!.staffId,
          completed_at: ctx.now,
          documentation_status: "PREPARING_ARCHIVE",
          doc_next_attempt_at: ctx.now,
        },
        details: { transactionRef: txnRef, valueDate: input.valueDate, amountKobo: amount },
      });
      await notifyStaff(tx, ctx, done, "DISBURSED", [done.applicant_id], "Your staff financing has been disbursed", [`The facility for ${req.ref} has been disbursed to your salary account.`]);
      return done;
    });
  } catch (e) {
    if (e instanceof DomainError && (e.code === "FORBIDDEN" || e.code === "CONFLICT")) await auditDenied(ctx, id, "DISBURSEMENT_COMPLETE", e.message);
    throw e;
  }
  // Documentation packaging starts immediately; the worker retries anything that fails.
  await kickDocumentation(fresh.id, ctx.now).catch((e) => console.error("[staff-fin] documentation pipeline deferred", e));
  return fresh;
}

export { alertOperations };
