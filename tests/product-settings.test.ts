/* eslint-disable @typescript-eslint/no-explicit-any -- configurations are edited as plain JSON, as in the editor */
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { audits, resetDb, staffId } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { applyConfig, createRetailCase, syntheticConfig } from "@/server/demo/retail-scenario";
import { discardDraft, dismissProposal, draftOf, productSettingsList, publishDraft, reviewSavedDraft, saveDraft, saveGeneralDirect, startDraft, versionsOf } from "@/server/domain/product-settings";
import { effectiveConfig, getProduct } from "@/server/domain/products";
import { createDraft } from "@/server/domain/workflow";
import { createRetailDraft, retailReadiness } from "@/server/domain/retail";
import { availability, originationSettings, visibleProducts } from "@/app/(app)/requests/new/catalogue";
import { ORIGINATION_PRODUCTS } from "@/lib/origination-products";
import { completeness, diffSettings, publishChecks, type General } from "@/lib/product-settings";
import { lagosDate } from "@/server/time";
import { DomainError } from "@/server/errors";

const ADMIN = "superadmin@altbank.ng";
const N = (naira: number) => naira * 100;
const REASON = "Credit committee memo CC/2026/21 approved the revised limits.";
const admin = () => ctxFor(ADMIN);
const today = () => lagosDate(new Date());
const plusDays = (d: number) => lagosDate(new Date(Date.now() + d * 86_400_000));

async function fails(p: Promise<unknown>, code?: string): Promise<DomainError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    if (code) expect((e as DomainError).code).toBe(code);
    return e as DomainError;
  }
  throw new Error("expected the call to fail");
}

/** A proposal left by the earlier maker-checker process (system-proposed, like migration 025's). */
async function systemProposal(code = "VENDOR_FINANCING") {
  const live = (await effectiveConfig(db, code, new Date()))!;
  const cfg = structuredClone(live.config) as any;
  cfg.profiles.BUSINESS_OWNER.dsr.maxPercent = "30";
  cfg.profiles.BUSINESS_OWNER.minTenorMonths = 12;
  const v = (await db.query<{ v: number }>("SELECT max(version) AS v FROM product_configs WHERE product_code = $1", [code])).rows[0].v + 1;
  await db.query("INSERT INTO product_configs (product_code, version, status, config, effective_from, reason, proposed_by, proposed_at) VALUES ($1, $2, 'PROPOSED', $3, now(), 'Policy update: 30% DSR and a 12-month minimum tenor', NULL, now())", [code, v, JSON.stringify(cfg)]);
  return (await versionsOf(db, code)).find((x) => x.version === v)!;
}

/** Start a draft from the version in force and apply a change to it. */
async function edit(code: string, change: (cfg: any, g: General) => void, effectiveFrom: string | null = today()) {
  const ctx = await admin();
  await startDraft(ctx, code, { kind: "VERSION" });
  const d = (await draftOf(db, code))!;
  const cfg = structuredClone(d.config) as any;
  const g = structuredClone(d.general);
  change(cfg, g);
  return saveDraft(ctx, code, { config: cfg, general: g, effectiveFrom, revision: d.revision });
}
const publish = async (code: string, extra: { reason?: string; effectiveFrom?: string | null } = {}) =>
  publishDraft(await admin(), code, { reason: extra.reason ?? REASON, revision: (await draftOf(db, code))!.revision, effectiveFrom: extra.effectiveFrom });

beforeEach(async () => {
  await resetDb();
  await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING"));
});

