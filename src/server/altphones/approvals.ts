/**
 * Altphones approval routes and final disbursement.
 *
 *   Delight Officer:  Product Manager → Unit Head → back to the originating officer
 *   Smile Associate:  Business Performance Manager → Product Manager → Unit Head → back to the originator
 *
 * Every stage can approve, return for correction or reject, with comments; no stage can be skipped
 * (each decision is only possible in its own status) and one person never acts at two stages.
 */
import { withTx } from "../db";
import type { Ctx } from "../context";
import { DomainError, conflict, forbidden, gate, invalid } from "../errors";
import { formatNaira, imeiChecksumOk, type AltStatus } from "@/lib/altphones";
import { lagosDate } from "../time";
import {
  alertOperations,
  auditDenied,
  BPM_ROLE,
  checkLock,
  emailCustomer,
  expectStatus,
  lockApp,
  notifyRole,
  notifyStaffIds,
  PM_ROLE,
  requireOriginator,
  requireReviewer,
  routeUnitHead,
  settingsById,
  transition,
} from "./core";
import { buildSchedule, writeSchedule } from "./origination";
import { issueUnit, releaseUnit } from "./stock";

export type Decision = "APPROVE" | "RETURN" | "REJECT";

const STAGE_OF: Partial<Record<AltStatus, { stage: "BPM" | "PM" | "UNIT_HEAD"; role: string; label: string }>> = {
  UNDER_BPM_REVIEW: { stage: "BPM", role: BPM_ROLE, label: "Business Performance Manager" },
  UNDER_PM_REVIEW: { stage: "PM", role: PM_ROLE, label: "Product Manager" },
  UNDER_UNIT_HEAD_REVIEW: { stage: "UNIT_HEAD", role: "UNIT_HEAD", label: "Unit Head" },
};

export async function decide(ctx: Ctx, id: string, p: { action: Decision; comments: string; reviewed: boolean; lockVersion?: number | null }) {
  const comments = (p.comments ?? "").trim();
  try {
    return await withTx(async (tx) => {
      let app = await lockApp(tx, id);
      const st = STAGE_OF[app.status];
      if (!st) throw conflict("This application is not waiting for a review decision.");
      checkLock(app, p.lockVersion);
      await requireReviewer(tx, ctx, app, st.role);
      if (st.stage === "UNIT_HEAD") {
        const uh = await routeUnitHead(tx, app);
        if (uh.id !== ctx.actor!.staffId) throw forbidden("Only the Unit Head configured for the Altphones route can decide this application.");
        if (uh.problem) throw gate(uh.problem);
      }
      if (!["APPROVE", "RETURN", "REJECT"].includes(p.action)) throw invalid("Choose a decision.");
      if (p.action !== "APPROVE" && comments.length < 3) throw invalid("Explain the decision for the officer.", { comments: "Comments are required to return or reject." });
      if (p.action === "APPROVE" && !p.reviewed) throw invalid("Confirm you have reviewed the application.", { reviewed: "Confirm your review." });
      const actorCol = st.stage === "BPM" ? "bpm_reviewer_id" : st.stage === "PM" ? "pm_reviewer_id" : "unit_head_id";
      await tx.query("INSERT INTO altphones_reviews (application_id, stage, action, comments, actor_id, submission_no, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
        app.id,
        st.stage,
        p.action,
        comments || null,
        ctx.actor!.staffId,
        app.submission_count,
        ctx.now,
      ]);
      const set: Record<string, unknown> = { [actorCol]: ctx.actor!.staffId };
      if (p.action === "APPROVE") {
        let to: AltStatus;
        if (st.stage === "BPM") to = "UNDER_PM_REVIEW";
        else if (st.stage === "PM") {
          const uh = await routeUnitHead(tx, { ...app, pm_reviewer_id: ctx.actor!.staffId });
          if (uh.problem) {
            await alertOperations(tx, ctx, app, "NO_ROUTE_UNIT_HEAD", "Altphones route has no usable Unit Head", [uh.problem]);
            throw gate(`Approval is blocked: ${uh.problem}`);
          }
          to = "UNDER_UNIT_HEAD_REVIEW";
        } else to = "APPROVED";
        if (to === "APPROVED") set.approved_at = ctx.now;
        app = await transition(tx, ctx, app, { action: `${st.stage}_APPROVED`, to, role: st.role, comments: comments || null, set });
        if (to === "UNDER_PM_REVIEW") await notifyRole(tx, ctx, app, "PM_QUEUE", [PM_ROLE], "Altphones application awaiting product review", [`${app.ref} passed Business Performance Manager review.`], [app.originator_id, app.bpm_reviewer_id]);
        else if (to === "UNDER_UNIT_HEAD_REVIEW") {
          const uh = await routeUnitHead(tx, app);
          await notifyStaffIds(tx, ctx, app, "UH_QUEUE", [uh.id], "Altphones application awaiting final approval", [`${app.ref} passed Product Manager review and needs your final approval.`]);
        } else await notifyStaffIds(tx, ctx, app, "APPROVED", [app.originator_id], "Approved — Ready for Disbursement", [`${app.ref} has final approval. Open it to hand over the phone and confirm disbursement.`]);
      } else if (p.action === "RETURN") {
        app = await transition(tx, ctx, app, { action: `${st.stage}_RETURNED`, to: "RETURNED_FOR_CORRECTION", role: st.role, comments, set });
        await notifyStaffIds(tx, ctx, app, "RETURNED", [app.originator_id], "Altphones application returned for correction", [`The ${st.label} returned ${app.ref}: ${comments}`]);
      } else {
        await releaseUnit(tx, ctx, app, `Rejected by ${st.label}`);
        app = await transition(tx, ctx, app, {
          action: `${st.stage}_REJECTED`,
          to: "REJECTED",
          role: st.role,
          comments,
          set: { ...set, reservation_status: app.reservation_status === "RESERVED" ? "RELEASED" : app.reservation_status, device_id: null, closed_reason: comments, refund_status: "REQUIRED" },
        });
        await notifyStaffIds(tx, ctx, app, "REJECTED", [app.originator_id], "Altphones application rejected", [`The ${st.label} rejected ${app.ref}: ${comments}`, "The reserved phone has been released. The down payment must be refunded under the approved refund process."]);
        await alertOperations(tx, ctx, app, "REFUND_REQUIRED", "Refund required", [`${app.ref} was rejected after the down payment. Process the refund and record it in the platform.`]);
      }
      return { lockVersion: app.lock_version, status: app.status };
    });
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") await auditDenied(ctx, id, "DECISION", e.message);
    throw e;
  }
}

