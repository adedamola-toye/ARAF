import { loadEnv } from "./load-env";
loadEnv();
import { db, closePool } from "../src/server/db";
import { seedReferenceData } from "../src/server/demo/seed";
import { NAIRA } from "../src/server/money";
import { createSubmittedCase, driveToOffer, driveToClosed } from "../src/server/demo/scenario";

/**
 * Demonstrates all three credit routes end to end with SYNTHETIC cases against the configured
 * database, printing every handoff. Uses the real domain functions (same rules as the UI).
 */
async function main() {
  if (process.env.APP_ENV === "production") throw new Error("Refusing to run synthetic demo in production.");
  await seedReferenceData(db);
  const cases: [string, Parameters<typeof createSubmittedCase>[0]][] = [
    ["Route 1 · RM · Individual · ₦5,000,000.00", { initiator: "RM", type: "INDIVIDUAL", amountKobo: NAIRA(5_000_000) }],
    ["Route 2 · Merchant Officer · Enterprise · ₦5,000,000.01", { initiator: "MERCHANT_OFFICER", type: "ENTERPRISE", amountKobo: NAIRA(5_000_000) + 1 }],
    ["Route 3 · ANM North · Limited · ₦50,000,000.00", { initiator: "ANM_NORTH", type: "LIMITED", amountKobo: NAIRA(50_000_000) }],
  ];
  for (const [label, opts] of cases) {
    const id = await createSubmittedCase(opts);
    await driveToOffer(id);
    await driveToClosed(id);
    const app = (await db.query("SELECT ref, route, status, stage FROM applications WHERE id = $1", [id])).rows[0];
    const steps = (await db.query(
      `SELECT t.stage, s.email, t.outcome FROM tasks t LEFT JOIN staff s ON s.id = t.assignee_id WHERE application_id = $1 ORDER BY t.seq`, [id])).rows;
    console.log(`\n${label}\n  ${app.ref}: route ${app.route}, final ${app.status}/${app.stage}`);
    for (const s of steps) console.log(`  ${s.stage.padEnd(24)} ${String(s.email).padEnd(28)} ${s.outcome}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => closePool());
