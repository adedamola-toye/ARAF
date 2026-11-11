/**
 * Service targets per stage and escalation. Targets and recipients are configured by the Super Admin
 * (none are assumed). The worker sends at most one escalation per task (deduplicated in the outbox).
 */
import type { Db } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { systemCtx } from "../context";
import { audit } from "../audit";
import { forbidden, invalid } from "../errors";
import { holdsRole } from "./access";
import { STAGES, STAGE_LABELS, type Stage } from "./stages";
import { enqueueEmail } from "../notify/outbox";
import { caseLink, simpleEmail } from "../notify/templates";
import { PLATFORM_NAME } from "../brand";
import { formatDuration, formatLagos } from "../time";

export async function listServiceTargets(q: Db) {
  return (await q.query<{ stage: string; target_hours: number; escalation_staff_ids: string[]; updated_at: Date }>("SELECT * FROM service_targets ORDER BY stage")).rows;
}

export async function saveServiceTarget(ctx: Ctx, p: { stage: string; targetHours: number | null; recipientIds: string[] }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden();
    if (!(STAGES as readonly string[]).includes(p.stage)) throw invalid("Unknown stage.");
    if (p.targetHours === null) {
      await tx.query("DELETE FROM service_targets WHERE stage = $1", [p.stage]);
    } else {
      if (!Number.isInteger(p.targetHours) || p.targetHours < 1 || p.targetHours > 2160) throw invalid("Target must be 1–2160 hours.", { targetHours: "Invalid." });
      const valid = (await tx.query<{ id: string }>("SELECT id FROM staff WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'", [p.recipientIds])).rows.map((r) => r.id);
      await tx.query(
        `INSERT INTO service_targets (stage, target_hours, escalation_staff_ids, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (stage) DO UPDATE SET target_hours = EXCLUDED.target_hours, escalation_staff_ids = EXCLUDED.escalation_staff_ids, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [p.stage, p.targetHours, valid, actor.staffId, ctx.now],
      );
    }
    await audit(tx, ctx, { action: "SERVICE_TARGET_SAVED", actorRole: "SUPER_ADMIN", details: { stage: p.stage, targetHours: p.targetHours, recipients: p.recipientIds.length } });
  });
}

/** Worker job: escalate open tasks past their stage's service target (once per task). */
export async function runSlaEscalations(now: Date) {
  const rows = (
    await db.query<{ task_id: string; application_id: string; stage: Stage; entered_at: Date; assignee_email: string | null; ref: string; customer_name: string; target_hours: number; recipients: string[] }>(
      `SELECT t.id AS task_id, t.application_id, t.stage, t.entered_at, s.email AS assignee_email, a.ref, a.customer_name, st.target_hours,
              ARRAY(SELECT e.email FROM staff e WHERE e.id = ANY(st.escalation_staff_ids) AND e.status = 'ACTIVE') AS recipients
         FROM tasks t JOIN applications a ON a.id = t.application_id JOIN service_targets st ON st.stage = t.stage LEFT JOIN staff s ON s.id = t.assignee_id
        WHERE t.status = 'OPEN' AND a.suspended_at IS NULL AND t.entered_at + make_interval(hours => st.target_hours) < $1`,
      [now],
    )
  ).rows;
  let sent = 0;
  for (const r of rows) {
    const to = [...new Set([...(r.recipients ?? []), ...(r.assignee_email ? [r.assignee_email] : [])])];
    if (!to.length) continue;
    await withTx(async (tx) => {
      const out = await enqueueEmail(tx, now, {
        kind: "SLA_ESCALATION",
        dedupeKey: `sla:${r.task_id}`,
        applicationId: r.application_id,
        to,
        subject: `${PLATFORM_NAME} ${r.ref}: ${STAGE_LABELS[r.stage]} is past its service target`,
        text: simpleEmail([
          `${r.ref} (${r.customer_name}) has been at ${STAGE_LABELS[r.stage]} since ${formatLagos(r.entered_at)} (${formatDuration(now.getTime() - new Date(r.entered_at).getTime())}).`,
          `Service target: ${r.target_hours} hours. Owner: ${r.assignee_email ?? "unassigned (assignment exception)"}.`,
          "",
          caseLink(r.application_id),
        ]),
      });
      if (out.created) {
        await audit(tx, systemCtx(now), { action: "SLA_ESCALATED", applicationId: r.application_id, stage: r.stage, details: { taskId: r.task_id, targetHours: r.target_hours } });
        sent++;
      }
    });
  }
  return sent;
}
