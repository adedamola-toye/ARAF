/**
 * Reading uploaded CSV files. Uses a standards-compliant parser (@fast-csv/parse): quoted values with
 * commas, line breaks and doubled quotes, UTF-8 with or without a BOM, Windows or Unix line endings. The
 * file must be valid UTF-8; a semicolon-separated export (some Excel locales) is detected from the header.
 * Problems are reported, never silently dropped.
 */
import { parseString } from "@fast-csv/parse";
import { invalid } from "./errors";

export const DEFAULT_MAX_CSV_BYTES = 10 * 1024 * 1024;

export async function readCsv(data: Buffer, maxBytes = DEFAULT_MAX_CSV_BYTES): Promise<string[][]> {
  if (data.length === 0) throw invalid("The file is empty.", { file: "The file is empty." });
  if (data.length > maxBytes) throw invalid(`The file is larger than ${Math.round(maxBytes / 1048576)} MB.`, { file: "File too large." });
  if (data.subarray(0, 4).toString("binary") === "PK\u0003\u0004")
    throw invalid("This is an Excel workbook, not a CSV file. In Excel use File → Save As → CSV UTF-8 (Comma delimited).", { file: "Upload a .csv file." });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw invalid("The file is not UTF-8 text. In Excel use File → Save As → CSV UTF-8 (Comma delimited).", { file: "Save the file as CSV UTF-8." });
  }
  text = text.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  // An unterminated quote would swallow the rest of the file: check the quote balance first.
  if ((text.match(/"/g)?.length ?? 0) % 2 === 1) throw invalid("The file has an unclosed quotation mark, so its rows cannot be read reliably. Check the row where a value starts with \" but does not end with one.", { file: "Unclosed quotation mark." });
  return new Promise((resolve, reject) => {
    const rows: string[][] = [];
    parseString(text, { delimiter, ignoreEmpty: false, trim: false })
      .on("error", (e) => reject(invalid(`The CSV file could not be read: ${e.message}`, { file: "Unreadable CSV." })))
      .on("data", (r: string[]) => rows.push(r))
      .on("end", () => resolve(rows));
  }).then((rows) => (rows as string[][]).map((r) => (r.every((c) => c.trim() === "") ? [] : r)));
}
