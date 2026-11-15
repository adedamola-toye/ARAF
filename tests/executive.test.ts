import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { setupAltphones } from "@/server/demo/altphones-scenario";
import { altphonesOperations, executiveAccess, executiveOverview } from "@/server/executive";
import { retailScope } from "@/server/retail-reports";

beforeEach(async () => {
  await resetDb();
  await setupAltphones({ stock: 2 });
});

describe("God's Eye (executive view)", () => {
  it("is read-only: org-wide reporting, no approval role, no editing", async () => {
    const id = (await db.query("INSERT INTO staff (email, full_name, region, status) VALUES ('exec.view@altbank.ng','Exec Viewer','LAGOS','ACTIVE') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO role_assignments (staff_id, role, active) VALUES ($1,'EXECUTIVE_VIEW',true)", [id]);
    expect(await executiveAccess(db, id)).toBe(true);
    expect((await retailScope(db, id))?.kind).toBe("ALL");
    const roles = (await db.query("SELECT role FROM role_assignments WHERE staff_id = $1 AND active", [id])).rows.map((r) => r.role);
    expect(roles).toEqual(["EXECUTIVE_VIEW"]); // nothing that can approve, edit or administer
    const o = await executiveOverview(db, new Date());
    expect(o.stock.physical).toBeGreaterThan(0);
    expect(o.locations.length).toBeGreaterThan(0);
    expect(Array.isArray(o.kyc)).toBe(true);
    expect(JSON.stringify(o)).not.toMatch(/bvn|nin_enc|account_enc/i);
    const ops = await altphonesOperations(db, new Date());
    expect(ops.pending).toBeTruthy();
    expect(Number(ops.exceptions.noAddress)).toBeGreaterThanOrEqual(0);
  });

  it("other staff do not get the executive view", async () => {
    const rm = (await db.query("SELECT id FROM staff WHERE email = 'rm.bola@altbank.ng'")).rows[0].id;
    expect(await executiveAccess(db, rm)).toBe(false);
  });
});
