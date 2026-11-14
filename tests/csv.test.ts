import { describe, expect, it } from "vitest";
import { readCsv } from "@/server/csv";
import { csvCell, errorReportCsv, toCsv } from "@/lib/csv";

const b = (s: string | Uint8Array) => Buffer.from(s as string);

describe("CSV reading", () => {
  it("handles BOM, quoted commas and quotes, embedded line breaks, CRLF and LF, keeping row numbers", async () => {
    const t = '﻿Name,Address,Note\r\n"Ikeja, Branch","12 ""A"" Road\nIkeja",x\r\n\r\nYaba,1 Herbert Macaulay,y\n';
    const rows = await readCsv(b(t));
    expect(rows[0]).toEqual(["Name", "Address", "Note"]);
    expect(rows[1]).toEqual(["Ikeja, Branch", '12 "A" Road\nIkeja', "x"]);
    expect(rows[2]).toEqual([]); // blank line kept as an empty row so row numbers stay true
    expect(rows[3]).toEqual(["Yaba", "1 Herbert Macaulay", "y"]);
  });

  it("accepts semicolon-separated exports", async () => {
    expect(await readCsv(b("A;B\n1;2\n"))).toEqual([["A", "B"], ["1", "2"]]);
  });

  it("refuses an Excel file, non-UTF-8 text, an unclosed quote, an empty or oversized file with a clear reason", async () => {
    await expect(readCsv(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).rejects.toMatchObject({ message: expect.stringMatching(/Excel workbook/) });
    await expect(readCsv(Buffer.from([0x41, 0x2c, 0xe9, 0x0a]))).rejects.toMatchObject({ message: expect.stringMatching(/not UTF-8/) });
    await expect(readCsv(b('A,B\n"open,2\n'))).rejects.toMatchObject({ message: expect.stringMatching(/unclosed quotation/) });
    await expect(readCsv(Buffer.alloc(0))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(readCsv(b("A\n1\n"), 2)).rejects.toMatchObject({ message: expect.stringMatching(/larger than/) });
  });
});

describe("CSV writing", () => {
  it("neutralises formulas but keeps negative numbers, and quotes where needed", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+234")).toBe("'+234");
    expect(csvCell("-1500.25")).toBe("-1500.25");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(toCsv(["A"], [[1]])).toBe("﻿A\r\n1\r\n");
  });

  it("error report has row, field, error and a suggested correction", () => {
    const csv = errorReportCsv([{ row: 4, field: "IMEI", message: "IMEI has 14 digits" }]);
    expect(csv).toContain("Row,Field,Error,Suggested correction");
    expect(csv).toMatch(/4,IMEI,IMEI has 14 digits,Enter the 15-digit IMEI/);
  });
});
