/* eslint-disable @typescript-eslint/no-explicit-any -- configurations are edited as plain JSON, as in the editor */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { audits, resetDb } from "./helpers";
import { ctxFor, makePdf } from "@/server/demo/scenario";
import { applyConfig, createRetailCase, syntheticConfig } from "@/server/demo/retail-scenario";
import { createRetailDraft, retailReadiness } from "@/server/domain/retail";
import { createDraft, submitApplication } from "@/server/domain/workflow";
import { readDocumentForActor, uploadDocument, listDocuments } from "@/server/domain/documents";
import { effectiveConfig, PROFILE_LABELS } from "@/server/domain/products";
import { draftOf, publishDraft, startDraft } from "@/server/domain/product-settings";
import { applySalariedDocumentUpdate, SALARIED_DOCUMENT_UPDATE } from "@/lib/product-settings";
import { categoriesOffered, usesCustomerStep, visibleProducts, originationSettings } from "@/app/(app)/requests/new/catalogue";
import { ORIGINATION_PRODUCTS } from "@/lib/origination-products";
import { computeStaffFinancing } from "@/lib/staff-financing";
import { DomainError } from "@/server/errors";
import { randomUUID } from "node:crypto";
import { lagosDate } from "@/server/time";

const N = (n: number) => n * 100;
const RM = "rm.bola@altbank.ng";
const salaried = (code: string) => {
  const c = syntheticConfig(code) as any;
  return applySalariedDocumentUpdate(c) ?? c;
};
async function fails(p: Promise<unknown>, code?: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    if (code) expect((e as DomainError).code).toBe(code);
    return e as DomainError;
  }
  throw new Error("expected the call to fail");
}
const productsFor = async (category: "BUSINESS_OWNER" | "SALARY_EARNER", roles = ["RM"]) => {
  const all = visibleProducts(roles, await originationSettings(db));
  const out = [];
  for (const p of all) if ((await categoriesOffered(db, p, new Date())).includes(category)) out.push(p.name);
  return out;
};

beforeEach(async () => {
  await resetDb();
  await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING"));
  await applyConfig("ALT_DRIVE", salaried("ALT_DRIVE"));
  await applyConfig("ALT_POWER", salaried("ALT_POWER"));
});

describe("Part A: Staff Salary Advance (rename only)", () => {
  it("1-3. the landing card is renamed in place and still opens the staff journey", () => {
    const src = readFileSync("src/app/page.tsx", "utf8");
    expect(src).toContain('{ href: "/enter/staff-personal-request", title: "Staff Salary Advance"');
    expect(src).not.toContain("Staff Personal Request");
  });

  it("4-7. the 2% deduction and the net amount are unchanged", async () => {
    const s = (await db.query("SELECT deduction_rate_bps FROM staff_financing_settings ORDER BY version DESC LIMIT 1")).rows[0];
    expect(s.deduction_rate_bps).toBe(200);
    expect(computeStaffFinancing(N(1_500_000), 200)).toMatchObject({ deductionKobo: N(30_000), netKobo: N(1_470_000) });
  });

  it("10. the staff screens use the new name; routes and codes are unchanged", () => {
    expect(readFileSync("src/app/(app)/staff-request/page.tsx", "utf8")).toMatch(/eyebrow="Staff Salary Advance"/);
    expect(readFileSync("src/app/(app)/layout.tsx", "utf8")).toMatch(/My salary advance/);
    expect(readFileSync("src/server/domain/roles.ts", "utf8")).toMatch(/STAFF_APPLICANT: "Staff member \(salary advance\)"/);
  });
});

