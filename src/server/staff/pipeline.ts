/**
 * Post-completion documentation for Staff Personal Financing:
 *   1. build one ZIP archive of the facility's real records (nothing is fabricated for missing items)
 *      and keep it in the platform's encrypted object store;
 *   2. when SharePoint is configured, upload it to the customer-specific folder and verify the bytes
 *      (failures are recorded, retried with back-off and alerted; never reported as delivered);
 *   3. hand the stored archive over to Legal and Shariah Compliance (status "Sent to Legal and Shariah
 *      for Review"), whose receipt and review are tracked per group.
 * The financing status stays COMPLETED throughout; documentation_status tracks this lifecycle.
 * Every step is idempotent and runs under a per-request advisory lock, so retries and concurrent
 * workers never create a second archive, upload or handover.
 */
import JSZip from "jszip";
import type { Db, Tx } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { systemCtx } from "../context";
import { forbidden, gate, invalid, notFound } from "../errors";
import { sha256Hex } from "../crypto";
import { config } from "../config";
import { objectStore } from "../storage";
import { formatLagos } from "../time";
import { holdsRole } from "../domain/access";
import { escapeHtml } from "../domain/offer";
import { sanitizeFilename } from "../domain/documents";
import { ROLE_LABELS, type Role } from "../domain/roles";
import { PLATFORM_NAME } from "../brand";
import { bpsLabel, formatNairaKobo, STAFF_DOC_CATEGORIES, STAFF_STATUS_LABELS, type StaffStatus } from "@/lib/staff-financing";
import { alertOperations, auditDenied, lockRequest, notify, recordEvent, requestAccess, roleHolders, transition, type StaffRequestRow } from "./core";
import { documentLibrary, sharePointConfigured, SharePointError } from "./sharepoint";
import type { StaffDocumentRow } from "./documents";

export const archiveFilename = (ref: string) => `ARAF-STAFF-${ref}.zip`;

/** SharePoint folder for the staff member: the staff ID (no names, accounts or amounts in paths). */
export function staffFolderName(req: StaffRequestRow) {
  const id = String(req.staff_number ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return id ? `STAFF-${id}` : `STAFF-${String(req.applicant_id).slice(0, 8).toUpperCase()}`;
}

function backoffMs(attempts: number) {
  return Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;
}

// ------------------------------------------------------------------ archive

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#152b59;line-height:1.5}h1{font-size:20px}h2{font-size:15px;margin-top:22px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #dee5f3;vertical-align:top;font-size:13px}th{width:38%;color:#5f6c87;font-weight:600}</style></head>
<body><p style="font-size:12px;color:#5f6c87">${escapeHtml(PLATFORM_NAME)} · generated from the system of record</p>${body}</body></html>`;
const row = (k: string, v: unknown) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v === null || v === undefined || v === "" ? "—" : String(v))}</td></tr>`;
const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

async function names(q: Db, ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter(Boolean) as string[])];
  const r = list.length ? (await q.query<{ id: string; full_name: string }>("SELECT id, full_name FROM staff WHERE id = ANY($1)", [list])).rows : [];
  return new Map(r.map((x) => [x.id, x.full_name]));
}

