import { loadEnv } from "./load-env";
loadEnv();
import { db, closePool } from "../src/server/db";
import { systemCtx } from "../src/server/context";
import { scanDocument } from "../src/server/domain/documents";

/**
 * One-off retry for documents left in quarantine. Useful when a scanner was briefly
 * unavailable at upload time. Scans every quarantined file, regardless of age.
 * Requires the same storage and a working scanner (do not run with SCANNER_DRIVER=defer).
 */
async function main() {
  const rows = (
    await db.query<{ id: string; filename: string }>(
      "SELECT id, filename FROM documents WHERE scan_status = 'QUARANTINED' AND purged_at IS NULL ORDER BY uploaded_at",
    )
  ).rows;
  if (!rows.length) {
    console.log("[rescan] No quarantined documents.");
    return;
  }
  let clean = 0;
  let rejected = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const status = await scanDocument(systemCtx(new Date()), r.id);
      if (status === "CLEAN") clean++;
      else if (status === "REJECTED") rejected++;
      else failed++;
      console.log(`[rescan] ${r.filename}: ${status}`);
    } catch (e) {
      failed++;
      console.error(`[rescan] ${r.filename}: failed`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`[rescan] done: ${clean} clean, ${rejected} rejected, ${failed} still quarantined/failed.`);
}

main()
  .then(() => closePool())
  .catch(async (e) => {
    console.error(e);
    await closePool();
    process.exit(1);
  });
