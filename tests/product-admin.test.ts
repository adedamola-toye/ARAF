import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { applyConfig, syntheticConfig } from "@/server/demo/retail-scenario";
import { createProduct, listContractTypes, proposeMarkup, proposeTenor, saveContractType } from "@/server/domain/product-admin";
import { decideProductConfig, effectiveConfig, structureLabel } from "@/server/domain/products";

const today = () => new Date(Date.now() - 60_000);
const approve = async (id: string) => decideProductConfig(await ctxFor("config.approver@altbank.ng"), { configId: id, approve: true, note: "" });

beforeEach(async () => {
  await resetDb();
  // Alt Drive with both Murabaha and Ijarah, as configured by the bank.
  await applyConfig(
    "ALT_DRIVE",
    syntheticConfig("ALT_DRIVE", (c) => {
      for (const r of Object.values(c.profiles)) {
        if (!r) continue;
        r.structures = [
          { code: "MURABAHA", ratePercent: "34", rateConvention: "FLAT_PER_ANNUM", insuranceBearer: "CUSTOMER", contractSequence: [] },
          { code: "IJARAH", ratePercent: "39.5", rateConvention: "FLAT_PER_ANNUM", insuranceBearer: "BANK", contractSequence: [] },
        ];
      }
    }),
  );
});

