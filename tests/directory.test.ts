import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { db } from "@/server/db";
import { importDirectory, parseCsv, parseDirectoryFile } from "@/server/domain/directory";
import { ctxFor } from "@/server/demo/scenario";
import { audits, resetDb } from "./helpers";

const csv = (s: string) => Buffer.from(s, "utf8");
const dirRow = async (email: string) => (await db.query("SELECT * FROM bank_directory WHERE email = $1", [email])).rows[0];
const count = async () => Number((await db.query("SELECT count(*) FROM bank_directory")).rows[0].count);

beforeEach(async () => {
  await resetDb();
});

describe("parsing", () => {
  it("handles quotes, embedded commas, BOM and semicolon separators", () => {
    expect(parseCsv('﻿a,"b, c","d ""e"""\r\n1,2,3\r\n')).toEqual([["a", "b, c", 'd "e"'], ["1", "2", "3"]]);
    expect(parseCsv("a;b\n1;2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("accepts header aliases after a title row and normalises values", async () => {
    const r = await parseDirectoryFile(
      "export.csv",
      csv("Alternative Bank staff export,,,\nEmail Address,Staff Name,Dept,Status\nMAILTO:Ada.Obi@AltBank.ng,  Ada   Obi ,Credit,Active\nlegal@altbank.ng,Legal,,Inactive\n"),
    );
    expect(r.errors).toEqual([]);
    expect(r.columns).toMatchObject({ email: "Email Address", fullName: "Staff Name", department: "Dept", active: "Status" });
    expect(r.rows).toEqual([
      { email: "ada.obi@altbank.ng", fullName: "Ada Obi", department: "Credit", isGroupMailbox: false, active: true },
      { email: "legal@altbank.ng", fullName: "Legal", department: null, isGroupMailbox: false, active: false },
    ]);
  });

  it("reads .xlsx files", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Staff");
    ws.addRow(["Email", "Full name", "Group mailbox"]);
    ws.addRow(["x.y@altbank.ng", "X Y", "No"]);
    ws.addRow([{ text: "shariah@altbank.ng", hyperlink: "mailto:shariah@altbank.ng" }, "Shariah Desk", "Yes"]);
    const data = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await parseDirectoryFile("staff.xlsx", data);
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.email, x.isGroupMailbox])).toEqual([["x.y@altbank.ng", false], ["shariah@altbank.ng", true]]);
  });

  it("reports row errors with spreadsheet row numbers", async () => {
    const r = await parseDirectoryFile(
      "d.csv",
      csv("Email,Full name,Group mailbox,Active\nnot-an-email,A,No,Yes\nsomeone@gmail.com,B,No,Yes\nc@altbank.ng,,No,Yes\nd@altbank.ng,D,maybe,Yes\ne@altbank.ng,E,No,Yes\nE@altbank.ng,E2,No,Yes\n,,,\n"),
    );
    expect(r.rows.map((x) => x.email)).toEqual(["e@altbank.ng"]);
    expect(r.errors.map((e) => e.row)).toEqual([2, 3, 4, 5, 7]);
    expect(r.errors[1].message).toContain("not an @altbank.ng address");
    expect(r.errors[4].message).toContain("more than once (also row 6)");
  });

  it("rejects unsupported files and missing headers", async () => {
    await expect(parseDirectoryFile("d.pdf", csv("x"))).rejects.toThrow(/xlsx or a \.csv/);
    await expect(parseDirectoryFile("d.csv", csv("Name,Phone\nA,1\n"))).rejects.toThrow(/header row/);
    await expect(parseDirectoryFile("d.csv", Buffer.alloc(0))).rejects.toThrow(/empty/);
  });
});

describe("import", () => {
  it("previews without writing, then merges (add, update, reactivate) and audits", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    await db.query("UPDATE bank_directory SET active = false WHERE email = 'new.officer@altbank.ng'");
    const before = await count();
    const file = csv("Email,Full name,Department\nfresh.person@altbank.ng,Fresh Person,Ops\nnew.officer@altbank.ng,Nkechi New-Officer,Credit\n");
    const preview = await importDirectory(admin, { filename: "hr.csv", data: file, mode: "MERGE", dryRun: true });
    expect(preview).toMatchObject({ applied: false, added: 1, updated: 1, reactivated: 1, deactivated: 0 });
    expect(await count()).toBe(before);

    const done = await importDirectory(admin, { filename: "hr.csv", data: file, mode: "MERGE", dryRun: false });
    expect(done.applied).toBe(true);
    expect(await count()).toBe(before + 1);
    expect(await dirRow("new.officer@altbank.ng")).toMatchObject({ active: true, department: "Credit", source: "import:hr.csv" });
    const [a] = await audits("DIRECTORY_IMPORTED");
    expect(a.outcome).toBe("SUCCESS");
    expect(a.details).toMatchObject({ mode: "MERGE", filename: "hr.csv", added: 1, updated: 1, reactivated: 1 });

    const again = await importDirectory(admin, { filename: "hr.csv", data: file, mode: "MERGE", dryRun: true });
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
  });

  it("full replace deactivates missing entries (never deletes) and lists affected staff", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    const before = await count();
    const file = csv("Email,Full name\nsuperadmin@altbank.ng,Super Admin\nco1@altbank.ng,Credit Officer 1\n");
    const s = await importDirectory(admin, { filename: "full.csv", data: file, mode: "REPLACE", dryRun: false });
    expect(s.deactivated).toBe(before - 2);
    expect(await count()).toBe(before);
    expect((await dirRow("co2@altbank.ng")).active).toBe(false);
    expect((await dirRow("co1@altbank.ng")).active).toBe(true);
    const emails = s.staffNotInDirectory.map((x) => x.email);
    expect(emails).toContain("co2@altbank.ng");
    expect(emails).not.toContain("co1@altbank.ng");
    // Staff access itself is not changed automatically.
    expect((await db.query("SELECT status FROM staff WHERE email = 'co2@altbank.ng'")).rows[0].status).toBe("ACTIVE");
  });

  it("refuses to apply a file with row errors (nothing partial is written)", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    const before = await count();
    const file = csv("Email,Full name\nok.person@altbank.ng,OK\nbad@gmail.com,Bad\n");
    const p = await importDirectory(admin, { filename: "x.csv", data: file, mode: "MERGE", dryRun: true });
    expect(p.errors).toHaveLength(1);
    await expect(importDirectory(admin, { filename: "x.csv", data: file, mode: "MERGE", dryRun: false })).rejects.toThrow(/nothing was imported/);
    expect(await count()).toBe(before);
    expect(await dirRow("ok.person@altbank.ng")).toBeUndefined();
  });

  it("only the Super Admin can import; refusals are audited", async () => {
    const co = await ctxFor("co1@altbank.ng");
    await expect(importDirectory(co, { filename: "x.csv", data: csv("Email,Full name\na@altbank.ng,A\n"), mode: "MERGE", dryRun: true })).rejects.toThrow(/Super Admin/);
    const denied = (await audits("DIRECTORY_IMPORTED")).filter((a) => a.outcome === "DENIED");
    expect(denied).toHaveLength(1);
    expect(await dirRow("a@altbank.ng")).toBeUndefined();
  });
});
