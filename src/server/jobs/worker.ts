import { db } from "../db";
import { systemCtx } from "../context";
import { auditOutsideTx } from "../audit";
import { config } from "../config";
import { objectStore } from "../storage";
import { scanDocument } from "../domain/documents";
import { processOutbox } from "./outbox";
import { runMonthlyReport, runWeeklyDigest } from "./schedules";

/** Retry scans for files left in quarantine (e.g. scanner unavailable at upload time). */
export async function rescanQuarantined(now = new Date()) {
  const rows = (await db.query<{ id: string }>("SELECT id FROM documents WHERE scan_status = 'QUARANTINED' AND uploaded_at < $1 LIMIT 20", [new Date(now.getTime() - 60_000)])).rows;
  for (const r of rows) await scanDocument(systemCtx(now), r.id).catch((e) => console.error("[worker] scan failed", r.id, e));
}

/** Retention: purge blobs of documents on closed/rejected cases past retention_until (opt-in). */
export async function retentionSweep(now = new Date()) {
  if (!config.retentionPurgeEnabled) return 0;
  const rows = (
    await db.query<{ id: string; storage_key: string; application_id: string; version_no: number }>(
      `SELECT d.id, d.storage_key, d.application_id, d.version_no FROM documents d JOIN applications a ON a.id = d.application_id
        WHERE d.purged_at IS NULL AND a.retention_until IS NOT NULL AND a.retention_until < $1 LIMIT 100`,
      [now],
    )
  ).rows;
  for (const d of rows) {
    await objectStore().delete(d.storage_key);
    await db.query("UPDATE documents SET purged_at = $2 WHERE id = $1", [d.id, now]);
    await auditOutsideTx(systemCtx(now), { action: "DOCUMENT_PURGED", applicationId: d.application_id, documentId: d.id, documentVersion: d.version_no });
  }
  return rows.length;
}

export async function workerTick(now = new Date()) {
  const results: Record<string, unknown> = {};
  results.outbox = await processOutbox(now);
  results.weekly = await runWeeklyDigest(now);
  results.monthly = await runMonthlyReport(now);
  await rescanQuarantined(now);
  results.retention = await retentionSweep(now);
  return results;
}