describe("1. Product list and statuses", () => {
  it("lists every product, including WakeelBoost and Altphones, with its configuration status", async () => {
    const list = await productSettingsList(db, new Date());
    expect(list.map((p) => p.code)).toEqual(expect.arrayContaining(["WAKEELBOOST", "VENDOR_FINANCING", "ALT_DRIVE", "ALT_POWER", "ALTPHONES"]));
    expect(list.find((p) => p.code === "VENDOR_FINANCING")!.status).toBe("PUBLISHED");
    expect(list.find((p) => p.code === "ALT_DRIVE")!.status).toBe("INCOMPLETE");
    await startDraft(await admin(), "ALT_DRIVE", { kind: "VERSION" });
    expect((await productSettingsList(db, new Date())).find((p) => p.code === "ALT_DRIVE")!.status).toBe("DRAFT");
  });

  it("shows a product discovered in the database with no rules as not set up", async () => {
    await db.query("INSERT INTO products (code, name, workflow, active, sort_order) VALUES ('ALT_HOME', 'AltHome', 'RETAIL', false, 90)");
    const p = (await productSettingsList(db, new Date())).find((x) => x.code === "ALT_HOME")!;
    expect(p).toMatchObject({ status: "NOT_SET_UP", version: null });
  });
});

describe("2. First-time set-up creates version 1", () => {
  it("a product with no prior version is set up, saved and published as version 1", async () => {
    await db.query("INSERT INTO products (code, name, workflow, active, sort_order) VALUES ('ALT_HOME', 'AltHome', 'RETAIL', false, 90)");
    const ctx = await admin();
    await startDraft(ctx, "ALT_HOME", { kind: "BLANK" });
    const d = (await draftOf(db, "ALT_HOME"))!;
    expect(d.base_version).toBeNull();
    const cfg = syntheticConfig("VENDOR_FINANCING");
    await saveDraft(ctx, "ALT_HOME", { config: cfg, general: { ...d.general, active: true, owner: "Head of Retail" }, effectiveFrom: today(), revision: d.revision });
    const r = await publish("ALT_HOME");
    expect(r.version).toBe(1);
    const live = await effectiveConfig(db, "ALT_HOME", new Date());
    expect(live).toMatchObject({ version: 1, status: "APPROVED", published_via: "DIRECT", previous_version: null });
    expect(await getProduct(db, "ALT_HOME")).toMatchObject({ active: true, owner: "Head of Retail" });
  });
});

describe("3. Drafts are saved on the server with a revision check", () => {
  it("increments the revision, keeps the values, and refuses a save from a stale window", async () => {
    const ctx = await admin();
    const r1 = await edit("VENDOR_FINANCING", (c) => (c.profiles.BUSINESS_OWNER.maxTenorMonths = 30));
    expect((await draftOf(db, "VENDOR_FINANCING"))!.config.profiles.BUSINESS_OWNER!.maxTenorMonths).toBe(30);
    const d = (await draftOf(db, "VENDOR_FINANCING"))!;
    await saveDraft(ctx, "VENDOR_FINANCING", { config: d.config, general: d.general, effectiveFrom: null, revision: r1.revision });
    await fails(saveDraft(ctx, "VENDOR_FINANCING", { config: d.config, general: d.general, effectiveFrom: null, revision: r1.revision }), "CONFLICT");
  });

  it("returns field errors for values of the wrong shape and saves nothing", async () => {
    const ctx = await admin();
    await startDraft(ctx, "VENDOR_FINANCING", { kind: "VERSION" });
    const d = (await draftOf(db, "VENDOR_FINANCING"))!;
    const cfg = structuredClone(d.config) as any;
    cfg.profiles.BUSINESS_OWNER.maxAmountKobo = -5;
    cfg.profiles.BUSINESS_OWNER.dsr.maxPercent = "thirty";
    const e = await fails(saveDraft(ctx, "VENDOR_FINANCING", { config: cfg, general: d.general, effectiveFrom: null, revision: d.revision }), "VALIDATION");
    expect(Object.keys(e.fields!)).toEqual(expect.arrayContaining(["profiles.BUSINESS_OWNER.maxAmountKobo", "profiles.BUSINESS_OWNER.dsr.maxPercent"]));
    expect((await draftOf(db, "VENDOR_FINANCING"))!.revision).toBe(d.revision);
  });

  it("one draft per product: a second start is refused unless it replaces the draft; discard removes it", async () => {
    const ctx = await admin();
    await startDraft(ctx, "VENDOR_FINANCING", { kind: "VERSION" });
    await fails(startDraft(ctx, "VENDOR_FINANCING", { kind: "VERSION" }), "CONFLICT");
    await startDraft(ctx, "VENDOR_FINANCING", { kind: "VERSION", replace: true });
    await discardDraft(ctx, "VENDOR_FINANCING");
    expect(await draftOf(db, "VENDOR_FINANCING")).toBeNull();
  });
});

