import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { audits, resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { provisionStaff } from "@/server/domain/admin";
import { DomainError } from "@/server/errors";

const ADMIN = "superadmin@altbank.ng";
beforeEach(resetDb);

describe("Super Admin adds one staff member and assigns a role on the spot", () => {
  it("adds a new @altbank.ng email to the directory, creates the staff record and grants the role", async () => {
    const ctx = await ctxFor(ADMIN);
    const id = await provisionStaff(ctx, { email: "New.Officer@altbank.ng", fullName: "New Officer", role: "RM", team: "RETAIL-LAGOS-1", addToDirectory: true });
    const s = (await db.query("SELECT email, full_name, status FROM staff WHERE id = $1", [id])).rows[0];
    expect(s).toEqual({ email: "new.officer@altbank.ng", full_name: "New Officer", status: "ACTIVE" });
    expect((await db.query("SELECT role, team FROM role_assignments WHERE staff_id = $1 AND active", [id])).rows).toEqual([{ role: "RM", team: "RETAIL-LAGOS-1" }]);
    expect((await db.query("SELECT source FROM bank_directory WHERE email = 'new.officer@altbank.ng'")).rows[0].source).toBe("staff-manual-add");
    expect((await audits("DIRECTORY_ENTRY_ADDED")).length).toBe(1);
    expect((await audits("STAFF_PROVISIONED")).length).toBeGreaterThan(0);
  });

  it("refuses an email outside the directory unless asked to add it, and keeps nothing when the role cannot be granted", async () => {
    const ctx = await ctxFor(ADMIN);
    await expect(provisionStaff(ctx, { email: "someone.new@altbank.ng", fullName: "Someone New" })).rejects.toThrow(/not in the bank directory/);
    await expect(provisionStaff(ctx, { email: "someone.new@altbank.ng", fullName: "Someone New", role: "RM", addToDirectory: true })).rejects.toBeInstanceOf(DomainError); // RM needs a team
    expect((await db.query("SELECT 1 FROM staff WHERE email = 'someone.new@altbank.ng'")).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM bank_directory WHERE email = 'someone.new@altbank.ng'")).rowCount).toBe(0);
    await expect(provisionStaff(ctx, { email: "someone@gmail.com", fullName: "Outside Person", addToDirectory: true })).rejects.toThrow(/@altbank\.ng/);
    await expect(provisionStaff(await ctxFor("rm.bola@altbank.ng"), { email: "x.y@altbank.ng", fullName: "X Y", addToDirectory: true })).rejects.toBeInstanceOf(DomainError);
  });

  it("an Invoice Confirmation Officer can be added and assigned in one step", async () => {
    const id = await provisionStaff(await ctxFor(ADMIN), { email: "ico.new@altbank.ng", fullName: "Invoice Officer", role: "INVOICE_CONFIRMATION_OFFICER", addToDirectory: true });
    expect((await db.query("SELECT role FROM role_assignments WHERE staff_id = $1 AND active", [id])).rows).toEqual([{ role: "INVOICE_CONFIRMATION_OFFICER" }]);
  });
});