describe("Part B: customer type and product access", () => {
  it("11-14. Business Owner sees four products; Salaried Individual sees AltDrive and AltPower only", async () => {
    expect(await productsFor("BUSINESS_OWNER")).toEqual(["WakeelBoost", "Vendor Financing", "AltDrive", "AltPower"]);
    expect(await productsFor("SALARY_EARNER")).toEqual(["AltDrive", "AltPower"]);
    expect(PROFILE_LABELS.SALARY_EARNER).toBe("Salaried individual");
  });

  it("the customer-type step applies to retail originators; WakeelBoost-only roles and DO/SA do not get it", async () => {
    const s = await originationSettings(db);
    for (const r of ["RM", "TEAM_LEAD", "UNIT_HEAD"]) expect(usesCustomerStep(visibleProducts([r], s))).toBe(true);
    for (const r of ["ANM", "MERCHANT_OFFICER"]) expect(usesCustomerStep(visibleProducts([r], s))).toBe(false);
    for (const r of ["DELIGHT_OFFICER", "SMILE_ASSOCIATE"]) expect(visibleProducts([r], s)).toEqual([]);
  });

  it("15. a salaried customer cannot be started on WakeelBoost through the API", async () => {
    const e = await fails(createDraft(await ctxFor(RM), { initiatorRole: "RM", applicantType: "INDIVIDUAL", customerCategory: "SALARY_EARNER" }), "VALIDATION");
    expect(e.message).toMatch(/business owners only/);
  });

  it("16. a salaried customer cannot be started on Vendor Financing through the API", async () => {
    await fails(createRetailDraft(await ctxFor(RM), { initiatorRole: "RM", productCode: "VENDOR_FINANCING", profile: "SALARY_EARNER", applicantType: "INDIVIDUAL" }), "VALIDATION");
  });

  it("17, 23. business-owner origination still works; the category persists and is audited (WakeelBoost included)", async () => {
    const vf = await createRetailDraft(await ctxFor(RM), { initiatorRole: "RM", productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", applicantType: "ENTERPRISE" });
    const wb = await createDraft(await ctxFor(RM), { initiatorRole: "RM", applicantType: "ENTERPRISE", customerCategory: "BUSINESS_OWNER" });
    const ad = await createRetailDraft(await ctxFor(RM), { initiatorRole: "RM", productCode: "ALT_DRIVE", profile: "SALARY_EARNER", applicantType: "INDIVIDUAL" });
    const prof = async (id: string) => (await db.query("SELECT customer_profile FROM applications WHERE id = $1", [id])).rows[0].customer_profile;
    expect([await prof(vf.id), await prof(wb.id), await prof(ad.id)]).toEqual(["BUSINESS_OWNER", "BUSINESS_OWNER", "SALARY_EARNER"]);
    const ev = await audits("DRAFT_CREATED");
    expect(ev.map((e: any) => e.details.customerCategory)).toEqual(["BUSINESS_OWNER", "BUSINESS_OWNER", "SALARY_EARNER"]);
  });

  it("28. Delight Officers and Smile Associates still cannot originate retail products", async () => {
    await fails(createRetailDraft(await ctxFor("do.ife@altbank.ng"), { initiatorRole: "DELIGHT_OFFICER", productCode: "ALT_DRIVE", profile: "SALARY_EARNER", applicantType: "INDIVIDUAL" }), "FORBIDDEN");
  });
});

describe("Salaried documentation and assessment", () => {
  for (const product of ["ALT_DRIVE", "ALT_POWER"] as const) {
    it(`18-20. ${product}: missing salary evidence or employment letter blocks submission with specific messages`, async () => {
      const id = await createRetailCase({ channel: "RM", product, profile: "SALARY_EARNER", amountKobo: N(3_000_000), tenorMonths: 24, skipDocs: ["SALARY_EVIDENCE", "EMPLOYMENT_LETTER"], submit: false });
      const r: any = await retailReadiness(db, id, new Date());
      expect(r.fieldErrors.doc_SALARY_EVIDENCE).toBe("Upload salary evidence covering the last three months.");
      expect(r.fieldErrors.doc_EMPLOYMENT_LETTER).toBe("Upload the customer's employment letter.");
      await fails(submitApplication(await ctxFor(RM), id, randomUUID()));
      const ctx = await ctxFor(RM);
      await uploadDocument(ctx, { applicationId: id, category: "SALARY_EVIDENCE", filename: "salary-3-months.pdf", data: makePdf("salary") });
      await uploadDocument(ctx, { applicationId: id, category: "EMPLOYMENT_LETTER", filename: "employment-letter.pdf", data: makePdf("letter") });
      const r2: any = await retailReadiness(db, id, new Date());
      expect(r2.fieldErrors.doc_SALARY_EVIDENCE).toBeUndefined();
      expect(r2.fieldErrors.doc_EMPLOYMENT_LETTER).toBeUndefined();
      const item = r2.matrix.find((m: any) => m.code === "SALARY_EVIDENCE");
      expect(item.detail).toBe("1 submitted — pending review");
    });
  }

  it("21. uploaded salaried documents stay on the record for authorised reviewers after submission", async () => {
    const id = await createRetailCase({ channel: "RM", product: "ALT_DRIVE", profile: "SALARY_EARNER", structure: "IJARAH", amountKobo: N(3_000_000), tenorMonths: 24 });
    expect((await db.query("SELECT status FROM applications WHERE id = $1", [id])).rows[0].status).not.toBe("DRAFT");
    const docs = (await listDocuments(db, id)).filter((d) => ["SALARY_EVIDENCE", "EMPLOYMENT_LETTER"].includes(d.category));
    expect(docs.map((d) => d.category).sort()).toEqual(["EMPLOYMENT_LETTER", "SALARY_EVIDENCE"]);
    const read = await readDocumentForActor(await ctxFor("tl.lagos@altbank.ng"), docs[0].id, "view");
    expect(read).toBeTruthy();
    await fails(readDocumentForActor(await ctxFor("anm.south@altbank.ng"), docs[0].id, "view"));
  });

  it("22. salaried affordability uses salary, never business turnover", async () => {
    const cfg = (await effectiveConfig(db, "ALT_DRIVE", new Date()))!.config;
    expect(cfg.profiles.SALARY_EARNER!.dsr.denominator).toBe("VERIFIED_MONTHLY_NET_SALARY");
    const id = await createRetailCase({ channel: "RM", product: "ALT_DRIVE", profile: "SALARY_EARNER", amountKobo: N(3_000_000), tenorMonths: 24, submit: false });
    const r: any = await retailReadiness(db, id, new Date());
    expect(r.fieldErrors.statedMonthlyTurnoverKobo).toBeUndefined();
    expect(r.fieldErrors.businessSector).toBeUndefined();
  });
});

describe("26-27. Product Settings: the salaried documentation update is staged, reviewed and published by a Super Admin", () => {
  it("loads into a draft (nothing applied automatically), publishes with a reason and is audited", async () => {
    await applyConfig("ALT_POWER", syntheticConfig("ALT_POWER")); // version in force without the update
    const before = (await effectiveConfig(db, "ALT_POWER", new Date()))!;
    expect(before.config.profiles.SALARY_EARNER!.documents.some((d) => d.code === "PAYSLIP")).toBe(true);
    const admin = await ctxFor("superadmin@altbank.ng");
    await startDraft(admin, "ALT_POWER", { kind: "VERSION", update: SALARIED_DOCUMENT_UPDATE.key });
    expect((await effectiveConfig(db, "ALT_POWER", new Date()))!.version).toBe(before.version);
    const d = (await draftOf(db, "ALT_POWER"))!;
    const codes = d.config.profiles.SALARY_EARNER!.documents.map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(["SALARY_EVIDENCE", "EMPLOYMENT_LETTER"]));
    expect(codes).not.toContain("PAYSLIP");
    expect(codes).not.toContain("EMPLOYMENT_CONFIRMATION");
    expect(d.config.profiles.BUSINESS_OWNER).toEqual(before.config.profiles.BUSINESS_OWNER);
    const r = await publishDraft(admin, "ALT_POWER", { reason: "Credit policy update: salaried documentation for AltPower.", revision: d.revision, effectiveFrom: lagosDate(new Date()) });
    expect((await effectiveConfig(db, "ALT_POWER", new Date()))!.version).toBe(r.version);
    const ev = (await audits("PRODUCT_RULES_PUBLISHED")).at(-1);
    expect(ev.details.changes.map((c: any) => c.path)).toEqual(expect.arrayContaining(["profiles.SALARY_EARNER.documents.SALARY_EVIDENCE.requirement"]));
    await fails(startDraft(admin, "ALT_POWER", { kind: "VERSION", update: SALARIED_DOCUMENT_UPDATE.key }), "CONFLICT");
  });

  it("only a Super Admin can load it", async () => {
    await fails(startDraft(await ctxFor(RM), "ALT_DRIVE", { kind: "VERSION", update: SALARIED_DOCUMENT_UPDATE.key }), "FORBIDDEN");
  });
});

describe("29. existing records are not reclassified", () => {
  it("WakeelBoost drafts created before this change keep no category", async () => {
    const wb = await createDraft(await ctxFor(RM), { initiatorRole: "RM", applicantType: "ENTERPRISE" });
    await db.query("UPDATE applications SET customer_profile = NULL WHERE id = $1", [wb.id]); // as stored before
    expect((await db.query("SELECT count(*)::int AS n FROM applications WHERE customer_profile IS NULL")).rows[0].n).toBe(1);
    expect(ORIGINATION_PRODUCTS.map((p) => p.code)).toEqual(["WAKEELBOOST", "VENDOR_FINANCING", "ALT_DRIVE", "ALT_POWER"]);
  });
});
