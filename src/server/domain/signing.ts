/**
 * Signing on the Relationship Manager's tablet (finger or stylus). The customer reads the prepared document,
 * consents, and the RM confirms the customer's identity; each signatory signs on screen. ARAF produces a signed
 * PDF: the document itself, every page footed "Signed electronically", and a signature record page (signatory,
 * signature, time, consent, identity check, source document and version, device). Paper signing with an upload
 * of the signed copy remains available. ARAF never signs on a customer's behalf.
 */
import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { sha256Hex } from "../crypto";
import { objectStore } from "../storage";
import { formatLagos } from "../time";
import { forbidden, invalid, notFound } from "../errors";
import { holdsRole } from "./access";
import { storeGeneratedDocument, CATEGORY_LABEL } from "./documents";
import { pdfSafe } from "./closing-pdfs";

/** Prepared document → the signed category it satisfies. */
export const SIGNABLE: Record<string, string> = {
  GENERATED_OFFER: "SIGNED_OFFER",
  GENERATED_OFFER_PDF: "SIGNED_OFFER",
  GENERATED_GSI: "GSI_FORM",
  GENERATED_REMITA: "REMITA_MANDATE",
};
export const SIGNING_STAGES = ["OFFER_PREPARATION", "DISBURSEMENT_CORRECTION"];
export const ID_TYPES = ["National Identification Number (NIN) slip", "International passport", "Driver's licence", "Permanent voter's card"] as const;
export const SIGNATORY_ROLES = ["Customer", "Director", "Guarantor", "Witness"] as const;

export interface SignatoryInput {
  name: string;
  role: string;
  signaturePng: string; // data:image/png;base64,...
}
export interface SignInput {
  applicationId: string;
  sourceDocumentId: string;
  signatories: SignatoryInput[];
  consent: boolean;
  idType: string;
  idLast4: string;
  idVerified: boolean;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function decodeSignature(dataUrl: string): Buffer {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? "");
  if (!m) throw invalid("The signature could not be read. Ask the signatory to sign again.");
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > 400_000) throw invalid("The signature image is too large. Clear it and sign again.");
  if (buf.length < 600 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw invalid("The signature is empty. Ask the signatory to sign in the box.");
  return buf;
}

/** Plain-text blocks from a generated HTML letter (headings, paragraphs, table rows, list items). */
export function htmlToBlocks(html: string): { text: string; heading: boolean }[] {
  const body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "");
  const marked = body
    .replace(/<h[1-3][^>]*>/gi, "\n@@H@@")
    .replace(/<\/h[1-3]>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|ol|ul|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/t[hd]>\s*<t[hd][^>]*>/gi, ": ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&middot;/g, "·")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return marked
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && l !== "@@H@@")
    .map((l) => (l.startsWith("@@H@@") ? { text: l.slice(5).trim(), heading: true } : { text: l, heading: false }));
}

/** Paragraph text from a DOCX (WakeelBoost letters), when no PDF copy exists. */
export async function docxToBlocks(data: Buffer): Promise<{ text: string; heading: boolean }[]> {
  const zip = await JSZip.loadAsync(data);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  return xml
    .split(/<\/w:p>/)
    .map((p) => Array.from(p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)).map((m) => m[1]).join(""))
    .map((t) => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((text) => ({ text, heading: false }));
}

function wrap(text: string, font: PDFFont, size: number, width: number) {
  const out: string[] = [];
  let cur = "";
  for (const w of pdfSafe(text).split(" ")) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && cur) {
      out.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

async function textDocument(blocks: { text: string; heading: boolean }[], title: string): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const f = await doc.embedFont(StandardFonts.TimesRoman);
  const b = await doc.embedFont(StandardFonts.TimesRomanBold);
  const M = 56;
  const W = 595.28 - M * 2;
  let p = doc.addPage([595.28, 841.89]);
  let y = 841.89 - 64;
  for (const bl of blocks) {
    const font = bl.heading ? b : f;
    const size = bl.heading ? 14 : 11;
    for (const line of wrap(bl.text, font, size, W)) {
      if (y < 70) {
        p = doc.addPage([595.28, 841.89]);
        y = 841.89 - 64;
      }
      p.drawText(line, { x: M, y, size, font, color: rgb(0.1, 0.1, 0.1) });
      y -= size + 4;
    }
    y -= bl.heading ? 6 : 5;
  }
  return doc;
}

