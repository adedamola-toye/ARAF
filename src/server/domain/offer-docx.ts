import JSZip from "jszip";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { invalid } from "../errors";
import type { ApplicantType } from "./application-data";

/**
 * DOCX offer templates (the bank's Word letters with {{placeholders}}).
 *  - `{{key}}` is replaced in document, header and footer parts (values are XML-escaped).
 *  - A paragraph containing `{{#list}} ... {{/list}}` is repeated once per item of `list`
 *    (used for directors 2..n of a Limited company); it is removed when the list is empty.
 * Placeholders must each sit inside one text run; `validateDocxTemplate` checks this.
 */
export type DocxValues = Record<string, string>;
export type DocxLoops = Record<string, DocxValues[]>;

const PARTS = /^word\/(document|header\d*|footer\d*)\.xml$/;
const TOKEN = /\{\{([#/]?)([a-z0-9_]+)\}\}/g;
const PARA = /<w:p[\s>](?:(?!<w:p[\s>]).)*?<\/w:p>/gs;

function xmlEscape(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function fill(xml: string, values: DocxValues) {
  return xml.replace(TOKEN, (m, flag: string, key: string) => (flag ? m : key in values ? xmlEscape(values[key]) : m));
}

export async function renderDocx(template: Buffer, values: DocxValues, loops: DocxLoops = {}): Promise<Buffer> {
  const zip = await JSZip.loadAsync(template);
  for (const name of Object.keys(zip.files)) {
    if (!PARTS.test(name)) continue;
    let xml = await zip.file(name)!.async("string");
    xml = xml.replace(PARA, (p) => {
      const m = /\{\{#([a-z0-9_]+)\}\}/.exec(p);
      if (!m) return p;
      const items = loops[m[1]] ?? [];
      const body = p.replace(`{{#${m[1]}}}`, "").replace(`{{/${m[1]}}}`, "");
      return items.map((it) => fill(body, { ...values, ...it })).join("");
    });
    xml = fill(xml, values);
    const left = /\{\{[#/]?[a-z0-9_]+\}\}/.exec(xml.replace(/<[^>]+>/g, ""));
    if (left) throw new Error(`Offer template placeholder ${left[0]} has no value`);
    zip.file(name, xml);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Placeholders every DOCX template must contain, by applicant type. */
export const REQUIRED_DOCX_PLACEHOLDERS: Record<ApplicantType, string[]> = {
  INDIVIDUAL: ["offer_date", "customer_name", "cost_price", "markup_rate_tenor", "cost_plus_markup", "apr", "tenor_months", "financed_items", "bvn"],
  ENTERPRISE: ["offer_date", "proprietor_name", "business_name", "cost_price", "markup_rate_tenor", "cost_plus_markup", "apr", "tenor_months", "financed_items", "bvn", "tin"],
  LIMITED: ["offer_date", "company_name", "cost_price", "markup_rate_tenor", "cost_plus_markup", "apr", "tenor_months", "financed_items", "tin", "first_director_name", "first_director_bvn", "#directors_rest", "director_name", "director_bvn"],
};

/** All placeholders the renderer can supply (anything else in a template is rejected). */
export const KNOWN_DOCX_PLACEHOLDERS = new Set([
  "offer_date", "request_ref", "customer_name", "proprietor_name", "business_name", "company_name", "customer_address",
  "registration_number", "facility_type", "cost_price", "cost_price_words", "markup", "markup_rate_tenor", "markup_rate_annual",
  "cost_plus_markup", "cost_plus_markup_words", "apr", "tenor_months", "financed_items", "asset_cost", "instalment_frequency",
  "instalment_amount", "takaful_rate", "stamp_duty_rate", "bvn", "tin", "first_director_name", "first_director_bvn",
  "director_index", "director_name", "director_bvn", "signatory_1_name", "signatory_1_title", "signatory_2_name", "signatory_2_title",
  "#directors_rest", "/directors_rest",
]);

/** Validate an uploaded DOCX template: readable, placeholders intact (one run each), required ones present. */
export async function validateDocxTemplate(buf: Buffer, type: ApplicantType): Promise<string[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    return ["The file is not a valid .docx document."];
  }
  if (!zip.file("word/document.xml")) return ["The file is not a Word document (word/document.xml missing)."];
  const errors: string[] = [];
  const found = new Set<string>();
  for (const name of Object.keys(zip.files)) {
    if (!PARTS.test(name)) continue;
    const xml = await zip.file(name)!.async("string");
    const intact = new Set([...xml.matchAll(TOKEN)].map((m) => m[1] + m[2]));
    const plain = new Set([...xml.replace(/<[^>]+>/g, "").matchAll(TOKEN)].map((m) => m[1] + m[2]));
    for (const t of plain) {
      if (!intact.has(t)) errors.push(`Placeholder {{${t}}} is split by Word formatting in ${name}. Retype it in one go (no formatting changes inside the braces).`);
      found.add(t);
    }
    if (/<w:drawing[\s\S]*?<\/w:drawing>/.test(xml) && /signature/i.test(xml)) errors.push("Templates must not contain signature images.");
  }
  for (const t of found) if (!KNOWN_DOCX_PLACEHOLDERS.has(t)) errors.push(`Unknown placeholder {{${t}}}.`);
  for (const r of REQUIRED_DOCX_PLACEHOLDERS[type]) if (!found.has(r)) errors.push(`Missing placeholder {{${r}}}.`);
  if (found.has("#directors_rest") !== found.has("/directors_rest")) errors.push("The {{#directors_rest}} … {{/directors_rest}} markers must both be in the same paragraph.");
  return [...new Set(errors)];
}

/**
 * Optional PDF copy for in-browser preview, using LibreOffice when available
 * (OFFER_PDF_CONVERTER=soffice, default when /usr/bin/soffice exists). The DOCX remains the
 * editable original; failure to convert never blocks offer generation.
 */
export async function docxToPdf(docx: Buffer): Promise<Buffer | null> {
  const mode = process.env.OFFER_PDF_CONVERTER ?? (existsSync("/usr/bin/soffice") ? "soffice" : "none");
  if (mode !== "soffice") return null;
  const bin = process.env.SOFFICE_PATH || "soffice";
  const dir = await mkdtemp(path.join(tmpdir(), "wb-offer-"));
  try {
    const src = path.join(dir, "offer.docx");
    await writeFile(src, docx);
    await new Promise<void>((resolve, reject) =>
      execFile(bin, ["--headless", "--norestore", `-env:UserInstallation=file://${dir}/profile`, "--convert-to", "pdf", "--outdir", dir, src], { timeout: 90_000 }, (err) => (err ? reject(err) : resolve())),
    );
    return await readFile(path.join(dir, "offer.pdf"));
  } catch (e) {
    console.error("[offer] PDF conversion failed", e);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function assertDocx(buf: Buffer) {
  if (buf.subarray(0, 4).toString("binary") !== "PK\u0003\u0004") throw invalid("Upload a .docx Word document.");
}
