import type { Db } from "../db";

export interface EmailMessage {
  kind: string;
  dedupeKey: string;
  applicationId?: string | null;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  attachmentDocumentIds?: string[];
}

/**
 * Enqueue an email in the transactional outbox. Idempotent on dedupeKey: a repeat with the same
 * key returns the existing row id and never creates a second message.
 */
export async function enqueueEmail(q: Db, now: Date, m: EmailMessage): Promise<{ id: string; created: boolean }> {
  const to = [...new Set(m.to.map((x) => x.toLowerCase()))].filter(Boolean);
  const cc = [...new Set((m.cc ?? []).map((x) => x.toLowerCase()))].filter((x) => x && !to.includes(x));
  const ins = await q.query<{ id: string }>(
    `INSERT INTO notification_outbox (kind, dedupe_key, application_id, to_addresses, cc_addresses, subject, body_text,
        attachment_document_ids, next_attempt_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [m.kind, m.dedupeKey, m.applicationId ?? null, to, cc, m.subject, m.text, m.attachmentDocumentIds ?? [], now],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, created: true };
  const ex = await q.query<{ id: string }>("SELECT id FROM notification_outbox WHERE dedupe_key = $1", [m.dedupeKey]);
  return { id: ex.rows[0].id, created: false };
}
