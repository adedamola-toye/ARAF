import type { Db } from "./db";
import { db as rootDb } from "./db";
import type { Ctx } from "./context";
import { describeDevice } from "./context";
import { sanitizeForAudit } from "./mask";

export type AuditOutcome = "SUCCESS" | "DENIED" | "FAILURE";

export interface AuditEntry {
  action: string;
  outcome?: AuditOutcome;
  actorRole?: string | null;
  applicationId?: string | null;
  customerId?: string | null;
  stage?: string | null;
  reason?: string | null;
  assignmentFrom?: string | null;
  assignmentTo?: string | null;
  documentId?: string | null;
  documentVersion?: number | null;
  /** Staff Personal Financing request this event belongs to. */
  staffRequestId?: string | null;
  details?: Record<string, unknown>;
  /** Override actor (e.g. sign-in before a session exists). */
  actorId?: string | null;
  actorEmail?: string | null;
}

/**
 * Append an audit event. Call with the transaction client so the audit row commits atomically
 * with the change it describes. For denied/failed attempts (where the transaction rolls back)
 * call with the root pool via `auditOutsideTx`.
 */
export async function audit(q: Db, ctx: Ctx, e: AuditEntry): Promise<void> {
  let customerId = e.customerId ?? null;
  if (!customerId && e.applicationId) {
    const r = await q.query<{ customer_id: string | null }>("SELECT customer_id FROM applications WHERE id = $1", [e.applicationId]);
    customerId = r.rows[0]?.customer_id ?? null;
  }
  await q.query(
    `INSERT INTO audit_events (occurred_at, actor_id, actor_email, actor_role, session_id, action, outcome,
       application_id, customer_id, stage, reason, assignment_from, assignment_to, document_id, document_version,
       correlation_id, client_ip, user_agent, device, details, staff_request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [
      ctx.now,
      e.actorId !== undefined ? e.actorId : (ctx.actor?.staffId ?? null),
      e.actorEmail !== undefined ? e.actorEmail : (ctx.actor?.email ?? null),
      e.actorRole ?? ctx.actor?.activeRole ?? null,
      ctx.actor?.sessionId ?? null,
      e.action,
      e.outcome ?? "SUCCESS",
      e.applicationId ?? null,
      customerId,
      e.stage ?? null,
      e.reason ?? null,
      e.assignmentFrom ?? null,
      e.assignmentTo ?? null,
      e.documentId ?? null,
      e.documentVersion ?? null,
      ctx.correlationId,
      ctx.ip,
      ctx.userAgent ? ctx.userAgent.slice(0, 512) : null,
      describeDevice(ctx.userAgent),
      JSON.stringify(sanitizeForAudit(e.details ?? {})),
      e.staffRequestId ?? null,
    ],
  );
}

export async function auditOutsideTx(ctx: Ctx, e: AuditEntry): Promise<void> {
  try {
    await audit(rootDb, ctx, e);
  } catch (err) {
    console.error("[audit] failed to record event", e.action, err);
  }
}
