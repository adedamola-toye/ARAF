/**
 * Facility archive and records review. When a financing request is completed ARAF assembles every current
 * document (and the transaction summary) into CUSTOMER_FACILITY.zip, keeps it, and sends it to Legal and
 * Shariah Compliance for records review. Each group marks it Received, then Reviewed (with comments).
 */
import JSZip from "jszip";
import { db, withTx, type Db } from "../db";
import { systemCtx, type Ctx } from "../context";
import { audit } from "../audit";
import { sha256Hex } from "../crypto";
import { objectStore } from "../storage";
import { formatKobo } from "../money";
import { formatLagos } from "../time";
import { enqueueEmail } from "../notify/outbox";
import { caseLink } from "../notify/templates";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { holdsRole } from "./access";
import { CATEGORY_LABEL, sanitizeFilename } from "./documents";
import { escapeHtml } from "./offer";
import { notify } from "./notifications";

export const RECORDS_LABELS: Record<string, string> = {
  PREPARING_ARCHIVE: "Preparing archive",
  SENT_TO_LEGAL_SHARIAH: "Sent to Legal and Shariah",
  REVIEW_COMPLETED: "Records review completed",
  FAILED: "Archive failed — retrying",
};
const GROUP_ROLE = { LEGAL: "LEGAL_REVIEWER", SHARIAH: "SHARIAH_REVIEWER" } as const;
type Group = keyof typeof GROUP_ROLE;