/** Final step by the originating officer: hand over the reserved phone. Idempotent and stock-safe. */
export async function confirmDisbursement(ctx: Ctx, id: string, p: { imei: string; modelConfirmed: boolean; locationConfirmed: boolean; handedOver: boolean; lockVersion?: number | null }) {
  const e: Record<string, string> = {};
  if (!p.modelConfirmed) e.modelConfirmed = "Confirm the phone model.";
  if (!p.locationConfirmed) e.locationConfirmed = "Confirm the supplying location.";
  if (!p.handedOver) e.handedOver = "Confirm the physical handover to the customer.";
  if (Object.keys(e).length) throw invalid("Confirm each item before disbursing.", e);
  try {
    return await withTx(async (tx) => {
      let app = await lockApp(tx, id);
      await requireOriginator(tx, ctx, app);
      if (app.status === "DISBURSED") return { lockVersion: app.lock_version, already: true };
      expectStatus(app, ["APPROVED"], "Disbursement");
      checkLock(app, p.lockVersion);
      if (app.reservation_status !== "RESERVED") throw gate("No phone is reserved for this application.");
      const imei = (p.imei ?? "").replace(/\s/g, "");
      if (/^\d{15}$/.test(imei) && !imeiChecksumOk(imei)) throw invalid("Check the IMEI.", { imei: "This IMEI fails its check digit. Re-read it from the box or dial *#06#." });
      const issued = await issueUnit(tx, ctx, app, imei, "DISBURSEMENT");
      const sched = await buildSchedule(tx, app, lagosDate(ctx.now));
      await writeSchedule(tx, app, sched, "FINAL", ctx.now);
      app = await transition(tx, ctx, app, {
        action: "DISBURSED",
        to: "DISBURSED",
        role: app.originator_role,
        set: { imei: issued.imei, device_id: issued.deviceId, handed_over_at: ctx.now, completed_by: ctx.actor!.staffId, completed_at: ctx.now, reservation_status: "CONSUMED" },
        details: { imei: issued.imei, firstRepayment: sched[0]?.dueDate, finalRepayment: sched[sched.length - 1]?.dueDate },
      });
      const s = await settingsById(tx, app.settings_id);
      await emailCustomer(tx, ctx, app, "DISBURSED", "Your Altphones phone has been handed over", [
        `Your ${app.model_name} (IMEI ${issued.imei}) was handed over on ${lagosDate(ctx.now)}.`,
        `Facility: ${formatNaira(app.financed_kobo)} financed over ${app.tenure_months} months; total repayment ${formatNaira(app.total_repayment_kobo)}.`,
        `Repayments: ${sched.map((r) => `${r.dueDate} ${formatNaira(r.amountKobo)}`).join("; ")}.`,
        `Reference: ${app.ref}`,
      ], s.team_email);
      await notifyRole(tx, ctx, app, "DISBURSED", [PM_ROLE], "Altphones facility disbursed", [`${app.ref} was disbursed and the phone handed over.`]);
      return { lockVersion: app.lock_version, already: false };
    });
  } catch (err) {
    if (err instanceof DomainError && err.code === "FORBIDDEN") await auditDenied(ctx, id, "DISBURSE", err.message);
    throw err;
  }
}