describe("mark-up per contract type", () => {
  it("sets Murabaha and Ijarah separately; takes effect only after a different approver approves", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    const r = await proposeMarkup(admin, { productCode: "ALT_DRIVE", profile: "ALL", contractType: "IJARAH", action: "SET", markupPercent: "41", effectiveFrom: today(), reason: "Pricing review" });
    let cfg = (await effectiveConfig(db, "ALT_DRIVE", new Date()))!.config;
    expect(cfg.profiles.SALARY_EARNER!.structures.find((s) => s.code === "IJARAH")!.ratePercent).toBe("39.5"); // not yet
    await expect(decideProductConfig(admin, { configId: r.id, approve: true, note: "" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await approve(r.id);
    cfg = (await effectiveConfig(db, "ALT_DRIVE", new Date()))!.config;
    for (const p of ["SALARY_EARNER", "BUSINESS_OWNER"] as const) {
      const s = cfg.profiles[p]!.structures;
      expect(s.find((x) => x.code === "IJARAH")!.ratePercent).toBe("41");
      expect(s.find((x) => x.code === "MURABAHA")!.ratePercent).toBe("34"); // untouched
    }
  });

  it("one profile only; validation; one open proposal per product", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    await expect(proposeMarkup(admin, { productCode: "ALT_DRIVE", profile: "ALL", contractType: "MURABAHA", action: "SET", markupPercent: "0", effectiveFrom: today(), reason: "x review" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(proposeMarkup(await ctxFor("rm.bola@altbank.ng"), { productCode: "ALT_DRIVE", profile: "ALL", contractType: "MURABAHA", action: "SET", markupPercent: "30", effectiveFrom: today(), reason: "x review" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const r = await proposeMarkup(admin, { productCode: "ALT_DRIVE", profile: "BUSINESS_OWNER", contractType: "MURABAHA", action: "SET", markupPercent: "32.25", effectiveFrom: today(), reason: "SME pricing" });
    await expect(proposeTenor(admin, { productCode: "ALT_DRIVE", profile: "ALL", minMonths: 12, maxMonths: 48, effectiveFrom: today(), reason: "Policy" })).rejects.toMatchObject({ code: "CONFLICT" });
    await approve(r.id);
    const cfg = (await effectiveConfig(db, "ALT_DRIVE", new Date()))!.config;
    expect(cfg.profiles.BUSINESS_OWNER!.structures.find((s) => s.code === "MURABAHA")!.ratePercent).toBe("32.25");
    expect(cfg.profiles.SALARY_EARNER!.structures.find((s) => s.code === "MURABAHA")!.ratePercent).toBe("34");
  });

  it("a new contract type can be created, offered on a product with its own mark-up, and removed; never deleted", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    const { code } = await saveContractType(admin, { name: "Diminishing Musharakah", description: "Partnership with declining bank share", isNew: true });
    expect(code).toBe("DIMINISHING_MUSHARAKAH");
    await expect(saveContractType(admin, { name: "diminishing musharakah", isNew: true })).rejects.toMatchObject({ code: "CONFLICT" });
    const r = await proposeMarkup(admin, { productCode: "ALT_DRIVE", profile: "SALARY_EARNER", contractType: code, action: "SET", markupPercent: "36", rateConvention: "FLAT_PER_ANNUM", effectiveFrom: today(), reason: "New contract" });
    await approve(r.id);
    let s = (await effectiveConfig(db, "ALT_DRIVE", new Date()))!.config.profiles.SALARY_EARNER!.structures;
    expect(s.map((x) => x.code)).toEqual(["MURABAHA", "IJARAH", code]);
    expect(structureLabel(code, s[2].label)).toBe("Diminishing Musharakah");
    const rm = await proposeMarkup(admin, { productCode: "ALT_DRIVE", profile: "SALARY_EARNER", contractType: code, action: "REMOVE", effectiveFrom: today(), reason: "Withdrawn" });
    await approve(rm.id);
    s = (await effectiveConfig(db, "ALT_DRIVE", new Date()))!.config.profiles.SALARY_EARNER!.structures;
    expect(s.map((x) => x.code)).toEqual(["MURABAHA", "IJARAH"]);
    await saveContractType(admin, { code, name: "Diminishing Musharakah", active: false, isNew: false });
    expect((await listContractTypes(db, { activeOnly: true })).map((c) => c.code)).not.toContain(code);
    await expect(proposeMarkup(admin, { productCode: "ALT_DRIVE", profile: "ALL", contractType: code, action: "SET", markupPercent: "36", effectiveFrom: today(), reason: "Retry" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(db.query("DELETE FROM contract_types WHERE code = $1", [code])).rejects.toThrow(/cannot be deleted/);
  });
});

describe("tenor and new products", () => {
  it("tenor changes are proposed and approved like any configuration change", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    await expect(proposeTenor(admin, { productCode: "ALT_DRIVE", profile: "ALL", minMonths: 24, maxMonths: 12, effectiveFrom: today(), reason: "Policy" })).rejects.toMatchObject({ code: "VALIDATION" });
    const r = await proposeTenor(admin, { productCode: "ALT_DRIVE", profile: "ALL", minMonths: 12, maxMonths: 60, effectiveFrom: today(), reason: "Credit policy 2027" });
    await approve(r.id);
    const cfg = (await effectiveConfig(db, "ALT_DRIVE", new Date()))!.config;
    expect([cfg.profiles.SALARY_EARNER!.minTenorMonths, cfg.profiles.SALARY_EARNER!.maxTenorMonths]).toEqual([12, 60]);
  });

  it("a new product starts closed, copying another product's rules, and needs approval", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    const { code, configId } = await createProduct(admin, { name: "Alt Solar", description: "Solar home systems", copyFrom: "ALT_DRIVE", reason: "Board approval 12/2026" });
    expect(code).toBe("ALT_SOLAR");
    expect((await db.query("SELECT active, workflow FROM products WHERE code = $1", [code])).rows[0]).toEqual({ active: false, workflow: "RETAIL" });
    expect(await effectiveConfig(db, code, new Date())).toBeNull();
    await expect(createProduct(admin, { name: "alt solar", copyFrom: "ALT_DRIVE", reason: "dup" })).rejects.toMatchObject({ code: "CONFLICT" });
    await approve(configId);
    const cfg = (await effectiveConfig(db, code, new Date()))!.config;
    expect(cfg.profiles.SALARY_EARNER!.structures.map((s) => s.ratePercent)).toEqual(["34", "39.5"]);
    const r = await proposeMarkup(admin, { productCode: code, profile: "ALL", contractType: "MURABAHA", action: "SET", markupPercent: "30", effectiveFrom: today(), reason: "Solar pricing" });
    expect(r.version).toBe(2);
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'PRODUCT_CREATED'")).rows[0].n).toBe(1);
  });
});
