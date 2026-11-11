import { loadEnv } from "./load-env";
loadEnv();
import { db, closePool } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedReferenceData } from "../src/server/demo/seed";
import { applyConfig, syntheticConfig, createRetailCase, driveBusinessReview, driveCredit, approveRetailTemplates, driveToBooking, payAndReconcile, completeAll } from "../src/server/demo/retail-scenario";

/** Drives synthetic retail cases through the full lifecycle on a fresh development database and prints each handoff. */
async function main() {
  if (process.env.APP_ENV === "production") throw new Error("Refusing to run in production.");
  await migrate(process.env.DATABASE_URL!, { reset: true });
  await seedReferenceData(db);
  for (const p of ["VENDOR_FINANCING", "ALT_DRIVE"]) await applyConfig(p, syntheticConfig(p), "SYNTHETIC DEMO CONFIGURATION");
  await approveRetailTemplates();
  const N = (n: number) => n * 100;
  const journeys = [
    { title: "Vendor Financing via Relationship Manager", o: { channel: "RM" as const, product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER" as const, amountKobo: N(8_000_000), incomeBasisKobo: N(10_000_000) } },
    { title: "Vendor Financing via Delight Officer (outlet + assigned RM)", o: { channel: "DO" as const, product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER" as const, amountKobo: N(30_000_000), incomeBasisKobo: N(40_000_000), withAfs: true } },
    { title: "Alt Drive salary earner (Murabaha)", o: { channel: "RM" as const, product: "ALT_DRIVE", profile: "SALARY_EARNER" as const, structure: "MURABAHA", amountKobo: N(6_000_000), tenorMonths: 36, incomeBasisKobo: N(2_000_000) } },
  ];
  for (const j of journeys) {
    const id = await createRetailCase(j.o);
    await driveBusinessReview(id);
    await driveCredit(id);
    await driveToBooking(id);
    await payAndReconcile(id);
    await completeAll(id);
    const a = (await db.query("SELECT ref, stage, status FROM applications WHERE id = $1", [id])).rows[0];
    const f = (await db.query("SELECT status, payment_status, fulfilment_status FROM facilities WHERE application_id = $1", [id])).rows[0];
    console.log(`\n${j.title}: ${a.ref} → ${a.stage} (${a.status}); facility ${f.status}, payment ${f.payment_status}, fulfilment ${f.fulfilment_status}`);
    const steps = (await db.query("SELECT t.stage, s.email, t.outcome FROM tasks t LEFT JOIN staff s ON s.id = t.assignee_id WHERE application_id = $1 ORDER BY seq", [id])).rows;
    for (const s of steps) console.log(`  ${s.stage.padEnd(26)} ${String(s.email ?? "UNASSIGNED").padEnd(28)} ${s.outcome ?? "open"}`);
  }
}
main().then(() => closePool(), async (e) => { console.error(e); await closePool(); process.exit(1); });