export async function buildArchive(q: Db, req: StaffRequestRow): Promise<{ data: Buffer; manifest: { path: string; sha256: string; bytes: number; source: string }[] }> {
  const zip = new JSZip();
  const root = `ARAF-STAFF-${req.ref}`;
  const when = new Date(req.completed_at ?? Date.now());
  const manifest: { path: string; sha256: string; bytes: number; source: string }[] = [];
  const used = new Set<string>();
  const add = (path: string, data: Buffer | string, source: string) => {
    let p = path;
    for (let i = 2; used.has(p); i++) p = path.replace(/(\.[^./]+)?$/, `-${i}$1`);
    used.add(p);
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    zip.file(`${root}/${p}`, buf, { date: when });
    manifest.push({ path: p, sha256: sha256Hex(buf), bytes: buf.length, source });
  };

  const reviews = (await q.query("SELECT * FROM staff_request_reviews WHERE request_id = $1 ORDER BY created_at", [req.id])).rows;
  const docs = (await q.query<StaffDocumentRow>("SELECT * FROM staff_request_documents WHERE request_id = $1 AND removed_at IS NULL AND scan_status = 'CLEAN' ORDER BY seq", [req.id])).rows;
  const n = await names(q, [req.applicant_id, req.pm_reviewer_id, req.unit_head_id, req.divisional_head_id, req.disbursement_officer_id, req.disbursement_confirmed_by, ...reviews.map((r) => r.actor_id)]);
  const who = (id: string | null) => (id ? (n.get(id) ?? id) : "—");

  add(
    "01-application/application-summary.html",
    page(
      `Application ${req.ref}`,
      `<h1>Staff financing application ${escapeHtml(req.ref)}</h1><table>${[
        row("Staff name", req.full_name), row("Staff ID", req.staff_number), row("Department", req.department), row("Unit", req.unit),
        row("Staff email", req.email), row("Phone", req.phone), row("Salary account", `${req.salary_account_number ?? ""} (${req.salary_account_name ?? ""})`),
        row("Purpose", req.purpose), row("Gross financing amount", formatNairaKobo(req.gross_kobo)), row(`Deduction (${bpsLabel(req.deduction_rate_bps)})`, formatNairaKobo(req.deduction_kobo)),
        row("Net disbursement amount", formatNairaKobo(req.net_kobo)), row("Tenor", req.tenor_months ? `${req.tenor_months} months` : "Not collected"),
        row("Deduction acknowledged", formatLagos(req.deduction_acknowledged_at)), row("Declaration accepted", formatLagos(req.declaration_accepted_at)),
        row("First submitted", formatLagos(req.first_submitted_at)), row("Submissions", req.submission_count),
      ].join("")}</table>`,
    ),
    "staff_requests",
  );
  for (const d of docs.filter((x) => ["PAYSLIP", "ACCOUNT_STATEMENT", "STAFF_ID_CARD", "OTHER_SUPPORTING"].includes(x.category))) {
    add(`02-supporting-documents/${String(d.seq).padStart(2, "0")}-${d.category.toLowerCase()}-${sanitizeFilename(d.filename).replace(/\s+/g, "_")}`, await objectStore().get(d.storage_key), `document ${d.id}`);
  }
  const stageFile: Record<string, string> = { PRODUCT_MANAGER: "product-manager-review", UNIT_HEAD: "unit-head-decision", DIVISIONAL_HEAD: "divisional-head-approval" };
  for (const [stage, file] of Object.entries(stageFile)) {
    const list = reviews.filter((r) => r.stage === stage);
    if (!list.length) continue;
    add(
      `03-reviews/${file}.html`,
      page(
        `${file} ${req.ref}`,
        `<h1>${escapeHtml(file.replace(/-/g, " "))} · ${escapeHtml(req.ref)}</h1>` +
          list
            .map((r) => {
              const c = r.checklist as Record<string, unknown> | null;
              return `<h2>${escapeHtml(r.action)} · submission ${r.submission_no} · ${escapeHtml(formatLagos(r.created_at))}</h2><table>${[
                row("Decision by", `${who(r.actor_id)} (${ROLE_LABELS[r.actor_role as Role] ?? r.actor_role})`),
                ...(c
                  ? [
                      row("Staff account verified", c.accountVerified ? "Yes (manual check)" : "No"),
                      row("Three months of salary history reviewed", c.salaryHistoryReviewed ? "Yes (manual check)" : "No"),
                      row("Repayment within 50% of take-home pay", c.repaymentWithinLimit ? "Yes (manual check)" : "No"),
                      row("Verified take-home pay (recorded by reviewer)", c.verifiedTakeHomeKobo ? formatNairaKobo(c.verifiedTakeHomeKobo as number) : "Not recorded"),
                      row("Monthly repayment obligation (recorded by reviewer)", c.monthlyRepaymentKobo ? formatNairaKobo(c.monthlyRepaymentKobo as number) : "Not recorded"),
                    ]
                  : []),
                row("Recommendation", r.recommendation), row("Comments", r.comments), row("Designated Unit Head", r.designated_next_id ? who(r.designated_next_id) : null),
                row("Status change", `${STAFF_STATUS_LABELS[r.from_status as StaffStatus] ?? r.from_status} → ${STAFF_STATUS_LABELS[r.to_status as StaffStatus] ?? r.to_status}`),
              ].join("")}</table>`;
            })
            .join(""),
      ),
      "staff_request_reviews",
    );
  }
  for (const d of docs.filter((x) => x.category === "GENERATED_OFFER" && x.id === req.offer_document_id)) add(`04-offer/generated-offer-${sanitizeFilename(d.filename)}`, await objectStore().get(d.storage_key), `document ${d.id}`);
  for (const d of docs.filter((x) => x.id === req.signed_offer_document_id)) add(`04-offer/signed-offer-${sanitizeFilename(d.filename).replace(/\s+/g, "_")}`, await objectStore().get(d.storage_key), `document ${d.id}`);
  for (const d of docs.filter((x) => x.id === req.disbursement_evidence_document_id)) add(`05-disbursement/disbursement-evidence-${sanitizeFilename(d.filename).replace(/\s+/g, "_")}`, await objectStore().get(d.storage_key), `document ${d.id}`);
  const terms = (req.approved_terms ?? {}) as Record<string, unknown>;
  add(
    "05-disbursement/facility-summary.html",
    page(
      `Facility ${req.ref}`,
      `<h1>Facility summary ${escapeHtml(req.ref)}</h1><table>${[
        row("Financing status", STAFF_STATUS_LABELS[req.status as StaffStatus]), row("Approved gross amount", formatNairaKobo(terms.grossKobo as number)),
        row(`Deduction (${bpsLabel(Number(terms.deductionRateBps))})`, formatNairaKobo(terms.deductionKobo as number)), row("Net disbursement amount", formatNairaKobo(terms.netKobo as number)),
        row("Tenor", terms.tenorMonths ? `${terms.tenorMonths} months` : "Not collected"), row("Final approval", `${formatLagos(req.approved_at)} by ${who(req.approved_by)}`),
        row("Approved terms fingerprint (SHA-256)", req.approved_terms_sha256), row("Offer issued", formatLagos(req.offer_issued_at)), row("Offer deadline", formatLagos(req.offer_deadline_at)),
        row("Signed offer received", formatLagos(req.signed_offer_received_at)), row("Disbursement Officer", who(req.disbursement_officer_id)),
        row("Transaction reference", req.disbursement_txn_ref), row("Value date", req.disbursement_value_date ? String(req.disbursement_value_date).slice(0, 10) : null),
        row("Amount disbursed", formatNairaKobo(req.disbursed_amount_kobo)), row("Disbursement confirmed", `${formatLagos(req.disbursed_at)} by ${who(req.disbursement_confirmed_by)}`),
        row("Beneficiary", `${req.salary_account_number} (${req.salary_account_name})`),
      ].join("")}</table>`,
    ),
    "staff_requests",
  );
  add(
    "06-records/approval-history.html",
    page(
      `Approval history ${req.ref}`,
      `<h1>Approval history ${escapeHtml(req.ref)}</h1><table><tr><th>When</th><td><strong>Decision</strong></td></tr>${reviews
        .map((r) => `<tr><th>${escapeHtml(formatLagos(r.created_at))}</th><td>${escapeHtml(`${r.stage} ${r.action} by ${who(r.actor_id)}: ${r.comments ?? r.recommendation ?? ""}`)}</td></tr>`)
        .join("")}</table>`,
    ),
    "staff_request_reviews",
  );
  const events = (
    await q.query(
      `SELECT e.*, s.full_name FROM staff_request_events e LEFT JOIN staff s ON s.id = e.actor_id WHERE e.request_id = $1 ORDER BY e.id`,
      [req.id],
    )
  ).rows;
  add(
    "06-records/audit-report.csv",
    ["occurred_at,action,from_status,to_status,actor,actor_role,queue,outcome,comments,document_ids", ...events.map((e) => [e.occurred_at.toISOString(), e.action, e.from_status, e.to_status, e.full_name ?? "system", e.actor_role, e.queue, e.outcome, e.comments, (e.document_ids ?? []).join(" ")].map(csvCell).join(","))].join("\n"),
    "staff_request_events",
  );
  const list = manifest.slice();
  add("06-records/manifest.json", JSON.stringify({ ref: req.ref, generatedAt: new Date().toISOString(), files: list, omitted: omittedItems(req, docs, reviews) }, null, 2), "manifest");
  const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { data, manifest };
}