describe("4. Only a Super Admin can change product settings", () => {
  it("refuses other roles, including the former configuration approver", async () => {
    for (const email of ["rm.bola@altbank.ng", "config.approver@altbank.ng", "unit.head@altbank.ng"]) {
      const ctx = await ctxFor(email);
      await fails(startDraft(ctx, "VENDOR_FINANCING", { kind: "VERSION" }), "FORBIDDEN");
    }
    await startDraft(await admin(), "VENDOR_FINANCING", { kind: "VERSION" });
    await fails(publishDraft(await ctxFor("config.approver@altbank.ng"), "VENDOR_FINANCING", { reason: REASON, revision: 1 }), "FORBIDDEN");
    expect((await audits("PRODUCT_RULES_PUBLISH_REFUSED"))[0]).toMatchObject({ outcome: "DENIED" });
  });
});

describe("5. Validation before publication", () => {
  it("blocks an incomplete configuration with errors beside each field", async () => {
    const ctx = await admin();
    await startDraft(ctx, "VENDOR_FINANCING", { kind: "BLANK", replace: true });
    const review = await reviewSavedDraft(ctx, "VENDOR_FINANCING");
    expect(Object.keys(review.errors)).toEqual(expect.arrayContaining(["profiles.BUSINESS_OWNER.maxAmountKobo", "profiles.BUSINESS_OWNER.maxTenorMonths", "profiles.BUSINESS_OWNER.structures", "profiles.BUSINESS_OWNER.dsr.maxPercent", "profiles.BUSINESS_OWNER.documents", "businessReview.headOfUnitStage"]));
    const e = await fails(publish("VENDOR_FINANCING"), "VALIDATION");
    expect(e.fields!["profiles.BUSINESS_OWNER.maxAmountKobo"]).toMatch(/maximum/i);
    expect((await versionsOf(db, "VENDOR_FINANCING")).filter((v) => v.status === "APPROVED")).toHaveLength(2);
  });

  it("requires a reason of at least 20 characters and refuses a past effective date", async () => {
    await edit("VENDOR_FINANCING", (c) => (c.profiles.BUSINESS_OWNER.maxTenorMonths = 30));
    expect((await fails(publish("VENDOR_FINANCING", { reason: "too short" }), "VALIDATION")).fields!.reason).toBeTruthy();
    expect((await fails(publish("VENDOR_FINANCING", { effectiveFrom: plusDays(-3) }), "VALIDATION")).fields!.effectiveFrom).toBeTruthy();
  });

  it("checks amount and tenor ranges, rate method, DSR authority and document dependencies", () => {
    const cfg = syntheticConfig("VENDOR_FINANCING") as any;
    const r = cfg.profiles.BUSINESS_OWNER;
    r.minAmountKobo = r.maxAmountKobo;
    r.minTenorMonths = 60;
    r.maxTenorMonths = 12;
    r.structures[0].rateConvention = null;
    r.dsr.exceptionAllowed = true;
    r.dsr.exceptionApproverRole = null;
    r.statementMonths = null;
    const g: General = { name: "Vendor Financing", description: "", owner: "", originationRoles: null, active: true };
    const { errors } = publishChecks(cfg, g, { ceiling: ["RM", "TEAM_LEAD", "UNIT_HEAD"], knownDocuments: ["BANK_STATEMENT", "KYC", "CAC_CERTIFICATE", "APPLICATION_FORM", "AFS", "SUPPLIER_INVOICE", "CREDIT_REPORT", "BUSINESS_PHOTO", "CONSENT_FORM", "RENT_RECEIPT"] });
    expect(Object.keys(errors)).toEqual(expect.arrayContaining(["profiles.BUSINESS_OWNER.minAmountKobo", "profiles.BUSINESS_OWNER.minTenorMonths", `profiles.BUSINESS_OWNER.structures.${r.structures[0].code}.rateConvention`, "profiles.BUSINESS_OWNER.dsr.exceptionApproverRole", "profiles.BUSINESS_OWNER.statementMonths"]));
    expect(completeness(cfg, g, { ceiling: ["RM"], knownDocuments: [] }).percent).toBeLessThan(100);
  });

  it("refuses an unknown contract type", async () => {
    const ctx = await admin();
    await startDraft(ctx, "VENDOR_FINANCING", { kind: "VERSION" });
    const d = (await draftOf(db, "VENDOR_FINANCING"))!;
    const cfg = structuredClone(d.config) as any;
    cfg.profiles.BUSINESS_OWNER.structures.push({ ...cfg.profiles.BUSINESS_OWNER.structures[0], code: "NOT_A_CONTRACT" });
    await saveDraft(ctx, "VENDOR_FINANCING", { config: cfg, general: d.general, effectiveFrom: today(), revision: d.revision });
    const e = await fails(publish("VENDOR_FINANCING"), "VALIDATION");
    expect(Object.values(e.fields!).join(" ")).toMatch(/NOT_A_CONTRACT is not a known contract type/);
  });
});

