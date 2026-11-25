/**
 * CRM attachments: private object storage (no personal data in keys), type sniffing, size limit, quarantine and
 * malware scan, and a ticket-level access check on every read. Internal attachments are never shown to the
 * complainant. Links are signed and bound to the viewer and their session.
 */
import { randomUUID } from "node:crypto";
import { db, withTx } from "../db";
import type { Ctx } from "../context";

import { audit } from "../audit";
import { config } from "../config";
import { hmac, safeEqualHex, sha256Hex } from "../crypto";
import { DomainError, conflict, forbidden, gate, invalid, notFound } from "../errors";
import { objectStore } from "../storage";
import { documentScanner, sniffAllowedType, ALLOWED_EXTENSIONS } from "../storage/scanner";
import { sanitizeFilename } from "../domain/documents";
import { canWork, crmPrincipal, isOversight, ticketView } from "./core";

export const CRM_MAX_FILES_PER_UPLOAD = 5;

export async function addAttachment(ctx: Ctx, ticketId: string, f: { filename: string; data: Buffer; internal?: boolean; purpose?: "EVIDENCE" | "RESOLUTION" }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!/^[0-9a-f-]{36}$/i.test(ticketId)) throw notFound("Ticket not found.");
  const filename = sanitizeFilename(f.filename || "attachment");
  if (!f.data.length) throw invalid("The file is empty.");
  if (f.data.length > config.maxUploadBytes) throw invalid(`The file exceeds the ${Math.round(config.maxUploadBytes / 1048576)} MB limit.`);
  const mime = sniffAllowedType(filename, f.data);
  if (!mime) throw invalid(`Unsupported or mismatched file type. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.`);
  const id = randomUUID();
  const quarantineKey = `quarantine/crm/${id}`;
  // Access is checked before storing anything.
  const p = await crmPrincipal(db, actor.staffId);
  const t0 = (await db.query("SELECT id, creator_id, team_id, assignee_id, status FROM crm_tickets WHERE id = $1", [ticketId])).rows[0];
  if (!t0 || !(await ticketView(db, p, t0))) throw notFound("Ticket not found.");
  try {
    await objectStore().put(quarantineKey, f.data, mime);
  } catch (e) {
    console.error("[crm] object storage write failed", e);
    throw new DomainError("CONFIG", "File storage is not available. An administrator must check the object storage configuration.");
  }
  try {
    await withTx(async (tx) => {
      const t = (await tx.query("SELECT id, ref, creator_id, team_id, assignee_id, status, application_id FROM crm_tickets WHERE id = $1 FOR UPDATE", [ticketId])).rows[0];
      if (!t) throw notFound("Ticket not found.");
      const view = await ticketView(tx, p, t);
      if (!view) throw notFound("Ticket not found.");
      if (t.status === "CLOSED") throw conflict("This ticket is closed.");
      const handler = canWork(p, t) || (view === "FULL" && (p.officerTeams.includes(t.team_id) || isOversight(p)));
      if (!handler && t.creator_id !== p.staffId) throw forbidden("You can follow this ticket but not add files to it.");
      const internal = !!f.internal && handler;
      const purpose = f.purpose === "RESOLUTION" && handler ? "RESOLUTION" : "EVIDENCE";
      await tx.query(
        `INSERT INTO crm_attachments (id, ticket_id, filename, mime_type, size_bytes, sha256, storage_key, scan_status, internal, purpose, uploaded_by, uploaded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'QUARANTINED',$8,$9,$10,$11)`,
        [id, t.id, filename, mime, f.data.length, sha256Hex(f.data), quarantineKey, internal, purpose, p.staffId, ctx.now],
      );
      await tx.query("INSERT INTO crm_events (ticket_id, at, actor_id, kind, visibility, body, details) VALUES ($1,$2,$3,'ATTACHMENT',$4,$5,$6)", [t.id, ctx.now, p.staffId, internal ? "INTERNAL" : "PUBLIC", `Attached ${filename}.`, JSON.stringify({ attachmentId: id, purpose })]);
      await tx.query("UPDATE crm_tickets SET updated_at = $2 WHERE id = $1", [t.id, ctx.now]);
      await audit(tx, ctx, { action: "CRM_ATTACHMENT_ADDED", applicationId: t.application_id, details: { ticketId: t.id, ref: t.ref, attachmentId: id, size: f.data.length, internal, purpose } });
    });
  } catch (e) {
    await objectStore().delete(quarantineKey);
    throw e;
  }
  const scan = await scanAttachment(id).catch((err) => {
    console.error("[crm] scan deferred to worker", err);
    return "QUARANTINED";
  });
  return { id, scanStatus: scan };
}