/** Items the spec lists that are not on record for this facility (named, never fabricated). */
function omittedItems(req: StaffRequestRow, docs: StaffDocumentRow[], reviews: { stage: string }[]) {
  const out: string[] = [];
  if (!docs.some((d) => ["PAYSLIP", "ACCOUNT_STATEMENT", "STAFF_ID_CARD", "OTHER_SUPPORTING"].includes(d.category))) out.push("No supporting documents were uploaded.");
  for (const s of ["PRODUCT_MANAGER", "UNIT_HEAD", "DIVISIONAL_HEAD"]) if (!reviews.some((r) => r.stage === s)) out.push(`No ${s} decision is on record.`);
  if (!req.disbursement_evidence_document_id) out.push("No disbursement evidence is on record.");
  return out;
}

// ------------------------------------------------------------------ pipeline

/** Advance the documentation lifecycle of one completed request as far as possible. */
export async function advanceDocumentation(requestId: string, now = new Date()): Promise<string> {
  return withTx(async (tx) => {
    const got = (await tx.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`staff-doc:${requestId}`])).rows[0].ok;
    if (!got) return "LOCKED";
    const ctx = systemCtx(now);
    let req = await lockRequest(tx, requestId);
    if (req.status !== "COMPLETED") return "NOT_COMPLETED";
    if (["SENT_TO_LEGAL_SHARIAH", "RECEIVED_BY_LEGAL_SHARIAH", "REVIEW_COMPLETED"].includes(req.documentation_status)) return req.documentation_status;

    // 1. archive (once)
    let archive = (await tx.query("SELECT * FROM staff_request_archives WHERE request_id = $1", [req.id])).rows[0];
    if (!archive) {
      try {
        const { data, manifest } = await buildArchive(tx, req);
        const key = `archives/staff-requests/${req.id}.zip`;
        await objectStore().put(key, data, "application/zip");
        archive = (
          await tx.query(
            `INSERT INTO staff_request_archives (request_id, filename, storage_key, sha256, size_bytes, manifest, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (request_id) DO NOTHING RETURNING *`,
            [req.id, archiveFilename(req.ref), key, sha256Hex(data), data.length, JSON.stringify(manifest), now],
          )
        ).rows[0];
        req = await transition(tx, ctx, req, {
          action: "ARCHIVE_CREATED",
          role: "SYSTEM",
          set: { documentation_status: sharePointConfigured() ? "AWAITING_SHAREPOINT" : "PREPARING_ARCHIVE", doc_last_error: null },
          details: { filename: archive.filename, sha256: archive.sha256, bytes: Number(archive.size_bytes), files: manifest.length },
        });
      } catch (e) {
        return scheduleRetry(tx, ctx, req, `Archive creation failed: ${(e as Error).message}`);
      }
    }

    // 2. SharePoint (when configured)
    let sharepointItem: string | null = null;
    if (sharePointConfigured()) {
      let sp = (await tx.query("SELECT * FROM staff_request_sharepoint WHERE request_id = $1", [req.id])).rows[0];
      const folder = `${config.sharepoint.rootFolder}/${staffFolderName(req)}`;
      if (!sp) {
        sp = (await tx.query(`INSERT INTO staff_request_sharepoint (request_id, archive_id, status, folder_path, created_at) VALUES ($1,$2,'PENDING',$3,$4) RETURNING *`, [req.id, archive.id, folder, now])).rows[0];
      }
      if (sp.status !== "VERIFIED") {
        try {
          const data = await objectStore().get(archive.storage_key);
          if (sha256Hex(data) !== archive.sha256) throw new SharePointError("The stored archive does not match its recorded checksum.", undefined, false);
          const lib = documentLibrary();
          const item = sp.drive_item_id ? { itemId: sp.drive_item_id, webUrl: sp.web_url } : await lib.upload(`${sp.folder_path}/${archive.filename}`, data);
          await tx.query("UPDATE staff_request_sharepoint SET drive_item_id = $2, web_url = $3, uploaded_at = coalesce(uploaded_at, $4) WHERE id = $1", [sp.id, item.itemId, item.webUrl, now]);
          const ok = await lib.verify(item.itemId, archive.sha256, Number(archive.size_bytes));
          if (!ok) {
            await tx.query("UPDATE staff_request_sharepoint SET drive_item_id = NULL WHERE id = $1", [sp.id]);
            throw new SharePointError("The file stored in SharePoint does not match the archive (checksum mismatch).");
          }
          await tx.query("UPDATE staff_request_sharepoint SET status = 'VERIFIED', verified_at = $2, attempts = attempts + 1, last_attempt_at = $2, last_error = NULL WHERE id = $1", [sp.id, now]);
          sharepointItem = item.itemId;
          req = await transition(tx, ctx, req, { action: "SHAREPOINT_UPLOAD_VERIFIED", role: "SYSTEM", set: { doc_last_error: null }, details: { folder: sp.folder_path, itemId: item.itemId, sha256: archive.sha256 } });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const attempts = sp.attempts + 1;
          await tx.query("UPDATE staff_request_sharepoint SET status = 'FAILED', attempts = $2, last_attempt_at = $3, last_error = $4 WHERE id = $1", [sp.id, attempts, now, msg.slice(0, 500)]);
          await recordEvent(tx, ctx, req, { action: "SHAREPOINT_UPLOAD_FAILED", role: "SYSTEM", outcome: "RETRY_SCHEDULED", comments: msg.slice(0, 500), details: { attempt: attempts } });
          if (attempts === 1 || attempts % 5 === 0) {
            await alertOperations(tx, ctx, req, "SHAREPOINT", "SharePoint upload failed", [
              `The documentation archive for ${req.ref} could not be stored in SharePoint (attempt ${attempts}): ${msg}`,
              "The archive is retained in the platform's encrypted storage and the upload will be retried automatically.",
            ], String(attempts));
            await tx.query("UPDATE staff_request_sharepoint SET alerted_at = $2 WHERE id = $1", [sp.id, now]);
          }
          return scheduleRetry(tx, ctx, req, `SharePoint upload failed: ${msg}`, attempts);
        }
      } else sharepointItem = sp.drive_item_id;
    } else if (req.documentation_status === "PREPARING_ARCHIVE") {
      await recordEvent(tx, ctx, req, {
        action: "SHAREPOINT_NOT_CONFIGURED",
        role: "SYSTEM",
        comments: `SharePoint is not configured (${documentLibrary().missingSettings().join(", ")}). The archive is held in the platform's encrypted storage.`,
      });
    }

    // 3. Legal and Shariah handover (once)
    const existing = (await tx.query("SELECT id FROM staff_request_handovers WHERE request_id = $1", [req.id])).rows[0];
    if (!existing) {
      const h = (await tx.query("INSERT INTO staff_request_handovers (request_id, archive_id, sharepoint_item_id, sent_at) VALUES ($1,$2,$3,$4) RETURNING id", [req.id, archive.id, sharepointItem, now])).rows[0];
      for (const [group, role] of [["LEGAL", "LEGAL_REVIEWER"], ["SHARIAH", "SHARIAH_REVIEWER"]] as const) {
        const people = (await roleHolders(tx, [role])).map((p) => p.email);
        const listed = (await tx.query<{ email: string }>("SELECT email FROM recipient_group_members WHERE group_code = $1", [group])).rows.map((r) => r.email);
        const to = [...new Set([...people, ...listed])];
        await tx.query("INSERT INTO staff_request_handover_groups (handover_id, group_code, status, notified_count) VALUES ($1,$2,'SENT',$3)", [h.id, group, to.length]);
        await notify(tx, ctx, req, `LEGAL_SHARIAH_${group}`, to, "Completed staff facility sent for documentation review", [
          `The documentation archive for completed staff facility ${req.ref} has been sent to ${group === "LEGAL" ? "Legal" : "Shariah Compliance"} for review.`,
          "Open the request in the platform to download the archive and record receipt and review.",
        ], group);
        if (!people.length) {
          await alertOperations(tx, ctx, req, `NO_${role}`, `No ${ROLE_LABELS[role]} role holder`, [`${req.ref} was handed over, but nobody holds the ${ROLE_LABELS[role]} role, so nobody can open it in the platform.`], role);
        }
      }
      req = await transition(tx, ctx, req, {
        action: "SENT_TO_LEGAL_SHARIAH",
        role: "SYSTEM",
        outcome: "HANDOVER_CREATED",
        set: { documentation_status: "SENT_TO_LEGAL_SHARIAH", doc_next_attempt_at: null, doc_last_error: null },
        details: { archiveId: archive.id, sharepointItemId: sharepointItem, archiveSha256: archive.sha256 },
      });
    }
    return req.documentation_status;
  });
}