describe("6. Direct publication: new immutable version, audited, no second approver", () => {
  it("publishes immediately with the changes, previous version and full audit", async () => {
    await edit("VENDOR_FINANCING", (c) => {
      c.profiles.BUSINESS_OWNER.maxAmountKobo = N(40_000_000);
      c.profiles.BUSINESS_OWNER.minAmountKobo = N(500_000);
    });
    const r = await publish("VENDOR_FINANCING");
    expect(r).toMatchObject({ version: 3, changes: 2 });
    expect(r.auditReference).toMatch(/^PR-VENDOR_FINANCING-v3-/);
    const live = (await effectiveConfig(db, "VENDOR_FINANCING", new Date()))!;
    expect(live).toMatchObject({ version: 3, published_via: "DIRECT", previous_version: 2, decided_by: await staffId(ADMIN) });
    expect(live.config.profiles.BUSINESS_OWNER!.maxAmountKobo).toBe(N(40_000_000));
    const ev = (await audits("PRODUCT_RULES_PUBLISHED"))[0];
    expect(ev).toMatchObject({ actor_role: "SUPER_ADMIN", reason: REASON });
    expect(ev.details.previousConfig.profiles.BUSINESS_OWNER.maxAmountKobo).not.toBe(N(40_000_000));
    expect(ev.details.newConfig.profiles.BUSINESS_OWNER.maxAmountKobo).toBe(N(40_000_000));
    expect(ev.details.changes.map((c: { label: string }) => c.label)).toEqual(expect.arrayContaining(["Business owners: Maximum financing amount", "Business owners: Minimum financing amount"]));
    expect(await draftOf(db, "VENDOR_FINANCING")).toBeNull();
  });

  it("published versions cannot be changed", async () => {
    const live = (await effectiveConfig(db, "VENDOR_FINANCING", new Date()))!;
    await expect(db.query("UPDATE product_configs SET config = '{}' WHERE id = $1", [live.id])).rejects.toThrow();
  });

  it("refuses to publish when nothing changed", async () => {
    await edit("VENDOR_FINANCING", () => {});
    expect((await fails(publish("VENDOR_FINANCING"), "VALIDATION")).message).toMatch(/no changes/);
  });

  it("refuses a draft whose base was overtaken by another publication", async () => {
    await edit("VENDOR_FINANCING", (c) => (c.profiles.BUSINESS_OWNER.maxTenorMonths = 30));
    // Another version is published meanwhile (e.g. from another session through the earlier process).
    await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING", (c) => (c.profiles.BUSINESS_OWNER!.maxTenorMonths = 24)));
    expect((await fails(publish("VENDOR_FINANCING"), "CONFLICT")).message).toMatch(/published after this draft/);
  });
});

