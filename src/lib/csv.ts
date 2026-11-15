/**
 * CSV writing shared by server exports and browser downloads (error reports). Output is RFC 4180 with a
 * UTF-8 BOM and CRLF line endings so Excel opens it correctly. Cells that a spreadsheet would treat as a
 * formula are prefixed with an apostrophe (formula-injection protection).
 */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  return "﻿" + [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export interface ImportRowError {
  /** Row number in the uploaded file (header = row 1). 0 = the file as a whole. */
  row: number;
  field?: string | null;
  message: string;
  suggestion?: string | null;
}

/** The downloadable error report for an import preview. */
export function errorReportCsv(errors: ImportRowError[]): string {
  return toCsv(
    ["Row", "Field", "Error", "Suggested correction"],
    errors.map((e) => [e.row || "file", e.field ?? "", e.message, e.suggestion ?? suggestionFor(e)]),
  );
}

function suggestionFor(e: ImportRowError): string {
  const m = e.message.toLowerCase();
  if (m.includes("date")) return "Use the date format YYYY-MM-DD, e.g. 2026-11-14.";
  if (m.includes("imei")) return "Enter the 15-digit IMEI exactly as printed on the box (including the last check digit).";
  if (m.includes("amount") || m.includes("naira") || m.includes("kobo")) return "Enter the amount in naira with no currency sign, e.g. 116000 or 116000.50.";
  if (m.includes("duplicate") || m.includes("already")) return "Remove the repeated row or correct its reference.";
  if (m.includes("location")) return "Use the location name exactly as listed in ARAF (Altphones → Locations).";
  if (m.includes("required") || m.includes("missing") || m.includes("enter")) return "Fill in the missing value.";
  return "";
}
