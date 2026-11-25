/**
 * Optional Periculum Blacklist Search (POST /statements/blacklistsearch): credit bureau data for a BVN, tied to a
 * statement Periculum has analysed. Off unless PERICULUM_BLACKLIST_ENABLED=true (it sends the BVN to Periculum, so
 * it needs the bank's approval). It supplements the SeedFi credit check and never replaces it or decides anything.
 *
 *  - Scheduled once per analysis, when the analysis settles with at least one analysed statement.
 *  - Subjects: the applicant's BVN; for a limited company with no applicant BVN, each director's BVN.
 *  - The full response is stored encrypted; only non-personal counts and report metadata are kept readable.
 *  - A search whose outcome is unknown (timeout / 5xx) is NOT resent: it may already have been charged.
 */
import { createHash } from "node:crypto";
import { db, withTx, type Db, type Tx } from "../db";
import { config } from "../config";
import { audit } from "../audit";
import { systemCtx } from "../context";
import { decryptField, encryptField, hmac } from "../crypto";
import { blacklistSearch, periculumReadiness, periculumSource, type VendorBlacklist } from "../integrations/periculum/client";

export interface BureauSummary {
  microfinance: { hasFacilities: string | null; delinquent: number | null };
  mortgage: { hasFacilities: string | null; delinquent: number | null };
  credit: { hasFacilities: string | null; delinquent: number | null };
  lastReportedDate: string | null;
  reportDate: string | null;
  productName: string | null;
  providerSource: string | null;
  totalDelinquent: number | null;
}