describe("7. Effective dates and requests in progress", () => {
  it("a future-dated version applies only from its date; requests keep the version they started under", async () => {
    const before = await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(2_000_000), submit: false });
    const pinned = (await db.query("SELECT product_config_id FROM applications WHERE id = $1", [before])).rows[0].product_config_id;
    await edit("VENDOR_FINANCING", (c) => (c.profiles.BUSINESS_OWNER.maxTenorMonths = 30), plusDays(5));
    const r = await publish("VENDOR_FINANCING");
    expect((await effectiveConfig(db, "VENDOR_FINANCING", new Date()))!.version).toBe(2);
    expect((await effectiveConfig(db, "VENDOR_FINANCING", new Date(Date.now() + 6 * 86_400_000)))!.version).toBe(r.version);
    expect((await db.query("SELECT product_config_id FROM applications WHERE id = $1", [before])).rows[0].product_config_id).toBe(pinned);
    expect((await productSettingsList(db, new Date())).find((p) => p.code === "VENDOR_FINANCING")!.version).toBe(2);
  });
});

describe("8. Earlier proposals: load, dismiss, supersede (nothing auto-approved)", () => {
  it("loads a system proposal into the draft without approving it", async () => {
    const proposal = await systemProposal();
    expect(proposal.proposed_by).toBeNull();
    await startDraft(await admin(), "VENDOR_FINANCING", { kind: "PROPOSAL", ref: proposal.id });
    expect((await draftOf(db, "VENDOR_FINANCING"))!.config).toEqual(proposal.config);
    expect((await versionsOf(db, "VENDOR_FINANCING")).find((v) => v.id === proposal.id)!.status).toBe("PROPOSED");
  });

  it("dismisses a proposal with a reason, keeping it in history", async () => {
    const proposal = await systemProposal();
    await fails(dismissProposal(await admin(), proposal.id, "no"), "VALIDATION");
    await dismissProposal(await admin(), proposal.id, "Superseded by the 2026 retail policy.");
    const v = (await versionsOf(db, "VENDOR_FINANCING")).find((x) => x.id === proposal.id)!;
    expect(v).toMatchObject({ status: "WITHDRAWN" });
    expect(v.decision_note).toMatch(/Dismissed by a Super Admin: Superseded/);
    expect(await audits("PRODUCT_PROPOSAL_DISMISSED")).toHaveLength(1);
  });

  it("publishing supersedes open proposals", async () => {
    await systemProposal();
    await edit("VENDOR_FINANCING", (c) => (c.profiles.BUSINESS_OWNER.maxTenorMonths = 30));
    const r = await publish("VENDOR_FINANCING");
    const old = (await versionsOf(db, "VENDOR_FINANCING")).filter((v) => v.version !== r.version && v.decision_note?.includes("Superseded"));
    expect(old.length).toBeGreaterThan(0);
    expect(old.every((v) => v.status === "WITHDRAWN" && v.decision_note === `Superseded by version ${r.version}, published directly by a Super Admin`)).toBe(true);
    expect((await versionsOf(db, "VENDOR_FINANCING")).some((v) => v.status === "PROPOSED")).toBe(false);
  });
});

describe("9. Version history: compare and restore", () => {
  it("restoring an earlier version publishes it as a new version", async () => {
    await edit("VENDOR_FINANCING", (c) => (c.profiles.BUSINESS_OWNER.maxTenorMonths = 30));
    const v3 = await publish("VENDOR_FINANCING");
    const ctx = await admin();
    await startDraft(ctx, "VENDOR_FINANCING", { kind: "VERSION", ref: "2" });
    const d = (await draftOf(db, "VENDOR_FINANCING"))!;
    await saveDraft(ctx, "VENDOR_FINANCING", { config: d.config, general: d.general, effectiveFrom: today(), revision: d.revision });
    const v4 = await publish("VENDOR_FINANCING", { reason: "Restoring version 2 after the pilot ended early." });
    const live = (await effectiveConfig(db, "VENDOR_FINANCING", new Date()))!;
    expect(live).toMatchObject({ version: v4.version, restored_from: 2, previous_version: v3.version });
    const vs = await versionsOf(db, "VENDOR_FINANCING");
    expect(live.config).toEqual(vs.find((v) => v.version === 2)!.config);
    expect(diffSettings({ config: vs.find((v) => v.version === 3)!.config }, { config: live.config }).map((c) => c.path)).toEqual(["profiles.BUSINESS_OWNER.maxTenorMonths"]);
  });
});