function footer(p: PDFPage, font: PDFFont, text: string) {
  const t = pdfSafe(text);
  p.drawText(t, { x: 40, y: 18, size: 7, font, color: rgb(0.35, 0.35, 0.35) });
}

/** Build the signed PDF from the prepared document (PDF as is; HTML / DOCX rendered as text). */
export async function buildSignedPdf(p: {
  source: { data: Buffer; mime: string; filename: string; id: string; version: number };
  ref: string;
  signatories: { name: string; role: string; png: Buffer }[];
  idType: string;
  idLast4: string;
  signedAt: Date;
  rmName: string;
  device: string | null;
}): Promise<Buffer> {
  let doc: PDFDocument;
  if (p.source.mime === "application/pdf") doc = await PDFDocument.load(p.source.data);
  else if (p.source.mime === "text/html") doc = await textDocument(htmlToBlocks(p.source.data.toString("utf8")), p.source.filename);
  else doc = await textDocument(await docxToBlocks(p.source.data), p.source.filename);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const b = await doc.embedFont(StandardFonts.HelveticaBold);
  const stamp = `Signed electronically on ARAF · ${p.ref} · ${formatLagos(p.signedAt)} · see the signature record page`;
  for (const pg of doc.getPages()) footer(pg, f, stamp);
  // Signature record page.
  const page = doc.addPage([595.28, 841.89]);
  const M = 50;
  let y = 841.89 - 60;
  const line = (t: string, font = f, size = 10, color = rgb(0.1, 0.1, 0.1)) => {
    for (const l of wrap(t, font, size, 595.28 - M * 2)) {
      page.drawText(l, { x: M, y, size, font, color });
      y -= size + 4;
    }
  };
  line("Signature record", b, 16);
  y -= 4;
  line(`Facility reference: ${p.ref}`);
  line(`Document: ${p.source.filename} (version ${p.source.version}, document ${p.source.id})`);
  line(`SHA-256 of the document as presented: ${sha256Hex(p.source.data)}`, f, 8);
  line(`Signed: ${formatLagos(p.signedAt)} (Lagos time) on the tablet of ${p.rmName}${p.device ? ` · device: ${p.device.slice(0, 120)}` : ""}`);
  line(`Identity check: ${p.idType} ending ${p.idLast4}, sighted and verified by ${p.rmName}.`);
  line("Consent: the signatories confirmed they had read the document and agreed to sign it electronically.");
  y -= 10;
  for (const s of p.signatories) {
    if (y < 170) break;
    line(`${s.role}: ${s.name}`, b, 11);
    const img = await doc.embedPng(s.png);
    const scale = Math.min(220 / img.width, 80 / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawRectangle({ x: M, y: y - h - 6, width: 240, height: h + 12, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.6 });
    page.drawImage(img, { x: M + 10, y: y - h, width: w, height: h });
    y -= h + 20;
    line(`Signature SHA-256: ${sha256Hex(s.png)}`, f, 7, rgb(0.4, 0.4, 0.4));
    y -= 8;
  }
  footer(page, f, stamp);
  return Buffer.from(await doc.save());
}

export async function signDocumentOnDevice(ctx: Ctx, i: SignInput, device: string | null) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!i.consent) throw invalid("Confirm that the customer has read the document and agrees to sign it electronically.", { consent: "Consent is required." });
  if (!i.idVerified) throw invalid("Confirm that you have verified the customer's identity against the original ID.", { idVerified: "Identity check is required." });
  if (!(ID_TYPES as readonly string[]).includes(i.idType)) throw invalid("Choose the ID type you checked.", { idType: "Choose the ID type." });
  if (!/^[A-Za-z0-9]{4}$/.test(i.idLast4)) throw invalid("Enter the last 4 characters of the ID number.", { idLast4: "Enter 4 characters." });
  if (!i.signatories.length || i.signatories.length > 4) throw invalid("Add between one and four signatories.");
  const signatories = i.signatories.map((s) => {
    const name = s.name.trim();
    if (name.length < 3) throw invalid("Enter each signatory's full name.", { signatories: "Enter each signatory's name." });
    if (!(SIGNATORY_ROLES as readonly string[]).includes(s.role)) throw invalid("Choose each signatory's capacity.");
    return { name, role: s.role, png: decodeSignature(s.signaturePng) };
  });
  return withTx(async (tx) => {
    const app = (await tx.query("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [i.applicationId])).rows[0];
    if (!app) throw notFound();
    const task = (await tx.query("SELECT * FROM tasks WHERE application_id = $1 AND status = 'OPEN'", [app.id])).rows[0];
    const isHolder = task && SIGNING_STAGES.includes(task.stage) && task.assignee_id === actor.staffId && (await holdsRole(tx, actor.staffId, task.assignee_role));
    if (!isHolder) throw forbidden("Documents are signed on the tablet of the officer preparing the offer pack.");
    const src = (await tx.query("SELECT * FROM documents WHERE id = $1 AND application_id = $2 AND superseded_at IS NULL", [i.sourceDocumentId, app.id])).rows[0];
    if (!src) throw notFound("That document is no longer current. Reload to sign the latest version.");
    const target = SIGNABLE[src.category];
    if (!target) throw invalid("This document cannot be signed on the tablet. Print it and upload the signed copy instead.");
    if (src.scan_status !== "CLEAN") throw invalid("This document is not available to sign.");
    const data = await objectStore().get(src.storage_key);
    const rm = (await tx.query<{ full_name: string }>("SELECT full_name FROM staff WHERE id = $1", [actor.staffId])).rows[0];
    const pdf = await buildSignedPdf({
      source: { data, mime: src.mime_type, filename: src.filename, id: src.id, version: src.version_no },
      ref: app.ref,
      signatories,
      idType: i.idType,
      idLast4: i.idLast4.toUpperCase(),
      signedAt: ctx.now,
      rmName: rm?.full_name ?? "the officer",
      device,
    });
    const meta = {
      signedOnDevice: "true",
      sourceDocumentId: src.id,
      sourceVersion: String(src.version_no),
      signatories: signatories.map((s) => `${s.role}: ${s.name}`).join("; "),
      consentAt: ctx.now.toISOString(),
      idCheck: `${i.idType} ending ${i.idLast4.toUpperCase()}`,
    };
    const stored = await storeGeneratedDocument(tx, ctx, {
      appId: app.id,
      category: target,
      filename: `${target.toLowerCase()}-${app.ref}-signed.pdf`,
      mime: "application/pdf",
      data: pdf,
      templateId: null,
      templateVersion: null,
      role: task.assignee_role,
      stage: app.stage,
      versionId: app.current_version_id,
      meta,
    });
    await audit(tx, ctx, {
      action: "DOCUMENT_SIGNED_ON_DEVICE",
      actorRole: task.assignee_role,
      applicationId: app.id,
      stage: app.stage,
      documentId: stored.id,
      documentVersion: stored.version,
      details: {
        signedCategory: target,
        signedLabel: CATEGORY_LABEL[target],
        sourceDocumentId: src.id,
        sourceVersion: src.version_no,
        sourceSha256: sha256Hex(data),
        signatories: signatories.map((s) => ({ name: s.name, role: s.role, signatureSha256: sha256Hex(s.png) })),
        consent: true,
        idCheck: { type: i.idType, last4: i.idLast4.toUpperCase(), verifiedBy: actor.staffId },
        device: device?.slice(0, 200) ?? null,
      },
    });
    return { documentId: stored.id, category: target };
  });
}