export interface BureauCheckRow {
  id: string;
  analysis_id: string;
  application_id: string;
  subject: string;
  subject_label: string;
  bvn_last4: string | null;
  status: "PENDING" | "COMPLETED" | "FAILED" | "SKIPPED";
  source: "PERICULUM" | "FIXTURE";
  attempts: number;
  summary: BureauSummary | null;
  error_category: string | null;
  error_message: string | null;
  created_at: Date;
  completed_at: Date | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Non-personal summary of a documented Blacklist Search response (names, date of birth and BVN are left out). */
export function summariseBlacklist(r: Record<string, unknown>): BureauSummary {
  const mf = { hasFacilities: str(r.mfCreditHasCreditFacilities), delinquent: num(r.mfCreditNumberOfDelinqCreditFacilities) };
  // The documented response spells this key both "mgcredit…" and "mgCredit…".
  const mg = { hasFacilities: str(r.mgCreditHasCreditFacilities ?? r.mgcreditHasCreditFacilities), delinquent: num(r.mgCreditNumberOfDelinqCreditFacilities ?? r.mgcreditNumberOfDelinqCreditFacilities) };
  const cr = { hasFacilities: str(r.creditHasCreditFacilities), delinquent: num(r.creditNumberOfDelinqCreditFacilities) };
  const parts = [mf.delinquent, mg.delinquent, cr.delinquent];
  return {
    microfinance: mf,
    mortgage: mg,
    credit: cr,
    lastReportedDate: str(r.creditLastReportedDate),
    reportDate: str(r.reportDate),
    productName: str(r.productName),
    providerSource: str(r.providerSource),
    totalDelinquent: parts.every((p) => p === null) ? null : parts.reduce<number>((t, p) => t + (p ?? 0), 0),
  };
}

/** Called when an analysis settles (inside its transaction). Idempotent per analysis and subject. */
export async function scheduleBureauChecks(tx: Tx, analysisId: string, now: Date) {
  if (!config.periculum.blacklistEnabled) return;
  const a = (await tx.query<{ application_id: string; source: string }>("SELECT application_id, source FROM fi_analyses WHERE id = $1", [analysisId])).rows[0];
  const stmt = (
    await tx.query<{ vendor_statement_key: string }>(
      "SELECT vendor_statement_key FROM fi_statements WHERE analysis_id = $1 AND status IN ('PROCESSED','REUSED') AND vendor_statement_key IS NOT NULL ORDER BY processed_at NULLS LAST LIMIT 1",
      [analysisId],
    )
  ).rows[0];
  if (!stmt) return; // nothing analysed: no statement key to search against
  const v = (
    await tx.query<{ id: string; bvn_enc: string | null; bvn_last4: string | null }>(
      "SELECT v.id, v.bvn_enc, v.bvn_last4 FROM applications ap JOIN application_versions v ON v.id = ap.current_version_id WHERE ap.id = $1",
      [a.application_id],
    )
  ).rows[0];
  const subjects: { subject: string; label: string; bvnEnc: string | null; last4: string | null }[] = [];
  if (v?.bvn_enc) subjects.push({ subject: "APPLICANT", label: "Applicant", bvnEnc: v.bvn_enc, last4: v.bvn_last4 });
  else if (v) {
    const dirs = (
      await tx.query<{ position: number; full_name: string; bvn_enc: string; bvn_last4: string }>("SELECT position, full_name, bvn_enc, bvn_last4 FROM application_directors WHERE version_id = $1 ORDER BY position", [
        v.id,
      ])
    ).rows;
    for (const d of dirs) subjects.push({ subject: `DIRECTOR_${d.position}`, label: `Director ${d.position}: ${d.full_name}`, bvnEnc: d.bvn_enc, last4: d.bvn_last4 });
  }
  const insert = (s: { subject: string; label: string; bvnHash: string | null; last4: string | null }, status: "PENDING" | "SKIPPED", msg: string | null) =>
    tx.query(
      `INSERT INTO fi_bureau_checks (analysis_id, application_id, subject, subject_label, bvn_hash, bvn_last4, vendor_statement_key, status, source, next_attempt_at, error_category, error_message, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (analysis_id, subject) DO NOTHING`,
      [analysisId, a.application_id, s.subject, s.label, s.bvnHash, s.last4, stmt.vendor_statement_key, status, a.source, status === "PENDING" ? now : null, status === "SKIPPED" ? "NO_BVN" : null, msg, now],
    );
  if (!subjects.length) {
    await insert({ subject: "APPLICANT", label: "Applicant", bvnHash: null, last4: null }, "SKIPPED", "No BVN is recorded on the application, so no bureau search was made.");
    return;
  }
  for (const s of subjects) await insert({ subject: s.subject, label: s.label, bvnHash: s.bvnEnc ? hmac(`bvn:${decryptField(s.bvnEnc)}`) : null, last4: s.last4 }, "PENDING", null);
}

async function finish(row: { id: string; application_id: string; subject: string }, now: Date, set: Record<string, unknown>, event: string, details: Record<string, unknown>) {
  await withTx(async (tx) => {
    const cols = Object.keys(set);
    await tx.query(`UPDATE fi_bureau_checks SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`, [row.id, ...cols.map((c) => set[c])]);
    await audit(tx, systemCtx(now), { action: event, actorRole: "SYSTEM", applicationId: row.application_id, details: { checkId: row.id, subject: row.subject, ...details } });
  });
}

/** Worker step: run due searches. */
export async function processBureauChecks(now = new Date()) {
  if (!config.periculum.blacklistEnabled || !periculumReadiness().ready) return 0;
  const rows = await withTx(async (tx) => {
    const r = (
      await tx.query<{ id: string; analysis_id: string; application_id: string; subject: string; vendor_statement_key: string; attempts: number }>(
        "SELECT id, analysis_id, application_id, subject, vendor_statement_key, attempts FROM fi_bureau_checks WHERE status = 'PENDING' AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT 10 FOR UPDATE SKIP LOCKED",
        [now],
      )
    ).rows;
    if (r.length) await tx.query("UPDATE fi_bureau_checks SET next_attempt_at = $2, attempts = attempts + 1 WHERE id = ANY($1::uuid[])", [r.map((x) => x.id), new Date(now.getTime() + 10 * 60_000)]);
    return r;
  });
  for (const c of rows) {
    const bvn = await bvnFor(db, c.application_id, c.subject);
    if (!bvn) {
      await finish(c, now, { status: "SKIPPED", error_category: "NO_BVN", error_message: "The BVN is no longer on the application.", completed_at: now, next_attempt_at: null }, "PERICULUM_BUREAU_CHECK_SKIPPED", {});
      continue;
    }
    const r = await blacklistSearch({ analysisId: c.analysis_id }, { statementKey: Number(c.vendor_statement_key), bvn });
    if (r.ok) {
      const data = r.data as VendorBlacklist & Record<string, unknown>;
      const summary = summariseBlacklist(data);
      const text = JSON.stringify(data);
      await finish(
        c,
        now,
        { status: "COMPLETED", summary: JSON.stringify(summary), payload_enc: encryptField(text), completed_at: now, next_attempt_at: null, error_category: null, error_message: null, source: periculumSource() },
        "PERICULUM_BUREAU_CHECK_COMPLETED",
        { totalDelinquent: summary.totalDelinquent, payloadSha256: createHash("sha256").update(text).digest("hex") },
      );
    } else if (r.outcome === "RATE_LIMITED" && c.attempts + 1 < config.periculum.maxAttempts) {
      await db.query("UPDATE fi_bureau_checks SET next_attempt_at = $2, error_category = $3, error_message = $4 WHERE id = $1", [c.id, new Date(now.getTime() + 60_000 * 2 ** c.attempts), r.category, r.message]);
    } else {
      const msg = r.outcome === "AMBIGUOUS" ? "Periculum's reply to the search was not received. It was not repeated automatically because it may already have been charged." : r.message;
      await finish(
        c,
        now,
        { status: "FAILED", error_category: r.outcome === "AMBIGUOUS" ? "OUTCOME_UNKNOWN" : r.category, error_message: msg, completed_at: now, next_attempt_at: null },
        "PERICULUM_BUREAU_CHECK_FAILED",
        { category: r.category },
      );
    }
  }
  return rows.length;
}

async function bvnFor(q: Db, appId: string, subject: string): Promise<string | null> {
  const v = (await q.query<{ id: string; bvn_enc: string | null }>("SELECT v.id, v.bvn_enc FROM applications ap JOIN application_versions v ON v.id = ap.current_version_id WHERE ap.id = $1", [appId])).rows[0];
  if (!v) return null;
  if (subject === "APPLICANT") return v.bvn_enc ? decryptField(v.bvn_enc) : null;
  const pos = Number(subject.replace("DIRECTOR_", ""));
  const d = (await q.query<{ bvn_enc: string }>("SELECT bvn_enc FROM application_directors WHERE version_id = $1 AND position = $2", [v.id, pos])).rows[0];
  return d ? decryptField(d.bvn_enc) : null;
}

/** Bureau checks for the analysis currently in force (readable summary only). */
export async function bureauChecksFor(q: Db, analysisId: string): Promise<BureauCheckRow[]> {
  return (
    await q.query<BureauCheckRow>(
      "SELECT id, analysis_id, application_id, subject, subject_label, bvn_last4, status, source, attempts, summary, error_category, error_message, created_at, completed_at FROM fi_bureau_checks WHERE analysis_id = $1 ORDER BY subject",
      [analysisId],
    )
  ).rows;
}
