/**
 * Retail post-approval operations: facility booking, payment confirmation and reconciliation,
 * fulfilment (POS deployment, delivery, installation, handover), repayment monitoring, arrears,
 * restructuring and settlement / closure.
 *
 * Application, facility, payment and fulfilment states are separate:
 *  - booking a facility never marks a payment as successful;
 *  - a payment is successful only when CONFIRMED events (with evidence or from an approved integration)
 *    net of reversals equal the booked principal, and the Disbursement team reconciles it;
 *  - completing the application's operational steps never closes an outstanding facility.
 */
import type { Db, Tx } from "../db";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { conflict, forbidden, gate, invalid, notFound } from "../errors";
import { formatKobo } from "../money";
import { isValidDateString, lagosDate } from "../time";
import { enqueueEmail } from "../notify/outbox";
import { caseLink, simpleEmail } from "../notify/templates";
import { PLATFORM_NAME } from "../brand";
import { holdsRole } from "./access";
import { chooseAssignee, type AppRow } from "./assignment";
import { computeAffordability, type AffordabilityInput, type AssessmentRules } from "./affordability";
import { configById, FULFILMENT_LABELS, type FulfilmentKind } from "./products";
import { retailDataSchema } from "./retail-data";
import { beneficiaryFor, beneficiaryProblems, type BeneficiarySnapshot } from "./vendors";
import { approvedRetailAssessment } from "./retail";
import { completeTask, lockApp, moveTo, persistApp, recordDecision, retentionDate, staffEmail, type TaskActionInput, type TaskRow } from "./workflow";

// ------------------------------------------------------------------ beneficiary revalidation

