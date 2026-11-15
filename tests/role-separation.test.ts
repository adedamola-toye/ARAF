import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { applyConfig, syntheticConfig } from "@/server/demo/retail-scenario";
import { ALT, setupAltphones } from "@/server/demo/altphones-scenario";
import { createDraft } from "@/server/domain/workflow";
import { createRetailDraft } from "@/server/domain/retail";
import { getCase } from "@/server/domain/views";
import { startSale } from "@/server/altphones/origination";
import { viewableApp } from "@/server/altphones/core";
import { availability, initiatorRolesFor, visibleProducts } from "@/app/(app)/requests/new/catalogue";
import { ORIGINATION_PRODUCTS } from "@/lib/origination-products";

const RM = "rm.bola@altbank.ng";
const rolesOf = async (email: string) => (await db.query<{ role: string }>("SELECT ra.role FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE s.email = $1 AND ra.active", [email])).rows.map((r) => r.role);
const approveAllRetail = async () => {
  for (const c of ["VENDOR_FINANCING", "ALT_DRIVE", "ALT_POWER"]) await applyConfig(c, syntheticConfig(c));
};

beforeEach(async () => {
  await resetDb();
});

describe("Test A: Relationship Manager products", () => {
  it("an RM sees exactly WakeelBoost, Vendor Financing, AltDrive and AltPower, and can start each one's own journey", async () => {
    await approveAllRetail();
    const roles = await rolesOf(RM);
    expect(visibleProducts(roles).map((p) => p.name)).toEqual(["WakeelBoost", "Vendor Financing", "AltDrive", "AltPower"]);
    for (const p of ORIGINATION_PRODUCTS) expect((await availability(db, p, roles, new Date())).status).toBe("OPEN");
    const ctx = await ctxFor(RM);
    const wb = await createDraft(ctx, { initiatorRole: "RM", applicantType: "INDIVIDUAL" });
    expect((await db.query("SELECT workflow FROM applications WHERE id = $1", [wb.id])).rows[0].workflow).toBe("WAKEELBOOST");
    for (const [code, profile, type] of [
      ["VENDOR_FINANCING", "BUSINESS_OWNER", "ENTERPRISE"],
      ["ALT_DRIVE", "SALARY_EARNER", "INDIVIDUAL"],
      ["ALT_POWER", "SALARY_EARNER", "INDIVIDUAL"],
    ] as const) {
      const r = await createRetailDraft(ctx, { initiatorRole: "RM", productCode: code, profile, applicantType: type });
      expect((await db.query("SELECT product_code FROM applications WHERE id = $1", [r.id])).rows[0].product_code).toBe(code);
    }
  });

  it("a product with no approved configuration, or closed, is shown as unavailable, never with invented rules", async () => {
    const roles = await rolesOf(RM);
    await db.query("INSERT INTO products (code, name, description, workflow, active, sort_order) VALUES ('TEST_RETAIL','Test Retail','x','RETAIL',true,99)");
    const a = await availability(db, { slug: "test", code: "TEST_RETAIL", name: "Test Retail", description: "x", kind: "RETAIL" }, roles, new Date());
    expect(a.status === "UNAVAILABLE" && a.reason).toMatch(/Awaiting product configuration/);
    await expect(createRetailDraft(await ctxFor(RM), { initiatorRole: "RM", productCode: "TEST_RETAIL", profile: "BUSINESS_OWNER", applicantType: "ENTERPRISE" })).rejects.toThrow(/no approved configuration/);
    await db.query("UPDATE products SET active = false WHERE code = 'ALT_POWER'");
    const ap = await availability(db, ORIGINATION_PRODUCTS.find((p) => p.code === "ALT_POWER")!, roles, new Date());
    expect(ap.status === "UNAVAILABLE" && ap.reason).toMatch(/not open/);
  });
});

describe("Test B: an RM cannot reach Altphones", () => {
  it("cannot start an Altphones sale or open a DO's Altphones application", async () => {
    await setupAltphones();
    const model = (await db.query<{ id: string }>("SELECT id FROM altphones_models WHERE active LIMIT 1")).rows[0].id;
    await expect(startSale(await ctxFor(RM), { kind: "CREDIT", modelId: model })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const sale = await startSale(await ctxFor(ALT.doOfficer), { kind: "CREDIT", modelId: model });
    await expect(viewableApp(await ctxFor(RM), db, sale.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db.query("SELECT 1 FROM audit_events WHERE outcome = 'DENIED' AND altphones_application_id = $1", [sale.id])).rowCount).toBeGreaterThan(0);
  });
});

describe("Test C: DO / SA see Altphones only", () => {
  it("DOs and SAs get no RM product, cannot start RM drafts, and cannot open an RM request", async () => {
    await approveAllRetail();
    for (const email of [ALT.doOfficer, ALT.sa]) {
      const roles = await rolesOf(email);
      expect(visibleProducts(roles)).toEqual([]);
      for (const p of ORIGINATION_PRODUCTS) expect(initiatorRolesFor(p, roles)).toEqual([]);
    }
    const dctx = await ctxFor(ALT.doOfficer);
    await expect(createRetailDraft(dctx, { initiatorRole: "DELIGHT_OFFICER", productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", applicantType: "ENTERPRISE" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createDraft(dctx, { initiatorRole: "DELIGHT_OFFICER", applicantType: "INDIVIDUAL" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rmCase = await createRetailDraft(await ctxFor(RM), { initiatorRole: "RM", productCode: "ALT_DRIVE", profile: "SALARY_EARNER", applicantType: "INDIVIDUAL" });
    await expect(getCase(dctx, rmCase.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getCase(await ctxFor(ALT.sa), rmCase.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