export async function scanAttachment(id: string): Promise<string> {
  const a = (await db.query<{ id: string; ticket_id: string; storage_key: string; scan_status: string }>("SELECT id, ticket_id, storage_key, scan_status FROM crm_attachments WHERE id = $1", [id])).rows[0];
  if (!a || a.scan_status !== "QUARANTINED") return a?.scan_status ?? "MISSING";
  const res = await documentScanner().scan(await objectStore().get(a.storage_key));
  if (res.deferred) return "QUARANTINED";
  if (res.clean) {
    const key = `crm/${a.ticket_id}/${a.id}`;
    await objectStore().move(a.storage_key, key);
    await db.query("UPDATE crm_attachments SET scan_status = 'CLEAN', scan_detail = $2, storage_key = $3 WHERE id = $1", [a.id, res.detail, key]);
    return "CLEAN";
  }
  await db.query("UPDATE crm_attachments SET scan_status = 'REJECTED', scan_detail = $2 WHERE id = $1", [a.id, res.detail]);
  return "REJECTED";
}

export async function rescanCrmAttachments(now = new Date()) {
  const rows = (await db.query<{ id: string }>("SELECT id FROM crm_attachments WHERE scan_status = 'QUARANTINED' AND uploaded_at < $1 LIMIT 20", [new Date(now.getTime() - 60_000)])).rows;
  for (const r of rows) await scanAttachment(r.id).catch((e) => console.error("[crm] scan failed", r.id, e));
}

export function signAttachmentLink(id: string, staffId: string, sessionId: string, mode: "view" | "download", now = new Date()) {
  const exp = Math.floor(now.getTime() / 1000) + 15 * 60;
  return `/api/crm/attachments/${id}?mode=${mode}&exp=${exp}&sig=${hmac(`crm-att:${id}|${staffId}|${sessionId}|${mode}|${exp}`)}`;
}
export function verifyAttachmentLink(id: string, staffId: string, sessionId: string, mode: string, exp: string, sig: string, now = new Date()) {
  if (!/^\d+$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig) || Number(exp) < Math.floor(now.getTime() / 1000)) return false;
  return safeEqualHex(sig, hmac(`crm-att:${id}|${staffId}|${sessionId}|${mode}|${exp}`));
}

/** Authorised read: ticket access, internal files only for handlers, clean files only; every read audited. */
export async function readAttachment(ctx: Ctx, id: string, mode: "view" | "download") {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("File not found.");
  const a = (await db.query("SELECT a.*, t.creator_id, t.team_id, t.assignee_id, t.ref, t.application_id FROM crm_attachments a JOIN crm_tickets t ON t.id = a.ticket_id WHERE a.id = $1", [id])).rows[0];
  if (!a) throw notFound("File not found.");
  const p = await crmPrincipal(db, actor.staffId);
  const view = await ticketView(db, p, { id: a.ticket_id, creator_id: a.creator_id, team_id: a.team_id, assignee_id: a.assignee_id });
  if (!view || (a.internal && view !== "FULL")) {
    await audit(db, ctx, { action: "CRM_ATTACHMENT_READ", outcome: "DENIED", details: { attachmentId: id } }).catch(() => undefined);
    throw notFound("File not found.");
  }
  if (a.scan_status === "QUARANTINED") throw gate("This file is still being scanned. Try again shortly.");
  if (a.scan_status === "REJECTED") throw forbidden("This file failed the malware scan and cannot be opened.");
  const data = await objectStore().get(a.storage_key);
  await audit(db, ctx, { action: mode === "download" ? "CRM_ATTACHMENT_DOWNLOADED" : "CRM_ATTACHMENT_VIEWED", applicationId: a.application_id, details: { ticketId: a.ticket_id, ref: a.ref, attachmentId: id } });
  return { file: a as { filename: string; mime_type: string }, data };
}