async function scheduleRetry(tx: Tx, ctx: Ctx, req: StaffRequestRow, error: string, attempts = req.doc_attempts + 1) {
  await tx.query("UPDATE staff_requests SET doc_attempts = $2, doc_next_attempt_at = $3, doc_last_error = $4, updated_at = $5 WHERE id = $1", [
    req.id,
    attempts,
    new Date(ctx.now.getTime() + backoffMs(attempts)),
    error.slice(0, 500),
    ctx.now,
  ]);
  return "RETRY_SCHEDULED";
}

export async function kickDocumentation(requestId: string, now = new Date()) {
  return advanceDocumentation(requestId, now);
}

/** Worker: advance every completed request whose documentation step is due. */
export async function processStaffDocumentation(now = new Date()) {
  const due = (
    await db.query<{ id: string }>(
      `SELECT id FROM staff_requests WHERE status = 'COMPLETED' AND documentation_status IN ('NOT_STARTED','PREPARING_ARCHIVE','AWAITING_SHAREPOINT')
          AND (doc_next_attempt_at IS NULL OR doc_next_attempt_at <= $1) ORDER BY doc_next_attempt_at NULLS FIRST LIMIT 10`,
      [now],
    )
  ).rows;
  const results: Record<string, string> = {};
  for (const { id } of due) results[id] = await advanceDocumentation(id, now).catch((e) => `ERROR ${(e as Error).message}`);
  return results;
}