/** "ADAEZE_OKAFOR_ARAF-2026-001064.zip" — customer and facility reference, filesystem-safe. */
export function archiveFilename(customer: string | null, ref: string) {
  const c = (customer ?? "CUSTOMER").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "CUSTOMER";
  return `${c}_${ref.replace(/[^A-Za-z0-9-]/g, "")}.zip`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildFacilityArchive(q: Db, app: Record<string, any>) {
  const zip = new JSZip();
  const root = archiveFilename(app.customer_name, app.ref).replace(/\.zip$/, "");
  const manifest: { path: string; sha256: string; bytes: number; documentId?: string; category?: string; version?: number }[] = [];
  const used = new Set<string>();
  const when = new Date(app.completed_at ?? Date.now());
  const add = (path: string, buf: Buffer, extra: Partial<(typeof manifest)[number]> = {}) => {
    let p = path;
    for (let i = 2; used.has(p); i++) p = path.replace(/(\.[^./]+)?$/, `-${i}$1`);
    used.add(p);
    zip.file(`${root}/${p}`, buf, { date: when });
    manifest.push({ path: p, sha256: sha256Hex(buf), bytes: buf.length, ...extra });
  };
  const docs = (
    await q.query<{ id: string; category: string; filename: string; version_no: number; storage_key: string }>(
      `SELECT id, category, filename, version_no, storage_key FROM documents WHERE application_id = $1 AND superseded_at IS NULL AND scan_status = 'CLEAN' AND purged_at IS NULL ORDER BY category, uploaded_at`,
      [app.id],
    )
  ).rows;
  const disb = (await q.query("SELECT amount_kobo, disbursed_on, transaction_ref FROM disbursements WHERE application_id = $1", [app.id])).rows[0];
  const ic = (await q.query("SELECT status, completed_at FROM invoice_confirmations WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1", [app.id])).rows[0];
  const ce = (await q.query("SELECT status FROM credit_exceptions WHERE application_id = $1 ORDER BY raised_at DESC LIMIT 1", [app.id])).rows[0];
  const rows: [string, string][] = [
    ["Facility reference", app.ref],
    ["Customer", app.customer_name ?? ""],
    ["Product", app.product_label ?? (app.workflow === "RETAIL" ? app.product_code : "WakeelBoost")],
    ["Structure", app.financing_structure ?? ""],
    ["Amount", formatKobo(app.requested_amount_kobo)],
    ["Disbursed", disb ? `${formatKobo(disb.amount_kobo)} · ${String(disb.disbursed_on).slice(0, 10)} · ${disb.transaction_ref}` : "—"],
    ["Invoice confirmation", ic ? `${ic.status}${ic.completed_at ? ` · ${formatLagos(ic.completed_at)}` : ""}` : "Not applicable"],
    ["Credit score exception", ce ? ce.status : "None"],
    ["Completed", formatLagos(app.completed_at ?? app.updated_at)],
    ["Documents", String(docs.length)],
  ];
  const summary = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(app.ref)}</title><style>body{font-family:Arial,sans-serif;max-width:800px;margin:24px auto}td{padding:4px 12px 4px 0;vertical-align:top}th{text-align:left}</style></head><body><h1>Facility summary ${escapeHtml(app.ref)}</h1><table>${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join("")}</table><h2>Documents</h2><ol>${docs.map((d) => `<li>${escapeHtml(CATEGORY_LABEL[d.category] ?? d.category)} — ${escapeHtml(d.filename)} (v${d.version_no})</li>`).join("")}</ol></body></html>`;
  add("00-facility-summary.html", Buffer.from(summary, "utf8"));
  let i = 1;
  for (const d of docs) {
    const folder = (CATEGORY_LABEL[d.category] ?? d.category).replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 50);
    add(`${String(i++).padStart(2, "0")}-${folder}/${sanitizeFilename(d.filename).replace(/\s+/g, "_")}`, await objectStore().get(d.storage_key), { documentId: d.id, category: d.category, version: d.version_no });
  }
  zip.file(`${root}/manifest.json`, JSON.stringify({ reference: app.ref, generatedAt: new Date().toISOString(), files: manifest }, null, 2), { date: when });
  const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { data, manifest, filename: archiveFilename(app.customer_name, app.ref) };
}

/** Worker: archive completed requests not yet sent for records review (retries failures). */
export async function runFacilityArchives(now = new Date()): Promise<number> {
  // Only facilities completed after this feature was released (earlier ones already went through the closure pack).
  const apps = (
    await db.query<{ id: string }>(
      `SELECT id FROM applications WHERE stage = 'COMPLETED' AND (records_status IS NULL OR records_status = 'FAILED')
          AND completed_at >= COALESCE((SELECT applied_at FROM schema_migrations WHERE name = '045_platform_completion.sql'), now())
        ORDER BY completed_at LIMIT 10`,
    )
  ).rows;
  let n = 0;
  for (const a of apps) {
    try {
      if (await archiveOne(a.id, now)) n++;
    } catch (e) {
      console.error("[facility-archive]", a.id, e);
      await db.query("UPDATE applications SET records_status = 'FAILED' WHERE id = $1 AND stage = 'COMPLETED'", [a.id]);
    }
  }
  return n;
}

export async function archiveOne(appId: string, now = new Date()): Promise<boolean> {
  const claim = await db.query("UPDATE applications SET records_status = 'PREPARING_ARCHIVE' WHERE id = $1 AND stage = 'COMPLETED' AND (records_status IS NULL OR records_status = 'FAILED') RETURNING *", [appId]);
  const app = claim.rows[0];
  if (!app) return false;
  const built = await buildFacilityArchive(db, app);
  const key = `archives/${appId}/${crypto.randomUUID()}.zip`;
  await objectStore().put(key, built.data, "application/zip");
  const ctx = systemCtx(now);
  await withTx(async (tx) => {
    const ins = await tx.query<{ id: string }>(
      "INSERT INTO application_archives (application_id, filename, storage_key, sha256, size_bytes, manifest, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [appId, built.filename, key, sha256Hex(built.data), built.data.length, JSON.stringify(built.manifest), now],
    );
    for (const g of ["LEGAL", "SHARIAH"] as const) {
      await tx.query("INSERT INTO application_handovers (application_id, group_code, status, sent_at) VALUES ($1,$2,'SENT',$3) ON CONFLICT (application_id, group_code) DO NOTHING", [appId, g, now]);
    }
    await tx.query("UPDATE applications SET records_status = 'SENT_TO_LEGAL_SHARIAH' WHERE id = $1", [appId]);
    const members = (await tx.query<{ group_code: string; email: string }>("SELECT group_code, email FROM recipient_group_members WHERE group_code IN ('LEGAL','SHARIAH')")).rows;
    if (members.length) {
      await enqueueEmail(tx, now, {
        kind: "FACILITY_ARCHIVE",
        dedupeKey: `facility-archive:${appId}`,
        applicationId: appId,
        to: [...new Set(members.map((m) => m.email))],
        subject: `ARAF — Facility records for review — ${app.customer_name ?? ""} — ${app.ref}`,
        text: `The facility ${app.ref} (${app.customer_name ?? ""}) is complete. Its document archive ${built.filename} (${built.manifest.length} files) is ready for Legal and Shariah records review.\n\nOpen the request in ARAF to download the archive and mark it Received, then Reviewed:\n${caseLink(appId)}\n`,
      });
    }
    await audit(tx, ctx, { action: "FACILITY_ARCHIVE_CREATED", applicationId: appId, details: { archiveId: ins.rows[0].id, filename: built.filename, files: built.manifest.length, bytes: built.data.length } });
    await notify(tx, now, { recipientId: app.initiator_id, kind: "FACILITY_ARCHIVED", title: `Facility archived — ${app.ref}`, body: "The facility documents were archived and sent to Legal and Shariah for records review.", applicationId: appId, link: `/requests/${appId}`, dedupeKey: `facility-archived:${appId}` });
  });
  return true;
}

export async function latestArchive(q: Db, appId: string) {
  return (await q.query("SELECT id, filename, size_bytes, created_at FROM application_archives WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1", [appId])).rows[0] ?? null;
}

export async function handovers(q: Db, appId: string) {
  return (
    await q.query<{ group_code: Group; status: string; sent_at: Date; received_at: Date | null; reviewed_at: Date | null; comments: string | null; received_name: string | null; reviewed_name: string | null }>(
      `SELECT h.*, r.full_name AS received_name, v.full_name AS reviewed_name FROM application_handovers h
         LEFT JOIN staff r ON r.id = h.received_by LEFT JOIN staff v ON v.id = h.reviewed_by WHERE h.application_id = $1 ORDER BY h.group_code`,
      [appId],
    )
  ).rows;
}

/** Legal / Shariah reviewer: mark the archive Received, then Reviewed (comments required for Reviewed). */
export async function updateHandover(ctx: Ctx, appId: string, group: Group, to: "RECEIVED" | "REVIEWED", comments: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!(group in GROUP_ROLE)) throw invalid("Unknown group.");
  if (to === "REVIEWED" && comments.trim().length < 5) throw invalid("Add your review comments.", { comments: "Add your review comments." });
  await withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, GROUP_ROLE[group]))) throw forbidden(`Only ${group === "LEGAL" ? "Legal" : "Shariah Compliance"} reviewers can update this.`);
    const h = (await tx.query("SELECT * FROM application_handovers WHERE application_id = $1 AND group_code = $2 FOR UPDATE", [appId, group])).rows[0];
    if (!h) throw notFound();
    if (to === "RECEIVED" && h.status !== "SENT") throw conflict("Already received.");
    if (to === "REVIEWED" && h.status === "REVIEWED") throw conflict("Already reviewed.");
    if (to === "RECEIVED") await tx.query("UPDATE application_handovers SET status = 'RECEIVED', received_by = $3, received_at = $4 WHERE application_id = $1 AND group_code = $2", [appId, group, actor.staffId, ctx.now]);
    else
      await tx.query(
        "UPDATE application_handovers SET status = 'REVIEWED', received_by = COALESCE(received_by, $3), received_at = COALESCE(received_at, $4), reviewed_by = $3, reviewed_at = $4, comments = $5 WHERE application_id = $1 AND group_code = $2",
        [appId, group, actor.staffId, ctx.now, comments.trim()],
      );
    const left = await tx.query("SELECT 1 FROM application_handovers WHERE application_id = $1 AND status <> 'REVIEWED'", [appId]);
    if (!left.rowCount) await tx.query("UPDATE applications SET records_status = 'REVIEW_COMPLETED' WHERE id = $1", [appId]);
    await audit(tx, ctx, { action: `RECORDS_${to}`, actorRole: GROUP_ROLE[group], applicationId: appId, details: { group, comments: comments.trim() || null } });
  });
}

/** Archive download (case access re-checked by the caller's route). */
export async function readArchive(q: Db, archiveId: string) {
  const a = (await q.query("SELECT * FROM application_archives WHERE id = $1", [archiveId])).rows[0];
  if (!a) throw notFound();
  return { archive: a, data: await objectStore().get(a.storage_key) };
}
