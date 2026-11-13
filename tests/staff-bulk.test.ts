import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { bulkGrantRole, bulkProvisionStaff } from "@/server/domain/admin";
import { staffFinancingAccess } from "@/server/staff/permission";

const ADMIN = "superadmin@altbank.ng";
const head = "Full name,Email,State,Business unit";
const csv = (...lines: string[]) => Buffer.from([head, ...lines].join("\n") + "\n");
const staffCount = async () => Number((await db.query("SELECT count(*) AS n FROM staff")).rows[0].n);
const idOf = async (email: string) => (await db.query("SELECT id FROM staff WHERE email = $1", [email])).rows[0]?.id as string | undefined;

beforeEach(async () => {
  await resetDb();
});

describe("bulk staff provisioning", () => {
  const file = csv(
    "Nkechi New-Officer,new.officer@altbank.ng,LAGOS,Retail", // in the directory, not yet staff → NEW
    "Ade Okafor,rm.ade@altbank.ng,,", // already staff → EXISTS
    "Zainab Outside,zainab.outside@altbank.ng,KANO,Finance", // not in the directory
    "Bad Email,not-an-email,,",
    "Gmail User,someone@gmail.com,,",
    "Nkechi Again,new.officer@altbank.ng,,", // duplicate in the file
    "Wrong State,wrong.state@altbank.ng,ATLANTIS,",
    "Shariah Desk,shariah@altbank.ng,,", // group mailbox
  );

  it("checks a file without saving anything and explains every row", async () => {
    const before = await staffCount();
    const s = await bulkProvisionStaff(await ctxFor(ADMIN), { filename: "staff.csv", data: file, dryRun: true, addToDirectory: false });
    expect(s).toMatchObject({ totalRows: 8, toCreate: 1, existing: 1, errors: 6, applied: false, created: 0 });
    const by = Object.fromEntries(s.rows.map((r) => [r.row, r]));
    expect(by[2].outcome).toBe("NEW");
    expect(by[3].outcome).toBe("EXISTS");
    expect(by[4].message).toMatch(/not in the bank directory/);
    expect(by[5].message).toMatch(/email is not valid/);
    expect(by[6].message).toMatch(/@altbank\.ng/);
    expect(by[7].message).toMatch(/more than once/);
    expect(by[8].message).toMatch(/not a Nigerian state/);
    expect(by[9].message).toMatch(/group mailbox/);
    expect(await staffCount()).toBe(before);
  });

  it("provisions valid new rows (no roles), skips the rest, and audits it all", async () => {
    const before = await staffCount();
    const s = await bulkProvisionStaff(await ctxFor(ADMIN), { filename: "staff.csv", data: file, dryRun: false, addToDirectory: false });
    expect(s).toMatchObject({ applied: true, created: 1 });
    expect(await staffCount()).toBe(before + 1);
    const nk = (await db.query("SELECT full_name, region, business_unit, status FROM staff WHERE email = 'new.officer@altbank.ng'")).rows[0];
    expect(nk).toEqual({ full_name: "Nkechi New-Officer", region: "LAGOS", business_unit: "Retail", status: "ACTIVE" });
    expect(Number((await db.query("SELECT count(*) AS n FROM role_assignments WHERE staff_id = $1", [await idOf("new.officer@altbank.ng")])).rows[0].n)).toBe(0);
    expect(await idOf("zainab.outside@altbank.ng")).toBeUndefined();
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'STAFF_PROVISIONED' AND details->>'via' = 'bulk upload'")).rows[0].n).toBe(1);
    expect((await db.query("SELECT details FROM audit_events WHERE action = 'STAFF_BULK_PROVISIONED'")).rows[0].details).toMatchObject({ created: 1, alreadyProvisioned: 1, skippedWithErrors: 6 });
    // Uploading the same file again changes nothing.
    const again = await bulkProvisionStaff(await ctxFor(ADMIN), { filename: "staff.csv", data: file, dryRun: false, addToDirectory: false });
    expect(again).toMatchObject({ created: 0, existing: 2 });
  });

  it("can add people missing from the bank directory when the admin chooses to", async () => {
    const s = await bulkProvisionStaff(await ctxFor(ADMIN), { filename: "new.csv", data: csv("Zainab Outside,Zainab.Outside@AltBank.ng,KANO,Finance"), dryRun: false, addToDirectory: true });
    expect(s).toMatchObject({ created: 1, addsToDirectory: 1 });
    expect((await db.query("SELECT full_name, source, active FROM bank_directory WHERE email = 'zainab.outside@altbank.ng'")).rows[0]).toEqual({ full_name: "Zainab Outside", source: "staff-bulk-upload", active: true });
    expect(await idOf("zainab.outside@altbank.ng")).toBeTruthy();
  });

  it("understands state names as people write them", async () => {
    const { normaliseState } = await import("@/server/domain/admin");
    expect(["Lagos", "lagos state", "Akwa Ibom", "akwa_ibom", "Abuja", "FCT", "Cross River State", ""].map(normaliseState)).toEqual(["LAGOS", "LAGOS", "AKWA IBOM", "AKWA IBOM", "FCT (ABUJA)", "FCT (ABUJA)", "CROSS RIVER", null]);
  });

  it("accepts common column names and refuses files without name and email columns", async () => {
    const s = await bulkProvisionStaff(await ctxFor(ADMIN), { filename: "x.csv", data: Buffer.from("Name,E-mail,Department\nNkechi New-Officer,new.officer@altbank.ng,Retail\n"), dryRun: true, addToDirectory: false });
    expect(s.rows[0]).toMatchObject({ outcome: "NEW", businessUnit: "Retail" });
    await expect(bulkProvisionStaff(await ctxFor(ADMIN), { filename: "x.csv", data: Buffer.from("Who,Where\na,b\n"), dryRun: true, addToDirectory: false })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("only a Super Admin can bulk upload", async () => {
    await expect(bulkProvisionStaff(await ctxFor("rm.ade@altbank.ng"), { filename: "s.csv", data: file, dryRun: true, addToDirectory: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("bulk role assignment", () => {
  it("assigns a role to many people, reports who already had it and who could not get it", async () => {
    const admin = await ctxFor(ADMIN);
    await bulkProvisionStaff(admin, { filename: "s.csv", data: csv("Nkechi New-Officer,new.officer@altbank.ng,LAGOS,Retail", "Zainab Outside,zainab.outside@altbank.ng,KANO,Finance"), dryRun: false, addToDirectory: true });
    const a = (await idOf("new.officer@altbank.ng"))!;
    const b = (await idOf("zainab.outside@altbank.ng"))!;
    const okoro = (await idOf("staff.okoro@altbank.ng"))!; // already a Staff Applicant
    // Newly provisioned staff are unprofiled: no Staff Financing until a role is assigned.
    expect(await staffFinancingAccess(db, a)).toMatchObject({ allowed: false, reason: "UNPROFILED" });
    const r = await bulkGrantRole(admin, { staffIds: [a, b, okoro, (await idOf(ADMIN))!], role: "STAFF_APPLICANT" });
    expect(r.granted).toBe(2);
    expect(r.alreadyHeld).toBe(1);
    expect(r.failed).toEqual([expect.objectContaining({ name: "Sade Admin", message: expect.stringMatching(/own role/) })]);
    expect(await staffFinancingAccess(db, a)).toMatchObject({ allowed: true });
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'ROLE_GRANTED' AND details->>'role' = 'STAFF_APPLICANT'")).rows[0].n).toBe(2);
    expect((await db.query("SELECT details FROM audit_events WHERE action = 'ROLE_BULK_GRANTED'")).rows[0].details).toMatchObject({ selected: 4, granted: 2, alreadyHeld: 1, failed: 1 });
  });

  it("applies the same rules as a single grant (team required for RMs) and is Super Admin only", async () => {
    const admin = await ctxFor(ADMIN);
    await bulkProvisionStaff(admin, { filename: "s.csv", data: csv("Nkechi New-Officer,new.officer@altbank.ng,LAGOS,Retail"), dryRun: false, addToDirectory: false });
    const a = (await idOf("new.officer@altbank.ng"))!;
    const noTeam = await bulkGrantRole(admin, { staffIds: [a], role: "RM" });
    expect(noTeam.failed[0].message).toMatch(/team/i);
    const withTeam = await bulkGrantRole(admin, { staffIds: [a], role: "RM", team: "RETAIL-LAGOS-1" });
    expect(withTeam.granted).toBe(1);
    await expect(bulkGrantRole(await ctxFor("rm.ade@altbank.ng"), { staffIds: [a], role: "UNIT_HEAD" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(bulkGrantRole(admin, { staffIds: [], role: "RM" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