/** Super Admin: run the next documentation step now. */
export async function retryDocumentationNow(ctx: Ctx, id: string) {
  if (!ctx.actor || !(await holdsRole(db, ctx.actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can retry documentation processing.");
  await db.query("UPDATE staff_requests SET doc_next_attempt_at = $2 WHERE id = $1 AND status = 'COMPLETED'", [id, ctx.now]);
  await recordEvent(db, ctx, await (await import("./core")).loadRequest(db, id), { action: "DOCUMENTATION_RETRY_BY_ADMIN", role: "SUPER_ADMIN" });
  return advanceDocumentation(id, ctx.now);
}

// ------------------------------------------------------------------ Legal and Shariah

const GROUP_ROLE = { LEGAL: "LEGAL_REVIEWER", SHARIAH: "SHARIAH_REVIEWER" } as const;
type Group = keyof typeof GROUP_ROLE;

async function markGroup(tx: Tx, ctx: Ctx, req: StaffRequestRow, group: Group, step: "RECEIVED" | "REVIEWED", comments: string | null) {
  const h = (await tx.query("SELECT id FROM staff_request_handovers WHERE request_id = $1", [req.id])).rows[0];
  if (!h) throw notFound("This facility has not been handed over yet.");
  const g = (await tx.query("SELECT * FROM staff_request_handover_groups WHERE handover_id = $1 AND group_code = $2 FOR UPDATE", [h.id, group])).rows[0];
  if (step === "RECEIVED" && g.status !== "SENT") return req;
  if (step === "REVIEWED" && g.status === "REVIEWED") return req;
  if (step === "RECEIVED") {
    await tx.query("UPDATE staff_request_handover_groups SET status = 'RECEIVED', received_by = $3, received_at = $4 WHERE handover_id = $1 AND group_code = $2", [h.id, group, ctx.actor!.staffId, ctx.now]);
  } else {
    await tx.query(
      "UPDATE staff_request_handover_groups SET status = 'REVIEWED', received_by = coalesce(received_by, $3), received_at = coalesce(received_at, $4), reviewed_by = $3, reviewed_at = $4, comments = $5 WHERE handover_id = $1 AND group_code = $2",
      [h.id, group, ctx.actor!.staffId, ctx.now, comments],
    );
  }
  const all = (await tx.query<{ status: string }>("SELECT status FROM staff_request_handover_groups WHERE handover_id = $1", [h.id])).rows.map((r) => r.status);
  const docStatus = all.every((s) => s === "REVIEWED") ? "REVIEW_COMPLETED" : all.every((s) => s !== "SENT") ? "RECEIVED_BY_LEGAL_SHARIAH" : req.documentation_status;
  return transition(tx, ctx, req, {
    action: `${group}_${step === "RECEIVED" ? "RECEIPT_CONFIRMED" : "REVIEW_COMPLETED"}`,
    role: GROUP_ROLE[group],
    comments,
    set: { documentation_status: docStatus },
  });
}

async function reviewerGroup(tx: Db, ctx: Ctx, req: StaffRequestRow, group: string): Promise<Group> {
  if (group !== "LEGAL" && group !== "SHARIAH") throw invalid("Unknown review group.");
  if (!ctx.actor) throw forbidden();
  if (req.applicant_id === ctx.actor.staffId) throw forbidden("You cannot review your own facility.");
  if (!(await holdsRole(tx, ctx.actor.staffId, GROUP_ROLE[group]))) throw forbidden(`Only a ${ROLE_LABELS[GROUP_ROLE[group]]} can record this.`);
  return group;
}

export async function confirmHandoverReceipt(ctx: Ctx, id: string, group: string) {
  try {
    return await withTx(async (tx) => {
      const req = await lockRequest(tx, id);
      const g = await reviewerGroup(tx, ctx, req, group);
      return markGroup(tx, ctx, req, g, "RECEIVED", null);
    });
  } catch (e) {
    if (e instanceof Error && e.name === "DomainError" && (e as { code?: string }).code === "FORBIDDEN") await auditDenied(ctx, id, "HANDOVER_RECEIPT", e.message);
    throw e;
  }
}

export async function completeHandoverReview(ctx: Ctx, id: string, group: string, comments: string) {
  return withTx(async (tx) => {
    const req = await lockRequest(tx, id);
    const g = await reviewerGroup(tx, ctx, req, group);
    const c = (comments ?? "").trim();
    if (c.length < 3) throw invalid("Record the outcome of the review.", { comments: "Comments required." });
    return markGroup(tx, ctx, req, g, "REVIEWED", c);
  });
}

/** Archive download: Super Admins, Legal and Shariah reviewers only. A reviewer's first download records receipt. */
export async function readArchive(ctx: Ctx, id: string) {
  if (!ctx.actor) throw forbidden();
  const req = (await db.query<StaffRequestRow>("SELECT * FROM staff_requests WHERE id = $1", [id])).rows[0];
  if (!req) throw notFound();
  const as = await requestAccess(db, ctx.actor.staffId, req);
  if (!(as.has("ADMIN") || as.has("LEGAL") || as.has("SHARIAH"))) {
    await auditDenied(ctx, id, "ARCHIVE_READ", "Archive access is limited to Super Admins and Legal and Shariah reviewers");
    throw forbidden("The documentation archive is available to Legal, Shariah Compliance and Super Admins only.");
  }
  const a = (await db.query("SELECT * FROM staff_request_archives WHERE request_id = $1", [id])).rows[0];
  if (!a) throw gate("The archive has not been created yet.");
  const data = await objectStore().get(a.storage_key);
  if (sha256Hex(data) !== a.sha256) throw gate("The stored archive failed its integrity check. Operations have been alerted.");
  await recordEvent(db, ctx, req, { action: "ARCHIVE_DOWNLOADED", role: [...as].join(",") });
  for (const g of ["LEGAL", "SHARIAH"] as const) {
    if (as.has(g) && req.applicant_id !== ctx.actor.staffId) await withTx(async (tx) => markGroup(tx, ctx, await lockRequest(tx, id), g, "RECEIVED", null)).catch(() => undefined);
  }
  return { filename: a.filename as string, data };
}

export { STAFF_DOC_CATEGORIES };
