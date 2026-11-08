import type { Db } from "../db";

/**
 * Sliding-window rate limiter backed by PostgreSQL (shared across app instances).
 * Returns true when the action is allowed (and records it).
 */
export async function rateLimit(q: Db, bucket: string, limit: number, windowSeconds: number, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - windowSeconds * 1000);
  const r = await q.query<{ n: string }>("SELECT count(*) AS n FROM rate_limit_events WHERE bucket = $1 AND created_at > $2", [bucket, since]);
  if (Number(r.rows[0].n) >= limit) return false;
  await q.query("INSERT INTO rate_limit_events (bucket, created_at) VALUES ($1, $2)", [bucket, now]);
  return true;
}
