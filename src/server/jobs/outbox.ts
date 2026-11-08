import { db, withTx } from "../db";
import { systemCtx } from "../context";
import { audit } from "../audit";
import { objectStore } from "../storage";
import { mailTransport, type OutgoingAttachment } from "../notify/transport";

interface OutboxRow {
  id: string;
  kind: string;
  application_id: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  body_text: string;
  attachment_document_ids: string[];
  attempts: number;
  max_attempts: number;
}

/** Exponential backoff: 1, 2, 4, 8 ... minutes, capped at 2 hours. */
export function backoffMs(attempts: number) {
  return Math.min(2 ** Math.max(0, attempts - 1), 120) * 60_000;
}

/**
 * Deliver due outbox messages. Rows are claimed with SKIP LOCKED so several workers can run.
 * Delivery status, attempts and errors are tracked per message; failures retry with backoff and
 * become DEAD after max_attempts. Retries never create new messages (and therefore never create
 * duplicate closure events).
 */
export async function processOutbox(now = new Date(), limit = 20): Promise<{ sent: number; failed: number }> {
  // Recover rows stuck in SENDING (crashed worker) after 10 minutes.
  await db.query(
    "UPDATE notification_outbox SET status = 'FAILED', last_error = coalesce(last_error, 'worker interrupted') WHERE status = 'SENDING' AND locked_at < $1",
    [new Date(now.getTime() - 10 * 60_000)],
  );
  const claimed = await withTx(async (tx) => {
    const r = await tx.query<OutboxRow>(
      `UPDATE notification_outbox SET status = 'SENDING', locked_at = $1
        WHERE id IN (SELECT id FROM notification_outbox WHERE status IN ('PENDING','FAILED') AND next_attempt_at <= $1
                      ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [now, limit],
    );
    return r.rows;
  });
  let sent = 0;
  let failed = 0;
  for (const m of claimed) {
    const ctx = systemCtx(now);
    try {
      const attachments: OutgoingAttachment[] = [];
      if (m.attachment_document_ids.length) {
        const docs = (await db.query("SELECT * FROM documents WHERE id = ANY($1::uuid[]) AND scan_status = 'CLEAN'", [m.attachment_document_ids])).rows;
        for (const d of docs) attachments.push({ filename: d.filename, contentType: d.mime_type, content: await objectStore().get(d.storage_key) });
      }
      const res = await mailTransport().send({ to: m.to_addresses, cc: m.cc_addresses, subject: m.subject, text: m.body_text, attachments, outboxId: m.id });
      await withTx(async (tx) => {
        await tx.query(
          "UPDATE notification_outbox SET status = 'SENT', sent_at = $2, attempts = attempts + 1, provider_message_id = $3, last_error = NULL WHERE id = $1",
          [m.id, now, res.messageId],
        );
        await audit(tx, ctx, { action: "EMAIL_SENT", applicationId: m.application_id, details: { outboxId: m.id, kind: m.kind, to: m.to_addresses.length, cc: m.cc_addresses.length, attachments: attachments.length } });
      });
      sent++;
    } catch (err) {
      const attempts = m.attempts + 1;
      const dead = attempts >= m.max_attempts;
      await withTx(async (tx) => {
        await tx.query("UPDATE notification_outbox SET status = $2, attempts = $3, next_attempt_at = $4, last_error = $5 WHERE id = $1", [
          m.id,
          dead ? "DEAD" : "FAILED",
          attempts,
          new Date(now.getTime() + backoffMs(attempts)),
          String((err as Error)?.message ?? err).slice(0, 500),
        ]);
        await audit(tx, ctx, {
          action: dead ? "EMAIL_DEAD" : "EMAIL_FAILED",
          outcome: "FAILURE",
          applicationId: m.application_id,
          details: { outboxId: m.id, kind: m.kind, attempts, error: String((err as Error)?.message ?? err).slice(0, 200) },
        });
      });
      failed++;
    }
  }
  return { sent, failed };
}

/** Admin action: put a DEAD/FAILED message back in the queue (same row - no duplicates). */
export async function retryOutbox(id: string, now = new Date()) {
  await db.query("UPDATE notification_outbox SET status = 'PENDING', next_attempt_at = $2, max_attempts = attempts + 3 WHERE id = $1 AND status IN ('FAILED','DEAD')", [id, now]);
}