/** Compare the submitted beneficiary snapshot with the live register: any change requires re-approval. */
export async function beneficiaryRevalidation(q: Db, app: AppRow, now: Date): Promise<string[]> {
  const v = (await q.query("SELECT data FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0];
  const snap = (v?.data?.beneficiarySnapshot ?? null) as BeneficiarySnapshot | null;
  const cfg = app.product_config_id ? await configById(q, app.product_config_id) : null;
  if (!cfg?.config.beneficiaryRequired) return [];
  if (!snap) return ["No beneficiary snapshot was captured at submission."];
  const live = await beneficiaryFor(q, snap.accountId, now);
  const problems = beneficiaryProblems(live, snap.vendorId).filter((p) => !p.includes("not marked as supported"));
  if (live && (live.accountNumber !== snap.accountNumber || live.institutionCode !== snap.institutionCode || live.accountName !== snap.accountName)) {
    problems.push("The vendor account details changed in the register after approval.");
  }
  return problems;
}

// ------------------------------------------------------------------ facility booking

export interface FacilityRow {
  id: string;
  application_id: string;
  booking_ref: string;
  principal_kobo: string;
  total_payable_kobo: string;
  tenor_months: number;
  status: string;
  payment_status: string;
  fulfilment_status: string;
  booked_by: string;
  booked_at: Date;
}

export async function bookFacility(tx: Tx, ctx: Ctx, app: AppRow, task: TaskRow, input: TaskActionInput): Promise<string> {
  const b = input.facilityBooking;
  const errors: Record<string, string> = {};
  if (!b) throw invalid("Enter the facility booking details.");
  const ref = (b.bookingRef ?? "").trim();
  if (!/^[A-Za-z0-9\-/_.]{4,64}$/.test(ref)) errors.bookingRef = "Enter the core banking facility reference (4–64 letters, digits or - / _ .).";
  if (!isValidDateString(b.firstDueDate) || b.firstDueDate <= lagosDate(ctx.now)) errors.firstDueDate = "Enter the first repayment date (after today, Lagos time).";
  if (Object.keys(errors).length) throw invalid("Check the booking details.", errors);
  const existing = (await tx.query<FacilityRow>("SELECT * FROM facilities WHERE application_id = $1", [app.id])).rows[0];
  if (existing) throw conflict(`A facility is already booked for this request (${existing.booking_ref}).`);
  const dupRef = await tx.query("SELECT 1 FROM facilities WHERE booking_ref = $1", [ref]);
  if (dupRef.rowCount) throw conflict("This facility reference is already used by another booking.");
  const approved = await approvedRetailAssessment(tx, app.id);
  if (!approved) throw gate("No approved final assessment is on record for this request.");
  const rules = approved.rules as AssessmentRules;
  const inputs = { ...(approved.inputs as AffordabilityInput), firstDueDate: b.firstDueDate };
  const out = computeAffordability(rules, inputs);
  if (out.result === "BLOCKED" || out.totalPayableKobo === null) throw gate("The approved terms cannot be scheduled: the rate convention is not configured.");
  const principal = Number(inputs.principalKobo);
  if (b.principalKobo !== principal) throw invalid("The booked principal must equal the approved principal.", { principalKobo: `Approved principal is ${formatKobo(principal)}.` });
  const ben = await beneficiaryRevalidation(tx, app, ctx.now);
  if (ben.length) throw gate(`Beneficiary revalidation required: ${ben.join(" ")}`);
  await recordDecision(tx, ctx, app, task, "BOOK_FACILITY", null, null, approved.id);
  await completeTask(tx, ctx, task, "BOOK_FACILITY", { bookingRef: ref, note: "Facility booked; no payment is implied by booking." });
  const f = await tx.query<{ id: string }>(
    `INSERT INTO facilities (application_id, booking_ref, principal_kobo, total_payable_kobo, tenor_months, status, payment_status, fulfilment_status, retail_assessment_id, booked_by, booked_at)
     VALUES ($1,$2,$3,$4,$5,'BOOKED','NOT_STARTED','NOT_STARTED',$6,$7,$8) RETURNING id`,
    [app.id, ref, principal, out.totalPayableKobo, inputs.tenorMonths, approved.id, ctx.actor!.staffId, ctx.now],
  );
  for (const s of out.schedule) {
    await tx.query(`INSERT INTO repayment_instalments (application_id, facility_id, seq, due_date, amount_kobo) VALUES ($1,$2,$3,$4,$5)`, [app.id, f.rows[0].id, s.seq, s.dueDate, s.amountKobo]);
  }
  app.status = "BOOKED";
  await audit(tx, ctx, { action: "FACILITY_BOOKED", applicationId: app.id, stage: task.stage, details: { facilityId: f.rows[0].id, bookingRef: ref, principalKobo: principal, totalPayableKobo: out.totalPayableKobo, instalments: out.schedule.length, assessmentId: approved.id } });
  const chosen = await chooseAssignee(tx, app, "PAYMENT_RECONCILIATION", { preferred: app.do1_id });
  await moveTo(tx, ctx, app, "PAYMENT_RECONCILIATION", chosen);
  return `Facility ${ref} booked (${formatKobo(principal)}). Payment confirmation and reconciliation is with ${chosen.pool.find((p) => p.staff_id === chosen.staffId)?.full_name ?? "the assignment exception queue"}.`;
}

// ------------------------------------------------------------------ payment events + reconciliation

export interface PaymentEventInput {
  eventType: "INITIATED" | "CONFIRMED" | "FAILED" | "REVERSED";
  amountKobo: number;
  paymentRef: string;
  valueDate: string | null;
  evidenceDocumentIds: string[];
  note?: string | null;
}

export interface PaymentPosition {
  confirmedKobo: number;
  reversedKobo: number;
  netKobo: number;
  pendingRefs: string[];
  status: "NOT_STARTED" | "PENDING" | "PARTIAL" | "CONFIRMED" | "FAILED" | "REVERSED";
}

export async function paymentPosition(q: Db, facilityId: string, principal: number): Promise<PaymentPosition> {
  const ev = (await q.query<{ event_type: string; amount_kobo: string; payment_ref: string }>("SELECT event_type, amount_kobo, payment_ref FROM payment_events WHERE facility_id = $1 ORDER BY recorded_at", [facilityId])).rows;
  const byRef = new Map<string, Set<string>>();
  let confirmed = 0;
  let reversed = 0;
  for (const e of ev) {
    if (!byRef.has(e.payment_ref)) byRef.set(e.payment_ref, new Set());
    byRef.get(e.payment_ref)!.add(e.event_type);
    if (e.event_type === "CONFIRMED") confirmed += Number(e.amount_kobo);
    if (e.event_type === "REVERSED") reversed += Number(e.amount_kobo);
  }
  const pendingRefs = [...byRef.entries()].filter(([, s]) => s.has("INITIATED") && !s.has("CONFIRMED") && !s.has("FAILED")).map(([r]) => r);
  const net = confirmed - reversed;
  let status: PaymentPosition["status"] = "NOT_STARTED";
  if (!ev.length) status = "NOT_STARTED";
  else if (pendingRefs.length) status = "PENDING";
  else if (net === principal) status = "CONFIRMED";
  else if (net > 0) status = "PARTIAL";
  else if (reversed > 0) status = "REVERSED";
  else status = "FAILED";
  return { confirmedKobo: confirmed, reversedKobo: reversed, netKobo: net, pendingRefs, status };
}

/**
 * Record a payment event (Disbursement team at reconciliation, or an approved integration). Duplicate
 * events (same reference and type) are ignored idempotently. A new attempt may not be initiated while an
 * earlier attempt's outcome is uncertain. Manual events need evidence.
 */
export async function recordPaymentEvent(ctx: Ctx, appId: string, e: PaymentEventInput, source: "MANUAL_EVIDENCE" | "INTEGRATION" = "MANUAL_EVIDENCE") {
  const actor = ctx.actor;
  return withTx(async (tx) => {
    const app = await lockApp(tx, appId);
    const fac = (await tx.query<FacilityRow>("SELECT * FROM facilities WHERE application_id = $1 FOR UPDATE", [appId])).rows[0];
    if (!fac) throw gate("No facility has been booked for this request.");
    if (source === "MANUAL_EVIDENCE") {
      if (!actor) throw forbidden();
      const task = (await tx.query("SELECT * FROM tasks WHERE application_id = $1 AND status = 'OPEN'", [appId])).rows[0];
      if (!task || task.stage !== "PAYMENT_RECONCILIATION" || task.assignee_id !== actor.staffId || !(await holdsRole(tx, actor.staffId, task.assignee_role))) {
        throw forbidden("Payment outcomes are recorded by the Disbursement officer assigned to payment reconciliation.");
      }
    }
    const ref = (e.paymentRef ?? "").trim();
    const errors: Record<string, string> = {};
    if (!["INITIATED", "CONFIRMED", "FAILED", "REVERSED"].includes(e.eventType)) errors.eventType = "Choose the payment outcome.";
    if (!/^[A-Za-z0-9\-/_.]{4,64}$/.test(ref)) errors.paymentRef = "Enter the payment reference (4–64 letters, digits or - / _ .).";
    if (!Number.isSafeInteger(e.amountKobo) || e.amountKobo < 0) errors.amount = "Enter the amount.";
    if (e.eventType === "CONFIRMED" && !isValidDateString(e.valueDate ?? "")) errors.valueDate = "Enter the value date.";
    const evidence = e.evidenceDocumentIds.length
      ? (await tx.query<{ id: string }>("SELECT id FROM documents WHERE application_id = $1 AND id = ANY($2::uuid[]) AND category = 'PAYMENT_EVIDENCE' AND scan_status = 'CLEAN' AND superseded_at IS NULL", [appId, e.evidenceDocumentIds])).rows.map((r) => r.id)
      : [];
    if (source === "MANUAL_EVIDENCE" && e.eventType !== "INITIATED" && !evidence.length) errors.evidence = "Attach the payment evidence (upload it as payment evidence first).";
    if (Object.keys(errors).length) throw invalid(`Check the payment details: ${Object.values(errors).join(" ")}`, errors);
    const dup = (await tx.query("SELECT * FROM payment_events WHERE payment_ref = $1 AND event_type = $2", [ref, e.eventType])).rows[0];
    if (dup) {
      if (dup.facility_id !== fac.id) throw conflict("This payment reference belongs to another facility.");
      return { duplicate: true, position: await paymentPosition(tx, fac.id, Number(fac.principal_kobo)) };
    }
    const prior = (await tx.query<{ event_type: string; amount_kobo: string; facility_id: string }>("SELECT event_type, amount_kobo, facility_id FROM payment_events WHERE payment_ref = $1", [ref])).rows;
    if (prior.some((p) => p.facility_id !== fac.id)) throw conflict("This payment reference belongs to another facility.");
    const pos = await paymentPosition(tx, fac.id, Number(fac.principal_kobo));
    if (e.eventType === "INITIATED" && pos.pendingRefs.length) throw gate(`Reconcile the uncertain payment ${pos.pendingRefs.join(", ")} (confirmed or failed) before initiating another attempt.`);
    if (e.eventType === "INITIATED" && pos.netKobo >= Number(fac.principal_kobo)) throw gate("The booked principal has already been confirmed as paid.");
    if (e.eventType === "REVERSED" && !prior.some((p) => p.event_type === "CONFIRMED")) throw invalid("A reversal must reference a confirmed payment.", { paymentRef: "No confirmed payment with this reference." });
    if (e.eventType === "REVERSED" && e.amountKobo > Number(prior.find((p) => p.event_type === "CONFIRMED")!.amount_kobo)) throw invalid("The reversal exceeds the confirmed amount.", { amount: "Too large." });
    if (e.eventType === "CONFIRMED" && pos.netKobo + e.amountKobo > Number(fac.principal_kobo)) throw gate(`Confirmed payments would exceed the booked principal (${formatKobo(Number(fac.principal_kobo))}). Record a reversal or investigate before confirming.`);
    if ((e.eventType === "CONFIRMED" || e.eventType === "FAILED") && !prior.some((p) => p.event_type === "INITIATED")) {
      // Allow confirmation without a separately recorded initiation, but keep the attempt recorded once.
      await tx.query(
        `INSERT INTO payment_events (facility_id, application_id, event_type, amount_kobo, payment_ref, value_date, source, evidence_document_ids, beneficiary_snapshot, note, recorded_by, recorded_at)
         VALUES ($1,$2,'INITIATED',$3,$4,NULL,$5,'{}',$6,'Initiation inferred from outcome',$7,$8)`,
        [fac.id, appId, e.amountKobo, ref, source, JSON.stringify(await snapshotFor(tx, app)), actor?.staffId ?? null, ctx.now],
      );
    }
    await tx.query(
      `INSERT INTO payment_events (facility_id, application_id, event_type, amount_kobo, payment_ref, value_date, source, evidence_document_ids, beneficiary_snapshot, note, recorded_by, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [fac.id, appId, e.eventType, e.amountKobo, ref, e.valueDate || null, source, evidence, JSON.stringify(await snapshotFor(tx, app)), (e.note ?? "").trim() || null, actor?.staffId ?? null, ctx.now],
    );
    const after = await paymentPosition(tx, fac.id, Number(fac.principal_kobo));
    await tx.query("UPDATE facilities SET payment_status = $2 WHERE id = $1 AND payment_status <> 'RECONCILED'", [fac.id, after.status]);
    await audit(tx, ctx, { action: `PAYMENT_${e.eventType}`, actorRole: actor ? "DISBURSEMENT_OFFICER_1" : null, applicationId: appId, stage: app.stage, details: { facilityId: fac.id, paymentRef: ref, amountKobo: e.amountKobo, source, evidence, position: after } });
    return { duplicate: false, position: after };
  });
}

async function snapshotFor(tx: Tx, app: AppRow) {
  const v = (await tx.query("SELECT data FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0];
  return v?.data?.beneficiarySnapshot ?? {};
}

export async function reconcilePayment(tx: Tx, ctx: Ctx, app: AppRow, task: TaskRow, _input: TaskActionInput): Promise<string> {
  const fac = (await tx.query<FacilityRow>("SELECT * FROM facilities WHERE application_id = $1 FOR UPDATE", [app.id])).rows[0];
  if (!fac) throw gate("No facility is booked.");
  if (fac.payment_status === "RECONCILED") throw conflict("Payment is already reconciled.");
  const principal = Number(fac.principal_kobo);
  const pos = await paymentPosition(tx, fac.id, principal);
  if (pos.status !== "CONFIRMED") {
    throw gate(
      pos.status === "PENDING"
        ? `Payment ${pos.pendingRefs.join(", ")} has an uncertain outcome. Record it as confirmed or failed before reconciling.`
        : `Confirmed payments net of reversals (${formatKobo(pos.netKobo)}) do not equal the booked principal (${formatKobo(principal)}).`,
    );
  }
  const ben = await beneficiaryRevalidation(tx, app, ctx.now);
  if (ben.length) throw gate(`Beneficiary revalidation required: ${ben.join(" ")}`);
  const confirmations = (await tx.query<{ payment_ref: string; value_date: string; amount_kobo: string }>("SELECT payment_ref, to_char(value_date,'YYYY-MM-DD') AS value_date, amount_kobo FROM payment_events WHERE facility_id = $1 AND event_type = 'CONFIRMED' ORDER BY recorded_at", [fac.id])).rows;
  const last = confirmations.at(-1)!;
  await recordDecision(tx, ctx, app, task, "RECONCILE_PAYMENT", null);
  await completeTask(tx, ctx, task, "RECONCILE_PAYMENT", { confirmedKobo: pos.confirmedKobo, reversedKobo: pos.reversedKobo, references: confirmations.map((c) => c.payment_ref) });
  // The existing disbursement record (used by reports and repayment prompts) is written only now.
  const d = await tx.query<{ id: string }>(
    `INSERT INTO disbursements (application_id, amount_kobo, approved_amount_kobo, disbursed_on, transaction_ref, recorded_by, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (application_id) DO NOTHING RETURNING id`,
    [app.id, pos.netKobo, principal, last.value_date, confirmations.length === 1 ? last.payment_ref : `${last.payment_ref}+${confirmations.length - 1}`, ctx.actor!.staffId, ctx.now],
  );
  if (!d.rowCount) throw conflict("A disbursement is already recorded for this request.");
  await tx.query("UPDATE repayment_instalments SET disbursement_id = $2 WHERE facility_id = $1", [fac.id, d.rows[0].id]);
  await tx.query("UPDATE facilities SET status = 'ACTIVE', payment_status = 'RECONCILED', reconciled_by = $2, reconciled_at = $3 WHERE id = $1", [fac.id, ctx.actor!.staffId, ctx.now]);
  await tx.query("UPDATE applications SET disbursed_at = $2, repayment_prompts_active_at = $2 WHERE id = $1", [app.id, ctx.now]);
  // Post-disbursement tasks (e.g. Vendor Financing POS deployment) are created only now.
  const cfg = app.product_config_id ? await configById(tx, app.product_config_id) : null;
  const steps = cfg?.config.fulfilmentSteps ?? [];
  for (const kind of steps) {
    await tx.query(
      `INSERT INTO fulfilment_tasks (application_id, kind, status, created_at, created_reason) VALUES ($1,$2,'OPEN',$3,'Created after payment confirmed and reconciled') ON CONFLICT (application_id, kind) DO NOTHING`,
      [app.id, kind, ctx.now],
    );
  }
  await tx.query("UPDATE facilities SET fulfilment_status = $2 WHERE id = $1", [fac.id, steps.length ? "IN_PROGRESS" : "NOT_APPLICABLE"]);
  await audit(tx, ctx, { action: "PAYMENT_RECONCILED", applicationId: app.id, stage: task.stage, details: { facilityId: fac.id, netKobo: pos.netKobo, references: confirmations.map((c) => c.payment_ref), fulfilmentTasks: steps } });
  const recipients = [await staffEmail(tx, app.initiator_id), await staffEmail(tx, app.assigned_rm_id), await staffEmail(tx, app.pack_co3_id)].filter((x): x is string => !!x);
  await enqueueEmail(tx, ctx.now, {
    kind: "DISBURSED",
    dedupeKey: `disbursed:${app.id}`,
    applicationId: app.id,
    to: recipients,
    subject: `${PLATFORM_NAME} ${app.ref}: payment confirmed and reconciled`,
    text: simpleEmail([
      `Payment for ${app.ref} (${app.customer_name}, ${app.product_label}) is confirmed and reconciled.`,
      `Facility ${fac.booking_ref}: ${formatKobo(principal)}; value date ${last.value_date}.`,
      steps.length ? `Post-disbursement tasks created: ${steps.map((s) => FULFILMENT_LABELS[s]).join(", ")}.` : "",
      "",
      caseLink(app.id),
    ]),
  });
  const chosen = await chooseAssignee(tx, app, "COMPLETION", { preferred: app.pack_co3_id });
  await moveTo(tx, ctx, app, "COMPLETION", chosen);
  return `Payment reconciled (${formatKobo(pos.netKobo)}). The facility is active.${steps.length ? ` Post-disbursement tasks created: ${steps.map((s) => FULFILMENT_LABELS[s]).join(", ")}.` : ""}`;
}

// ------------------------------------------------------------------ fulfilment

export async function recordFulfilmentTask(ctx: Ctx, appId: string, kind: FulfilmentKind, p: { evidenceDocumentIds: string[]; note: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    const app = await lockApp(tx, appId);
    const task = (await tx.query("SELECT * FROM tasks WHERE application_id = $1 AND status = 'OPEN'", [appId])).rows[0];
    const isOwner = task?.stage === "FULFILMENT" && task.assignee_id === actor.staffId;
    const isAssignedRm = app.assigned_rm_id === actor.staffId && task?.stage === "FULFILMENT";
    if (!isOwner && !isAssignedRm) throw forbidden("Fulfilment tasks are completed by the initiator (or assigned RM) at the fulfilment stage.");
    const ft = (await tx.query("SELECT * FROM fulfilment_tasks WHERE application_id = $1 AND kind = $2 FOR UPDATE", [appId, kind])).rows[0];
    if (!ft) throw notFound("No such fulfilment task.");
    if (ft.status === "DONE") return { duplicate: true };
    const ev = p.evidenceDocumentIds.length ? (await tx.query<{ id: string }>("SELECT id FROM documents WHERE application_id = $1 AND id = ANY($2::uuid[]) AND category = 'FULFILMENT_EVIDENCE' AND scan_status = 'CLEAN'", [appId, p.evidenceDocumentIds])).rows.map((r) => r.id) : [];
    if (!ev.length) throw invalid("Attach the evidence (upload it as fulfilment evidence first).", { evidence: "Evidence required." });
    if ((p.note ?? "").trim().length < 5) throw invalid("Record what was done (e.g. POS terminal ID, delivery note number).", { note: "Note required." });
    await tx.query("UPDATE fulfilment_tasks SET status = 'DONE', completed_by = $3, completed_at = $4, evidence_document_ids = $5, note = $6 WHERE application_id = $1 AND kind = $2", [appId, kind, actor.staffId, ctx.now, ev, p.note.trim()]);
    await audit(tx, ctx, { action: "FULFILMENT_TASK_COMPLETED", applicationId: appId, stage: app.stage, details: { kind, evidence: ev, note: p.note.trim() } });
    return { duplicate: false };
  });
}

export async function completeFulfilment(tx: Tx, ctx: Ctx, app: AppRow, task: TaskRow): Promise<string> {
  const open = (await tx.query<{ kind: FulfilmentKind }>("SELECT kind FROM fulfilment_tasks WHERE application_id = $1 AND status = 'OPEN'", [app.id])).rows;
  if (open.length) throw gate(`Complete with evidence: ${open.map((o) => FULFILMENT_LABELS[o.kind]).join(", ")}.`);
  await recordDecision(tx, ctx, app, task, "COMPLETE_FULFILMENT", null);
  await completeTask(tx, ctx, task, "COMPLETE_FULFILMENT");
  await tx.query("UPDATE facilities SET fulfilment_status = CASE WHEN fulfilment_status = 'NOT_APPLICABLE' THEN fulfilment_status ELSE 'COMPLETED' END WHERE application_id = $1", [app.id]);
  await tx.query("UPDATE applications SET completed_at = $2 WHERE id = $1", [app.id, ctx.now]);
  await moveTo(tx, ctx, app, "COMPLETED", null);
  return "Application completed. The facility remains active until it is fully settled and closed.";
}

// ------------------------------------------------------------------ servicing: repayments, arrears, restructuring, closure

export interface FacilityPosition {
  facility: FacilityRow;
  dueToDateKobo: number;
  receivedKobo: number;
  reversedKobo: number;
  paidKobo: number;
  outstandingKobo: number;
  overdueKobo: number;
  nextDue: { dueDate: string; amountKobo: number } | null;
  daysPastDue: number;
}

export async function facilityPosition(q: Db, facilityId: string, asOf: string): Promise<FacilityPosition> {
  const facility = (await q.query<FacilityRow>("SELECT * FROM facilities WHERE id = $1", [facilityId])).rows[0];
  if (!facility) throw notFound();
  const inst = (await q.query<{ due_date: string; amount_kobo: string }>("SELECT to_char(due_date,'YYYY-MM-DD') AS due_date, amount_kobo FROM repayment_instalments WHERE facility_id = $1 ORDER BY seq", [facilityId])).rows;
  const ev = (await q.query<{ event_type: string; amount_kobo: string }>("SELECT event_type, amount_kobo FROM repayment_events WHERE facility_id = $1", [facilityId])).rows;
  const received = ev.filter((e) => e.event_type === "RECEIVED").reduce((s, e) => s + Number(e.amount_kobo), 0);
  const reversed = ev.filter((e) => e.event_type === "REVERSED").reduce((s, e) => s + Number(e.amount_kobo), 0);
  const paid = received - reversed;
  const due = inst.filter((i) => i.due_date <= asOf).reduce((s, i) => s + Number(i.amount_kobo), 0);
  const total = Number(facility.total_payable_kobo);
  let cum = 0;
  let firstUnpaid: string | null = null;
  for (const i of inst) {
    cum += Number(i.amount_kobo);
    if (cum > paid) {
      firstUnpaid = i.due_date;
      break;
    }
  }
  const next = inst.map((i) => ({ dueDate: i.due_date, amountKobo: Number(i.amount_kobo) })).find((i) => i.dueDate > asOf) ?? null;
  const overdue = Math.max(0, due - paid);
  const dpd = overdue > 0 && firstUnpaid ? Math.round((Date.parse(asOf) - Date.parse(firstUnpaid)) / 86_400_000) : 0;
  return { facility, dueToDateKobo: due, receivedKobo: received, reversedKobo: reversed, paidKobo: paid, outstandingKobo: Math.max(0, total - paid), overdueKobo: overdue, nextDue: next, daysPastDue: dpd };
}

async function requireCollections(tx: Tx, staffId: string) {
  if (!(await holdsRole(tx, staffId, "COLLECTIONS_OFFICER"))) throw forbidden("Repayments and servicing actions are recorded by Collections and servicing officers.");
}

/** Record a repayment (manual with evidence, or from an integration). Idempotent per facility + reference. */
export async function recordRepayment(ctx: Ctx, facilityId: string, p: { eventType: "RECEIVED" | "REVERSED"; amountKobo: number; valueDate: string; reference: string; evidenceDocumentIds: string[] }, source: "MANUAL_EVIDENCE" | "INTEGRATION" = "MANUAL_EVIDENCE") {
  const actor = ctx.actor;
  return withTx(async (tx) => {
    if (source === "MANUAL_EVIDENCE") {
      if (!actor) throw forbidden();
      await requireCollections(tx, actor.staffId);
    }
    const fac = (await tx.query<FacilityRow>("SELECT * FROM facilities WHERE id = $1 FOR UPDATE", [facilityId])).rows[0];
    if (!fac) throw notFound();
    if (!["ACTIVE", "IN_ARREARS", "RESTRUCTURED"].includes(fac.status)) throw gate("Repayments can be recorded only on an active facility.");
    const ref = (p.reference ?? "").trim();
    const errors: Record<string, string> = {};
    if (!/^[A-Za-z0-9\-/_.]{4,64}$/.test(ref)) errors.reference = "Enter the repayment reference.";
    if (!Number.isSafeInteger(p.amountKobo) || p.amountKobo <= 0) errors.amount = "Enter the amount.";
    if (!isValidDateString(p.valueDate) || p.valueDate > lagosDate(ctx.now)) errors.valueDate = "Enter the value date (not in the future).";
    const ev = p.evidenceDocumentIds.length ? (await tx.query<{ id: string }>("SELECT id FROM documents WHERE application_id = $1 AND id = ANY($2::uuid[]) AND category = 'REPAYMENT_EVIDENCE' AND scan_status = 'CLEAN'", [fac.application_id, p.evidenceDocumentIds])).rows.map((r) => r.id) : [];
    if (source === "MANUAL_EVIDENCE" && !ev.length) errors.evidence = "Attach the repayment evidence.";
    if (Object.keys(errors).length) throw invalid(`Check the repayment details: ${Object.values(errors).join(" ")}`, errors);
    const dup = await tx.query("SELECT 1 FROM repayment_events WHERE facility_id = $1 AND reference = $2 AND event_type = $3", [facilityId, ref, p.eventType]);
    if (dup.rowCount) return { duplicate: true, position: await facilityPosition(tx, facilityId, lagosDate(ctx.now)) };
    const before = await facilityPosition(tx, facilityId, lagosDate(ctx.now));
    if (p.eventType === "RECEIVED" && p.amountKobo > before.outstandingKobo) throw gate(`The repayment exceeds the outstanding balance (${formatKobo(before.outstandingKobo)}). Record the excess separately.`);
    if (p.eventType === "REVERSED") {
      const orig = await tx.query("SELECT amount_kobo FROM repayment_events WHERE facility_id = $1 AND reference = $2 AND event_type = 'RECEIVED'", [facilityId, ref]);
      if (!orig.rowCount || Number(orig.rows[0].amount_kobo) < p.amountKobo) throw invalid("A reversal must match a recorded repayment.", { reference: "No matching repayment." });
    }
    await tx.query(
      `INSERT INTO repayment_events (facility_id, event_type, amount_kobo, value_date, reference, source, evidence_document_ids, recorded_by, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [facilityId, p.eventType, p.amountKobo, p.valueDate, ref, source, ev, actor?.staffId ?? null, ctx.now],
    );
    const after = await facilityPosition(tx, facilityId, lagosDate(ctx.now));
    const status = after.outstandingKobo === 0 ? "SETTLED" : after.overdueKobo > 0 ? "IN_ARREARS" : fac.status === "RESTRUCTURED" ? "RESTRUCTURED" : "ACTIVE";
    await tx.query("UPDATE facilities SET status = $2::text, settled_at = CASE WHEN $2::text = 'SETTLED' THEN $3::timestamptz ELSE NULL END WHERE id = $1", [facilityId, status, ctx.now]);
    await audit(tx, ctx, { action: `REPAYMENT_${p.eventType}`, actorRole: actor ? "COLLECTIONS_OFFICER" : null, applicationId: fac.application_id, details: { facilityId, reference: ref, amountKobo: p.amountKobo, source, evidence: ev, outstandingKobo: after.outstandingKobo, status } });
    return { duplicate: false, position: after };
  });
}

/** Worker / screen: move facilities with overdue amounts into arrears (and back when cured). */
export async function refreshArrears(q: Db, now: Date) {
  const ids = (await q.query<{ id: string; status: string }>("SELECT id, status FROM facilities WHERE status IN ('ACTIVE','IN_ARREARS','RESTRUCTURED')")).rows;
  let changed = 0;
  for (const f of ids) {
    const p = await facilityPosition(q, f.id, lagosDate(now));
    const next = p.overdueKobo > 0 ? "IN_ARREARS" : f.status === "IN_ARREARS" ? "ACTIVE" : f.status;
    if (next !== f.status) {
      await q.query("UPDATE facilities SET status = $2 WHERE id = $1", [f.id, next]);
      changed++;
    }
  }
  return changed;
}

export async function recordServicingAction(ctx: Ctx, facilityId: string, p: { kind: "ARREARS_FOLLOW_UP" | "RECOVERY_NOTE" | "RESTRUCTURE_REQUEST"; note: string; proposal?: Record<string, unknown> | null }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    await requireCollections(tx, actor.staffId);
    const fac = (await tx.query<FacilityRow & { application_id: string }>("SELECT * FROM facilities WHERE id = $1", [facilityId])).rows[0];
    if (!fac) throw notFound();
    if ((p.note ?? "").trim().length < 5) throw invalid("Record the follow-up details.", { note: "Note required." });
    let approverRole: string | null = null;
    let status = "RECORDED";
    if (p.kind === "RESTRUCTURE_REQUEST") {
      const app = (await tx.query("SELECT product_config_id FROM applications WHERE id = $1", [fac.application_id])).rows[0];
      const cfg = app?.product_config_id ? await configById(tx, app.product_config_id) : null;
      approverRole = cfg?.config.servicing.restructureApproverRole ?? null;
      if (!approverRole) throw gate("Restructuring approval authority is not configured for this product. An administrator must configure it before a restructure can be requested.");
      status = "REQUESTED";
    }
    const r = await tx.query<{ id: string }>(
      `INSERT INTO servicing_actions (facility_id, kind, note, proposal, status, approver_role, recorded_by, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [facilityId, p.kind, p.note.trim(), p.proposal ? JSON.stringify(p.proposal) : null, status, approverRole, actor.staffId, ctx.now],
    );
    await audit(tx, ctx, { action: `SERVICING_${p.kind}`, actorRole: "COLLECTIONS_OFFICER", applicationId: fac.application_id, reason: p.note.trim(), details: { facilityId, actionId: r.rows[0].id, approverRole } });
    return { id: r.rows[0].id };
  });
}

export async function decideRestructure(ctx: Ctx, actionId: string, approve: boolean, note: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    const a = (await tx.query("SELECT * FROM servicing_actions WHERE id = $1 FOR UPDATE", [actionId])).rows[0];
    if (!a || a.kind !== "RESTRUCTURE_REQUEST") throw notFound();
    if (a.status !== "REQUESTED") throw conflict("Already decided.");
    if (!(await holdsRole(tx, actor.staffId, a.approver_role))) throw forbidden("Only the configured restructuring authority can decide.");
    if (a.recorded_by === actor.staffId) throw forbidden("The requester cannot approve their own restructure.");
    if ((note ?? "").trim().length < 5) throw invalid("Record the decision basis.", { note: "Note required." });
    await tx.query("UPDATE servicing_actions SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5 WHERE id = $1", [actionId, approve ? "APPROVED" : "DECLINED", actor.staffId, ctx.now, note.trim()]);
    if (approve) await tx.query("UPDATE facilities SET status = 'RESTRUCTURED' WHERE id = $1", [a.facility_id]);
    await audit(tx, ctx, { action: approve ? "RESTRUCTURE_APPROVED" : "RESTRUCTURE_DECLINED", actorRole: a.approver_role, reason: note.trim(), details: { actionId, facilityId: a.facility_id } });
  });
}

/** Close a fully settled facility. Never closes while any amount is outstanding. */
export async function closeFacility(ctx: Ctx, facilityId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    await requireCollections(tx, actor.staffId);
    const fac = (await tx.query<FacilityRow>("SELECT * FROM facilities WHERE id = $1 FOR UPDATE", [facilityId])).rows[0];
    if (!fac) throw notFound();
    if (fac.status === "CLOSED") throw conflict("The facility is already closed.");
    const pos = await facilityPosition(tx, facilityId, lagosDate(ctx.now));
    if (pos.outstandingKobo > 0) throw gate(`The facility still has ${formatKobo(pos.outstandingKobo)} outstanding and cannot be closed.`);
    if (fac.payment_status !== "RECONCILED") throw gate("The disbursement payment is not reconciled.");
    await tx.query("UPDATE facilities SET status = 'CLOSED', closed_by = $2, closed_at = $3, settled_at = coalesce(settled_at, $3) WHERE id = $1", [facilityId, actor.staffId, ctx.now]);
    await tx.query("UPDATE applications SET closed_at = $2, retention_until = $3 WHERE id = $1", [fac.application_id, ctx.now, retentionDate(ctx.now)]);
    await audit(tx, ctx, { action: "FACILITY_CLOSED", actorRole: "COLLECTIONS_OFFICER", applicationId: fac.application_id, details: { facilityId, paidKobo: pos.paidKobo } });
  });
}

export async function caseFacility(q: Db, appId: string) {
  return (await q.query<FacilityRow>("SELECT * FROM facilities WHERE application_id = $1", [appId])).rows[0] ?? null;
}

export { retailDataSchema, persistApp };
