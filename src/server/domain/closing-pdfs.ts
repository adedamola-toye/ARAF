/**
 * Closing documents ARAF prepares as PDFs: the NIBSS Global Standing Instruction (GSI) mandate form for
 * individuals (wording exactly as the bank's form) and the Remita direct debit set-up sheet.
 * Pure rendering only: callers supply the values.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type PDFImage } from "pdf-lib";

const A4: [number, number] = [595.28, 841.89];
const ORANGE = rgb(0.93, 0.53, 0.05);
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.4, 0.4, 0.4);
const TEAL = rgb(0.0, 0.29, 0.25);
const LINE = rgb(0.0, 0.42, 0.37);

/** pdf-lib's standard fonts are WinAnsi: keep the typographic characters it has, replace anything else. */
export function pdfSafe(s: string | null | undefined): string {
  const ok = new Set("–—‘’“”•…€".split(""));
  return Array.from(String(s ?? ""))
    .map((c) => (c.charCodeAt(0) < 256 || ok.has(c) ? c : c === "₦" ? "NGN " : "?"))
    .join("")
    .replace(/[\r\n\t]+/g, " ");
}

async function asset(name: string): Promise<Buffer | null> {
  try {
    return await readFile(path.join(process.cwd(), "templates", "closing", name));
  } catch {
    return null;
  }
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = pdfSafe(text).split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Fit a value inside a box: shrink the font down to 7pt, then truncate. */
function fitText(page: PDFPage, value: string, x: number, y: number, w: number, font: PDFFont, size = 10) {
  let s = size;
  let t = pdfSafe(value);
  while (s > 7 && font.widthOfTextAtSize(t, s) > w) s -= 0.5;
  while (t.length > 1 && font.widthOfTextAtSize(t, s) > w) t = t.slice(0, -2) + "…";
  page.drawText(t, { x, y, size: s, font, color: INK });
}

// ─────────────────────────── GSI mandate (individuals) ───────────────────────────

export interface GsiValues {
  surname: string;
  firstName: string;
  middleName: string;
  mobile: string;
  email: string;
  address: string;
  bankName: string;
  branch: string;
  accountName: string;
  townCity: string;
  accountNumber: string;
  bvn: string;
  signatoryName: string;
  reference: string;
}

/** The six declarations, verbatim from the bank's GSI Mandate Form (Individuals). */
export const GSI_DECLARATIONS = [
  "Acknowledge that all the information provided above is true, accurate and consistent with my BVN details in all material respects;",
  "Authorize my Bank to debit any or all Bank account/Bank accounts linked to my Bank Verification Number (BVN) (with the exception of Joint accounts and Association accounts) now and in the future, across all Financial Institutions in Nigeria upon any default in my loan repayment toward recovery of such repayment amount;",
  "Authorize all Financial Institutions where I maintain Bank account(s) to honor all account balance enquiry and debit instrument(s) received through the NIBSS e-payments platform pursuant to (2) above;",
  "Indemnify and absolve all Financial Institutions and NIBSS from any and all liabilities that may arise from their participation in, collaboration and execution of all applicable instructions under the GSI scheme;",
  "Confirm my understanding of the ‘‘Inter-Bank Set-Off Instruction’’ that allows my Bank have access to cash from my Bank account/Bank accounts, both current and savings, with other Financial Institutions to pay off my obligations with my Bank;",
  "Give my consent to be bound by the contents, terms and conditions of this GSI mandate form.",
];

export async function buildGsiPdf(v: GsiValues): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`GSI Mandate Form (Individuals) ${v.reference}`);
  doc.setProducer("ARAF");
  doc.setCreator("ARAF — Retail Asset Factory");
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const serifBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const sans = await doc.embedFont(StandardFonts.Helvetica);
  const nibss = await asset("nibss.png");
  const bank = await asset("altbank.png");
  const imgs: { nibss: PDFImage | null; bank: PDFImage | null } = { nibss: nibss ? await doc.embedPng(nibss) : null, bank: bank ? await doc.embedPng(bank) : null };

  const M = 56;
  const W = A4[0] - M * 2;
  let p = doc.addPage(A4);
  let y = A4[1] - 60;
  const title = "GSI Mandate Form (Individuals)";
  p.drawText(title, { x: (A4[0] - serifBold.widthOfTextAtSize(title, 14)) / 2, y, size: 14, font: serifBold, color: INK });
  y -= 24;
  // Logos and passport-photo box
  if (imgs.nibss) p.drawImage(imgs.nibss, { x: M + 4, y: y - 52, width: 74, height: 44 });
  if (imgs.bank) p.drawImage(imgs.bank, { x: M + 110, y: y - 50, width: 104, height: 42 });
  p.drawRectangle({ x: A4[0] - M - 96, y: y - 76, width: 96, height: 76, borderColor: INK, borderWidth: 0.8 });
  p.drawText("(Affix passport photo)", { x: A4[0] - M - 98, y: y - 90, size: 8.5, font: sans, color: INK });
  y -= 112;
  const sub = "GLOBAL STANDING INSTRUCTION (GSI) MANDATE FORM";
  p.drawText(sub, { x: (A4[0] - sans.widthOfTextAtSize(sub, 10.5)) / 2, y, size: 10.5, font: sans, color: INK });
  y -= 14;
  p.drawText("(INDIVIDUAL)", { x: M, y, size: 10, font: sans, color: INK });
  y -= 8;

  const band = (label: string) => {
    p.drawRectangle({ x: M - 4, y: y - 16, width: W + 8, height: 16, color: ORANGE });
    p.drawText(label, { x: M, y: y - 12, size: 10, font: sans, color: INK });
    y -= 30;
  };
  const box = (label: string, value: string, x: number, w: number, required = false) => {
    p.drawText(label, { x, y: y - 12, size: 10, font: serif, color: INK });
    const lw = serif.widthOfTextAtSize(label, 10);
    if (required) p.drawText("*", { x: x + lw + 1, y: y - 12, size: 10, font: serif, color: rgb(0.75, 0.1, 0.1) });
    const bx = x + lw + (required ? 10 : 6);
    const bw = w - (bx - x);
    p.drawRectangle({ x: bx, y: y - 17, width: bw, height: 19, borderColor: INK, borderWidth: 0.8 });
    fitText(p, value, bx + 4, y - 11, bw - 8, sans, 10);
  };

  band("PERSONAL INFORMATION");
  const half = (W - 16) / 2;
  box("Surname:", v.surname, M, half);
  box("First Name:", v.firstName, M + half + 16, half);
  y -= 32;
  box("Middle Name:", v.middleName, M, half);
  box("Mobile Number:", v.mobile, M + half + 16, half);
  y -= 32;
  box("E-mail:", v.email, M, W);
  y -= 32;
  // Address: two lines
  p.drawText("Address:", { x: M, y: y - 12, size: 10, font: serif, color: INK });
  const ax = M + serif.widthOfTextAtSize("Address:", 10) + 6;
  p.drawRectangle({ x: ax, y: y - 30, width: W - (ax - M), height: 32, borderColor: INK, borderWidth: 0.8 });
  wrap(v.address, sans, 9.5, W - (ax - M) - 8).slice(0, 2).forEach((l, i) => p.drawText(l, { x: ax + 4, y: y - 11 - i * 12, size: 9.5, font: sans, color: INK }));
  y -= 52;

  band("ACCOUNT HOLDER DETAILS");
  box("Name of Bank", v.bankName, M, half, true);
  box("Branch:", v.branch, M + half + 16, half);
  y -= 32;
  box("Account Name:", v.accountName, M, half, true);
  box("Town/City:", v.townCity, M + half + 16, half);
  y -= 32;
  box("Account Number:", v.accountNumber, M, half);
  box("BVN:", v.bvn, M + half + 16, half, true);
  y -= 34;

  band("DECLARATION");
  p.drawText("I hereby:", { x: M, y: y + 2, size: 10.5, font: serif, color: INK });
  y -= 18;

  const ensure = (need: number) => {
    if (y - need < 60) {
      footer(p, sans, v.reference);
      p = doc.addPage(A4);
      y = A4[1] - 70;
    }
  };
  GSI_DECLARATIONS.forEach((d, i) => {
    const lines = wrap(d, serif, 11, W - 40);
    ensure(lines.length * 15 + 6);
    p.drawText(`${i + 1}.`, { x: M + 16, y, size: 11, font: serif, color: INK });
    lines.forEach((l, j) => p.drawText(l, { x: M + 34, y: y - j * 15, size: 11, font: serif, color: INK }));
    y -= lines.length * 15 + 6;
  });
  y -= 10;
  const dotted = (label: string, value = "") => {
    ensure(22);
    p.drawText(label, { x: M, y, size: 10, font: serif, color: INK });
    const lx = M + serif.widthOfTextAtSize(label, 10) + 4;
    p.drawLine({ start: { x: lx, y: y - 2 }, end: { x: M + 280, y: y - 2 }, thickness: 0.6, color: MUTED, dashArray: [1, 2] });
    if (value) fitText(p, value, lx + 4, y + 1, M + 276 - lx, sans, 10);
    y -= 22;
  };
  ensure(80);
  p.drawText("Authorized Signatory 1:", { x: M, y, size: 10.5, font: sans, color: INK });
  y -= 24;
  dotted("Name", v.signatoryName);
  dotted("Signature");
  dotted("Date");
  y -= 6;
  ensure(140);
  p.drawText("Witness :", { x: M, y, size: 10.5, font: sans, color: INK });
  y -= 24;
  dotted("Name");
  dotted("Signature");
  dotted("Date");
  dotted("Email");
  dotted("Phone Number");
  footer(p, sans, v.reference);
  doc.getPages().forEach((pg, i, all) => pg.drawText(`Page ${i + 1} of ${all.length}`, { x: M, y: 30, size: 8, font: sans, color: MUTED }));
  return Buffer.from(await doc.save());
}

