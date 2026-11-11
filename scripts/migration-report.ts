import { loadEnv } from "./load-env";
loadEnv();
import { db, closePool } from "../src/server/db";

/**
 * Lists records that need a migration decision or manual reconciliation after migration 006.
 * Read-only. Historical WakeelBoost cases are never relabelled as a retail product.
 */
async function main() {
  const q = async (title: string, sql: string) => {
    const rows = (await db.query(sql)).rows;
    console.log(`\n${title}: ${rows.length}`);
    for (const r of rows.slice(0, 50)) console.log("  " + Object.values(r).join(" | "));
  };
  await q("Open WakeelBoost cases (continue on the legacy workflow; decide whether to finish or withdraw)", `SELECT ref, stage, status, customer_name FROM applications WHERE workflow = 'WAKEELBOOST' AND status NOT IN ('CLOSED','REJECTED','WITHDRAWN','EXPIRED') ORDER BY created_at`);
  await q("WakeelBoost cases booked without vendor confirmation (legacy disbursement = attestation; reconcile payment manually)", `SELECT a.ref, d.transaction_ref, d.amount_kobo FROM applications a JOIN disbursements d ON d.application_id = a.id WHERE a.workflow = 'WAKEELBOOST' AND a.vendor_confirmed_at IS NULL`);
  await q("Submitted cases with no request-ledger row (should be none)", `SELECT a.ref FROM applications a LEFT JOIN request_ledger l ON l.application_id = a.id WHERE a.submitted_at IS NOT NULL AND l.application_id IS NULL`);
  await q("Staff holding RM or TEAM_LEAD without a team (retail routing cannot reach them)", `SELECT s.email, ra.role FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.active AND ra.role IN ('RM','TEAM_LEAD') AND ra.team IS NULL`);
  await q("Active outlets without an Outlet Service Supervisor or team", `SELECT state, city, outlet_type, name FROM locations WHERE active AND (oss_staff_id IS NULL OR team IS NULL)`);
  await q("Institutions with unconfirmed regulatory status", `SELECT code, name FROM financial_institutions WHERE active AND regulatory_status <> 'CONFIRMED_ACTIVE'`);
  await q("Retail offer templates not yet approved", `SELECT name, product_code, structure, version FROM offer_templates WHERE product_code IS NOT NULL AND status = 'ACTIVE' AND NOT production_approved`);
}
main().then(() => closePool(), async (e) => { console.error(e); await closePool(); process.exit(1); });
