import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { db } from "@/server/db";
import { audits, resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { grantRole, provisionStaff } from "@/server/domain/admin";

const ADMIN = "superadmin@altbank.ng";
beforeEach(resetDb);

describe("Super Admin adds a staff member by email and name, then assigns a role", () => {
  it("adds the email to the bank directory and the staff list; the role is assigned afterwards", async () => {
    const ctx = await ctxFor(ADMIN);
    const id = await provisionStaff(ctx, { email: "New.Officer@altbank.ng", fullName: "New Officer", addToDirectory: true });
    expect((await db.query("SELECT email, full_name, status FROM staff WHERE id = $1", [id])).rows[0]).toEqual({ email: "new.officer@altbank.ng", full_name: "New Officer", status: "ACTIVE" });
    expect((await db.query("SELECT source FROM bank_directory WHERE email = 'new.officer@altbank.ng'")).rows[0].source).toBe("staff-manual-add");
    expect((await db.query("SELECT 1 FROM role_assignments WHERE staff_id = $1", [id])).rowCount).toBe(0); // no role yet
    expect((await audits("DIRECTORY_ENTRY_ADDED")).length).toBe(1);
    await grantRole(ctx, { staffId: id, role: "INVOICE_CONFIRMATION_OFFICER" });
    expect((await db.query("SELECT role FROM role_assignments WHERE staff_id = $1 AND active", [id])).rows).toEqual([{ role: "INVOICE_CONFIRMATION_OFFICER" }]);
  });

  it("only a Super Admin can add staff; only @altbank.ng addresses; no duplicates", async () => {
    await expect(provisionStaff(await ctxFor("rm.bola@altbank.ng"), { email: "x.y@altbank.ng", fullName: "X Y", addToDirectory: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db.query("SELECT 1 FROM bank_directory WHERE email = 'x.y@altbank.ng'")).rowCount).toBe(0);
    expect((await audits("STAFF_PROVISIONED")).some((a: { outcome: string }) => a.outcome === "DENIED")).toBe(true);
    const ctx = await ctxFor(ADMIN);
    await expect(provisionStaff(ctx, { email: "someone@gmail.com", fullName: "Outside Person", addToDirectory: true })).rejects.toThrow(/@altbank\.ng/);
    await provisionStaff(ctx, { email: "dup.person@altbank.ng", fullName: "Dup Person", addToDirectory: true });
    await expect(provisionStaff(ctx, { email: "dup.person@altbank.ng", fullName: "Dup Person", addToDirectory: true })).rejects.toThrow(/already on the staff list/);
  });

  it("the form asks only for email and name, with an Add to bank directory button, on a Super Admin page", () => {
    const form = readFileSync("src/app/(app)/admin/AdminForms.tsx", "utf8");
    const pf = form.slice(form.indexOf("export function ProvisionForm"), form.indexOf("export function GrantRoleForm"));
    expect(pf).toContain('name="email"');
    expect(pf).toContain('name="fullName"');
    expect(pf).not.toContain('name="role"');
    expect(pf).toContain("Add to bank directory");
    expect(readFileSync("src/app/(app)/admin/staff/page.tsx", "utf8")).toContain("await requireSuperAdmin();");
  });
});
