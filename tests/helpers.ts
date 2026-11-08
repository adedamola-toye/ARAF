import { randomUUID } from "node:crypto";
import { db } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedReferenceData } from "../src/server/demo/seed";

/** Fresh schema + synthetic reference data for each test file. */
export async function resetDb() {
  await migrate(process.env.DATABASE_URL!, { reset: true });
  return seedReferenceData(db);
}
export const key = () => randomUUID();
export async function staffId(email: string): Promise<string> {
  return (await db.query("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id;
}
export async function outbox(kind?: string) {
  return (await db.query(`SELECT * FROM notification_outbox ${kind ? "WHERE kind = $1" : ""} ORDER BY created_at`, kind ? [kind] : [])).rows;
}
export async function audits(action: string) {
  return (await db.query("SELECT * FROM audit_events WHERE action = $1 ORDER BY id", [action])).rows;
}
