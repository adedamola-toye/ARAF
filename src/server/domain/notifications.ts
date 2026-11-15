/** In-app notification centre. Idempotent per recipient + dedupe key; only the recipient can read or clear. */
import type { Db } from "../db";

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  application_id: string | null;
  link: string | null;
  created_at: Date;
  read_at: Date | null;
}

export async function notify(q: Db, now: Date, n: { recipientId: string; kind: string; title: string; body: string; applicationId?: string | null; link?: string | null; dedupeKey: string }) {
  await q.query(
    `INSERT INTO notifications (recipient_id, kind, title, body, application_id, link, dedupe_key, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (recipient_id, dedupe_key) DO NOTHING`,
    [n.recipientId, n.kind, n.title, n.body, n.applicationId ?? null, n.link ?? null, n.dedupeKey, now],
  );
}

export async function unreadCount(q: Db, staffId: string): Promise<number> {
  return Number((await q.query("SELECT count(*) AS n FROM notifications WHERE recipient_id = $1 AND read_at IS NULL", [staffId])).rows[0].n);
}

export async function listNotifications(q: Db, staffId: string, limit = 100): Promise<NotificationRow[]> {
  return (await q.query<NotificationRow>("SELECT id, kind, title, body, application_id, link, created_at, read_at FROM notifications WHERE recipient_id = $1 ORDER BY created_at DESC LIMIT $2", [staffId, limit])).rows;
}

export async function markRead(q: Db, staffId: string, now: Date, id: string | "ALL") {
  if (id === "ALL") await q.query("UPDATE notifications SET read_at = $2 WHERE recipient_id = $1 AND read_at IS NULL", [staffId, now]);
  else await q.query("UPDATE notifications SET read_at = coalesce(read_at, $3) WHERE recipient_id = $1 AND id = $2", [staffId, id, now]);
}
