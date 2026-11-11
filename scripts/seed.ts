import { loadEnv } from "./load-env";
loadEnv();
import { db, closePool } from "../src/server/db";
import { seedReferenceData, DEMO_STAFF, REAL_STAFF } from "../src/server/demo/seed";
import { NAIRA } from "../src/server/money";
import { createSubmittedCase, act, approveFirstReview, driveToOffer, driveToClosed, prepareFirstReview, recordAcceptanceAssessment } from "../src/server/demo/scenario";
import { applyConfig, syntheticConfig, createRetailCase, driveBusinessReview, driveCredit, approveRetailTemplates, driveToBooking, payAndReconcile, completeAll } from "../src/server/demo/retail-scenario";

/**
 * Seeds SYNTHETIC staff, directory entries, recipient groups, the development offer template and
 * a handful of demo cases spread across the workflow so every queue has something in it.
 */
async function main() {
  if (process.env.APP_ENV === "production") throw new Error("Refusing to seed synthetic data in production.");
  const includeDemo = process.argv.includes("--with-demo");
  await seedReferenceData(db, { includeDemo });
  const existing = await db.query("SELECT count(*)::int AS n FROM applications");
  if (includeDemo && process.argv.includes("--with-retail-demo")) {
    console.log("Applying SYNTHETIC retail configuration (demo only) and creating retail demo cases…");
    for (const p of ["VENDOR_FINANCING", "ALT_DRIVE"]) await applyConfig(p, syntheticConfig(p), "SYNTHETIC DEMO CONFIGURATION - not bank policy");
    await approveRetailTemplates();
    const N = (n: number) => n * 100;
    await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(8_000_000), incomeBasisKobo: N(10_000_000) });
    await createRetailCase({ channel: "DO", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(3_500_000), incomeBasisKobo: N(6_000_000) });
    const c = await createRetailCase({ channel: "RM", product: "ALT_DRIVE", profile: "SALARY_EARNER", structure: "IJARAH", amountKobo: N(6_000_000), tenorMonths: 36, incomeBasisKobo: N(1_500_000) });
    await driveBusinessReview(c);
    const d = await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(4_000_000), incomeBasisKobo: N(10_000_000) });
    await driveBusinessReview(d);
    await driveCredit(d);
    await driveToBooking(d);
    await payAndReconcile(d);
    await completeAll(d);
    await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(2_000_000), incomeBasisKobo: N(10_000_000), submit: false });
  }
  if (includeDemo && existing.rows[0].n === 0 && !process.argv.includes("--no-cases")) {
    console.log("Creating synthetic demo cases…");
    // At business endorsement (RM -> selected RBE)
    await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(2_500_000) });
    // At first credit review, Route 2 (MO -> MO Lead endorsed), reports + APR prepared
    const b = await createSubmittedCase({ initiator: "MERCHANT_OFFICER", type: "ENTERPRISE", amountKobo: NAIRA(12_000_000) });
    await act(b, "ENDORSE");
    await prepareFirstReview(b);
    // At second credit review, Route 3 (ANM North -> North ANM Lead)
    const c = await createSubmittedCase({ initiator: "ANM_NORTH", type: "LIMITED", amountKobo: NAIRA(35_000_000) });
    await act(c, "ENDORSE");
    await approveFirstReview(c);
    // At offer preparation (Route 1, ANM South)
    const d = await createSubmittedCase({ initiator: "ANM_SOUTH", amountKobo: NAIRA(4_000_000) });
    await driveToOffer(d);
    // Bank acceptance case: ₦50m, 6 months, verified monthly turnover ₦77.5m → DSR 12.37%, exceeds by ₦1,833,333.33
    const acc = await createSubmittedCase({ initiator: "RM", type: "ENTERPRISE", amountKobo: NAIRA(50_000_000) });
    await act(acc, "ENDORSE");
    await recordAcceptanceAssessment(acc);
    // Fully closed and booked (Route 1, RM)
    const e = await createSubmittedCase({ initiator: "RM", type: "ENTERPRISE", amountKobo: NAIRA(5_000_000) });
    await driveToOffer(e);
    await driveToClosed(e);
  }
  console.log(includeDemo ? "Seed complete. Accounts:" : "Seed complete. Real accounts (pass --with-demo for synthetic demo staff):");
  for (const s of includeDemo ? [...REAL_STAFF, ...DEMO_STAFF] : REAL_STAFF) console.log(`  ${s.email.padEnd(30)} ${s.roles.map((r) => r.role).join(", ")}`);
  console.log("Sign in with any seeded email; the one-time code is emailed to that address.");
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