describe("10. Origination roles drive cards, pages and the server", () => {
  it("restricting Vendor Financing to Team Leads hides it from RMs and refuses an RM draft", async () => {
    await edit("VENDOR_FINANCING", (_c, g) => (g.originationRoles = ["TEAM_LEAD"]));
    await publish("VENDOR_FINANCING");
    const settings = await originationSettings(db);
    expect(visibleProducts(["RM"], settings).map((p) => p.code)).not.toContain("VENDOR_FINANCING");
    expect(visibleProducts(["TEAM_LEAD"], settings).map((p) => p.code)).toContain("VENDOR_FINANCING");
    const vf = ORIGINATION_PRODUCTS.find((p) => p.code === "VENDOR_FINANCING")!;
    expect((await availability(db, vf, ["RM"], new Date())).status).toBe("NOT_PERMITTED");
    await fails(createRetailDraft(await ctxFor("rm.bola@altbank.ng"), { initiatorRole: "RM", productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", applicantType: "ENTERPRISE" }), "FORBIDDEN");
    await createRetailDraft(await ctxFor("tl.lagos@altbank.ng"), { initiatorRole: "TEAM_LEAD", productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", applicantType: "ENTERPRISE" });
  });

  it("roles outside the product type can never be added", async () => {
    await edit("VENDOR_FINANCING", (_c, g) => (g.originationRoles = ["RM", "DELIGHT_OFFICER"]));
    expect((await fails(publish("VENDOR_FINANCING"), "VALIDATION")).fields!["general.originationRoles"]).toMatch(/cannot be originated by: DELIGHT_OFFICER/);
  });

  it("closing a product stops new requests", async () => {
    await edit("VENDOR_FINANCING", (_c, g) => (g.active = false));
    await publish("VENDOR_FINANCING");
    await fails(createRetailDraft(await ctxFor("rm.bola@altbank.ng"), { initiatorRole: "RM", productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", applicantType: "ENTERPRISE" }));
  });
});

describe("11. The minimum financing amount is enforced", () => {
  it("a request below the published minimum cannot be submitted", async () => {
    await edit("VENDOR_FINANCING", (c) => (c.profiles.BUSINESS_OWNER.minAmountKobo = N(5_000_000)));
    await publish("VENDOR_FINANCING");
    const a = await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(2_000_000), submit: false });
    const r = await retailReadiness(db, a, new Date());
    expect(JSON.stringify(r)).toMatch(/The minimum for this product is/);
  });
});

describe("12. WakeelBoost keeps its settings logic", () => {
  it("general settings change directly with a reason; origination roles and availability are enforced", async () => {
    const ctx = await admin();
    const g = { name: "WakeelBoost", description: "Working capital for agents", owner: "Head of Agency", originationRoles: ["ANM"], active: true };
    await fails(saveGeneralDirect(ctx, "WAKEELBOOST", g, "short"), "VALIDATION");
    await fails(saveGeneralDirect(await ctxFor("rm.bola@altbank.ng"), "WAKEELBOOST", g, REASON), "FORBIDDEN");
    await saveGeneralDirect(ctx, "WAKEELBOOST", g, REASON);
    expect(await getProduct(db, "WAKEELBOOST")).toMatchObject({ owner: "Head of Agency", origination_roles: ["ANM"] });
    expect(await audits("PRODUCT_GENERAL_SETTINGS_CHANGED")).toHaveLength(1);
    await fails(createDraft(await ctxFor("rm.ade@altbank.ng"), { initiatorRole: "RM", applicantType: "INDIVIDUAL" }), "FORBIDDEN");
    await createDraft(await ctxFor("anm.south@altbank.ng"), { initiatorRole: "ANM", applicantType: "INDIVIDUAL" });
    await fails(saveGeneralDirect(ctx, "WAKEELBOOST", { ...g, originationRoles: ["UNIT_HEAD"] }, REASON), "VALIDATION");
  });

  it("WakeelBoost rules cannot be edited through retail drafts", async () => {
    await fails(startDraft(await admin(), "WAKEELBOOST", { kind: "BLANK" }), "VALIDATION");
  });
});