function footer(p: PDFPage, font: PDFFont, ref: string) {
  const t = `Prepared by ARAF for ${pdfSafe(ref)} · to be signed by the customer`;
  p.drawText(t, { x: A4[0] - 56 - font.widthOfTextAtSize(t, 8), y: 30, size: 8, font, color: MUTED });
}

// ─────────────────────────── Remita direct debit set-up sheet ───────────────────────────

export interface RemitaValues {
  reference: string;
  generatedOn: string; // dd/mm/yyyy
  beneficiary: { name: string; phone: string; email: string; bank: string; account: string };
  description: string;
  amount: string; // "NGN 512,500.00"
  charges: string; // "" when not configured
  vatOnCharges: string;
  totalPayable: string;
  every: string; // Month
  startDate: string; // YYYY-MM-DD or ""
  endDate: string;
  payer: { name: string; phone: string; email: string; bank: string; account: string };
}

export async function buildRemitaSetupPdf(v: RemitaValues): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Remita direct debit set-up ${v.reference}`);
  doc.setProducer("ARAF");
  doc.setCreator("ARAF — Retail Asset Factory");
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const b = await doc.embedFont(StandardFonts.HelveticaBold);
  const p = doc.addPage(A4);
  const M = 30;
  const W = A4[0] - M * 2;
  let y = A4[1] - 50;
  const center = (t: string, size: number, font: PDFFont) => p.drawText(pdfSafe(t), { x: (A4[0] - font.widthOfTextAtSize(pdfSafe(t), size)) / 2, y, size, font, color: INK });
  center(v.beneficiary.name || "Beneficiary", 9, f);
  y -= 10;
  p.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.4, color: rgb(0.85, 0.85, 0.85) });
  // RRR panel: left blank for Remita to issue when the mandate is created on the Remita platform.
  p.drawRectangle({ x: M + 6, y: y - 78, width: 66, height: 66, borderColor: INK, borderWidth: 0.6 });
  p.drawText("QR issued", { x: M + 18, y: y - 42, size: 7.5, font: f, color: MUTED });
  p.drawText("by Remita", { x: M + 18, y: y - 52, size: 7.5, font: f, color: MUTED });
  const right = (t: string, yy: number, size: number, font: PDFFont, color = INK) => p.drawText(pdfSafe(t), { x: A4[0] - M - 8 - font.widthOfTextAtSize(pdfSafe(t), size), y: yy, size, font, color });
  right(`Generated on ${v.generatedOn}`, y - 30, 8, f);
  right("Remita Retrieval Reference", y - 52, 8, b);
  p.drawRectangle({ x: A4[0] - M - 180, y: y - 92, width: 180, height: 28, color: rgb(0.94, 0.99, 0.9) });
  right("____-____-____", y - 83, 13, f, MUTED);
  y -= 122;
  center("Please note this is a Direct Debit Mandate, NOT a Payment RRR. Kindly verify the account and activate.", 8, b);
  y -= 22;

  const section = (title: string, rows: [string, string, boolean?][]) => {
    p.drawRectangle({ x: M - 10, y: y - 4, width: W + 20, height: 16, color: TEAL });
    const t = pdfSafe(title).split("").join(" ").replace(/ {3}/g, "   ");
    p.drawText(t, { x: (A4[0] - f.widthOfTextAtSize(t, 8)) / 2, y: y + 1, size: 8, font: f, color: rgb(1, 1, 1) });
    p.drawRectangle({ x: M - 10, y: y - 14 - rows.length * 15 - 14, width: W + 20, height: rows.length * 15 + 24, color: rgb(0.94, 0.94, 0.94) });
    y -= 26;
    for (const [k, val, accent] of rows) {
      p.drawText(pdfSafe(k), { x: M, y, size: 8, font: f, color: INK });
      right(val || " ", y, 8, f, accent ? LINE : INK);
      p.drawLine({ start: { x: M, y: y - 4 }, end: { x: A4[0] - M, y: y - 4 }, thickness: 0.5, color: LINE });
      y -= 15;
    }
    y -= 24;
  };
  section("Beneficiary Information", [
    ["Beneficiary Name", v.beneficiary.name],
    ["Phone Number", v.beneficiary.phone],
    ["Email", v.beneficiary.email],
    ["Bank", v.beneficiary.bank],
    ["Account No:", v.beneficiary.account],
  ]);
  section("Mandate Details", [
    ["Description of Payment", v.description],
    ["Amount", v.amount, true],
    ["Charges", v.charges, true],
    ["Vat On Charges", v.vatOnCharges, true],
    ["Total Payable", v.totalPayable, true],
    ["Every", v.every],
    ["Start Date", v.startDate],
    ["End Date", v.endDate],
  ]);
  section("Payer Information", [
    ["Name", v.payer.name],
    ["Phone Number", v.payer.phone],
    ["Email", v.payer.email],
    ["Bank", v.payer.bank],
    ["Account Number", v.payer.account],
  ]);
  y -= 6;
  p.drawText("PAYER SIGNATURE : _______________________________", { x: M + 24, y, size: 8, font: f, color: INK });
  y -= 30;
  p.drawText("FOR BANK USE ONLY", { x: M + 24, y, size: 8, font: b, color: INK });
  y -= 14;
  [
    "Create the mandate on Remita with the details above; Remita issues the Retrieval Reference (RRR) and QR code.",
    "Login to Remita, select 'Branch Operations' menu and then process RRR submenu.",
    "Enter the RRR Number and click continue.",
    "If your profile role is Branch teller or Branch customer service officer, click 'Activate Mandate'.",
    "For further details or enquiry contact Remita Support on 07004736482 or email support@remita.net",
  ].forEach((t, i) => {
    p.drawText(`${i + 1}.  ${t}`, { x: M + 30, y, size: 7.5, font: f, color: INK });
    y -= 12;
  });
  p.drawText(pdfSafe(`Prepared by ARAF for ${v.reference}. The RRR and QR code are issued by Remita; ARAF does not create the mandate on Remita.`), { x: M, y: 30, size: 7, font: f, color: MUTED });
  return Buffer.from(await doc.save());
}
