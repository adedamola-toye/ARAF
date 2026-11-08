import type { Db } from "../db";

/** Read-only access to the working (unsubmitted) version and its directors. */
export async function workingVersionRead(q: Db, appId: string) {
  const v = (await q.query("SELECT * FROM application_versions WHERE application_id = $1 AND submitted_at IS NULL", [appId])).rows[0] ?? null;
  if (!v) return null;
  const directors = (await q.query("SELECT id, position, full_name, bvn_last4 FROM application_directors WHERE version_id = $1 ORDER BY position", [v.id])).rows;
  return { ...v, directors };
}
