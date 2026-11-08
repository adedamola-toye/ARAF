import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { listDocuments, readDocumentForActor, signDocumentLink, uploadDocument, verifyDocumentLink } from "@/server/domain/documents";
import { renderOffer, validateTemplate, DEV_OFFER_TEMPLATE } from "@/server/domain/offer";
import { devIllustrativeCalculator } from "@/server/domain/apr/dev-illustrative";
import { listCalculators } from "@/server/domain/apr/registry";
import { sniffAllowedType } from "@/server/storage/scanner";
import { act, approveFirstReview, createSubmittedCase, ctxFor, driveToOffer, makePdf, openTaskOf, preparePack } from "@/server/demo/scenario";
import { draftDataSchema } from "@/server/domain/application-data";
import { audits, outbox, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

describe("shared case documents", () => {
  it("every stakeholder on the case can view/download all retained documents; outsiders cannot", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await act(id, "ENDORSE");
    await approveFirstReview(id);
    const docs = await listDocuments(db, id);
    const statement = docs.find((d) => d.category === "BANK_STATEMENT")!;
    const report = docs.find((d) => d.category === "CREDIT_REPORT")!;
    // initiator, endorser (handoff completed) and first reviewer can all read every document
    for (const email of ["rm.ade@altbank.ng", "rbe.lagos@altbank.ng", "co1@altbank.ng"]) {
      const ctx = await ctxFor(email);
      expect((await readDocumentForActor(ctx, report.id, "download")).data.subarray(0, 5).toString()).toBe("%PDF-");
      expect((await readDocumentForActor(ctx, statement.id, "view")).doc.id).toBe(statement.id);
    }
    // An officer never assigned to the case cannot - not even the Super Admin.
    for (const email of ["do1@altbank.ng", "superadmin@altbank.ng", "rbe.abuja@altbank.ng"]) {
      await expect(readDocumentForActor(await ctxFor(email), report.id, "download")).rejects.toThrow(/do not have access/);
    }
    expect((await audits("DOCUMENT_DOWNLOAD")).filter((a) => a.outcome === "DENIED")).toHaveLength(3);
    expect((await audits("DOCUMENT_VIEW")).filter((a) => a.outcome === "SUCCESS").length).toBeGreaterThanOrEqual(3);
  });

  it("replacement preserves prior versions with current/superseded labels", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    await act(id, "RETURN", { reason: "Invoice unreadable" });
    const rm = await ctxFor("rm.ade@altbank.ng");
    const old = (await listDocuments(db, id)).find((d) => d.category === "SUPPLIER_INVOICE")!;
    await uploadDocument(rm, { applicationId: id, category: "SUPPLIER_INVOICE", filename: "invoice-v2.pdf", data: makePdf("v2") });
    const inv = (await listDocuments(db, id)).filter((d) => d.category === "SUPPLIER_INVOICE");
    expect(inv.map((d) => [d.version_no, !!d.superseded_at])).toEqual([[2, false], [1, true]]);
    expect(inv[1].id).toBe(old.id);
    // old version still readable by stakeholders
    expect((await readDocumentForActor(rm, old.id, "download")).doc.version_no).toBe(1);
    // decisions link the reviewed pack (document ids + versions)
    const d = (await db.query("SELECT reviewed_documents FROM decisions WHERE application_id = $1 ORDER BY seq LIMIT 1", [id])).rows[0];
    expect(d.reviewed_documents.find((x: { category: string }) => x.category === "SUPPLIER_INVOICE").version).toBe(1);
  });

  it("validates type by content, quarantines and rejects malware before preview", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    await act(id, "RETURN", { reason: "more docs" });
    const rm = await ctxFor("rm.ade@altbank.ng");
    await expect(uploadDocument(rm, { applicationId: id, category: "SUPPORTING", filename: "x.pdf", data: Buffer.from("MZ\x90\x00 not a pdf") })).rejects.toThrow(/Unsupported or mismatched/);
    await expect(uploadDocument(rm, { applicationId: id, category: "SUPPORTING", filename: "x.exe", data: Buffer.from("MZ") })).rejects.toThrow(/Unsupported/);
    const eicar = Buffer.concat([makePdf("x"), Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")]);
    const r = await uploadDocument(rm, { applicationId: id, category: "SUPPORTING", filename: "bad.pdf", data: eicar });
    expect(r.scanStatus).toBe("REJECTED");
    await expect(readDocumentForActor(rm, r.id, "view")).rejects.toThrow(/quarantined or failed/);
    // A rejected replacement does not supersede the previous good version
    const good = (await listDocuments(db, id)).find((d) => d.category === "CONSENT_FORM")!;
    await uploadDocument(rm, { applicationId: id, category: "CONSENT_FORM", filename: "consent.pdf", data: eicar, replacesDocumentId: good.id });
    const after = (await listDocuments(db, id)).find((d) => d.id === good.id)!;
    expect(after.superseded_at).toBeNull();
  });

  it("uploads are only allowed to the current task holder for stage-appropriate categories", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    await expect(uploadDocument(await ctxFor("rm.ade@altbank.ng"), { applicationId: id, category: "BANK_STATEMENT", filename: "s.pdf", data: makePdf("s") })).rejects.toThrow(/cannot upload/);
    await act(id, "ENDORSE");
    const co1 = await ctxFor((await openTaskOf(id)).email!);
    await expect(uploadDocument(co1, { applicationId: id, category: "INSURANCE_EVIDENCE", filename: "s.pdf", data: makePdf("s") })).rejects.toThrow(/cannot upload/);
    await uploadDocument(co1, { applicationId: id, category: "CREDIT_REPORT", filename: "s.pdf", data: makePdf("s") });
  });

  it("signed access URLs expire and are bound to the user and session", () => {
    const now = new Date("2026-03-01T10:00:00Z");
    const url = new URL(signDocumentLink("doc-1", "staff-1", "sess-1", "view", now), "http://x");
    const exp = url.searchParams.get("exp")!;
    const sig = url.searchParams.get("sig")!;
    expect(verifyDocumentLink("doc-1", "staff-1", "sess-1", "view", exp, sig, now)).toBe(true);
    expect(verifyDocumentLink("doc-1", "staff-2", "sess-1", "view", exp, sig, now)).toBe(false);
    expect(verifyDocumentLink("doc-1", "staff-1", "sess-2", "view", exp, sig, now)).toBe(false);
    expect(verifyDocumentLink("doc-1", "staff-1", "sess-1", "download", exp, sig, now)).toBe(false);
    expect(verifyDocumentLink("doc-1", "staff-1", "sess-1", "view", exp, sig, new Date(now.getTime() + 301_000))).toBe(false);
  });

  it("sniffs allowed types", () => {
    expect(sniffAllowedType("a.pdf", makePdf("x"))).toBe("application/pdf");
    expect(sniffAllowedType("a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffAllowedType("a.png", makePdf("x"))).toBeNull();
  });
});

describe("offer generation per entity type", () => {
  const base = draftDataSchema.parse({
    customerName: "Halima Yusuf",
    businessName: "Halima Provisions",
    companyName: "Kano Fresh Foods Ltd",
    registrationNumber: "RC1",
    tenorMonths: 6,
    items: [{ description: "Rice <50kg>", quantity: 2, unitCostKobo: 5_000_000 }],
  });
  const common = { markupKobo: 1_250_000, markupRate: "12.5", costPlusMarkupKobo: 11_250_000, assetCostKobo: 10_000_000, ref: "WB-1", offerDate: "01 Mar 2026" };

  it("Individual uses the person's name and BVN", () => {
    const html = renderOffer(DEV_OFFER_TEMPLATE, { ...common, applicantType: "INDIVIDUAL", data: base, bvn: "22212345678", tin: null, directors: [] });
    expect(html).toContain("<strong>Halima Yusuf</strong>");
    expect(html).toContain("BVN: 22212345678");
    expect(html).not.toContain("TIN:");
    expect(html).toContain("₦100,000.00"); // asset cost
    expect(html).toContain("₦12,500.00"); // markup
    expect(html).toContain("₦112,500.00"); // cost plus markup
    expect(html).toContain("Rice &lt;50kg&gt;"); // escaped
    expect(html).not.toContain("Director:");
    expect(html).not.toMatch(/\{\{/);
  });
  it("Enterprise uses 'Individual Name trading as Business Name' with BVN and TIN", () => {
    const html = renderOffer(DEV_OFFER_TEMPLATE, { ...common, applicantType: "ENTERPRISE", data: base, bvn: "22212345678", tin: "12345678-0001", directors: [] });
    expect(html).toContain("Halima Yusuf trading as Halima Provisions");
    expect(html).toContain("TIN: 12345678-0001");
  });
  it("Limited uses the company name and repeats the director/BVN section", () => {
    const dirs = [1, 2, 3, 4].map((i) => ({ fullName: `Director ${i}`, bvn: `2220000000${i}` }));
    const html = renderOffer(DEV_OFFER_TEMPLATE, { ...common, applicantType: "LIMITED", data: base, bvn: null, tin: "99999999", directors: dirs });
    expect(html).toContain("<strong>Kano Fresh Foods Ltd</strong>");
    expect(html.match(/class="director"/g)).toHaveLength(4);
    expect(html).toContain("Director 4 &mdash; BVN: 22200000004");
    expect(html).not.toContain("BVN: <br>");
  });
  it("template validation requires every placeholder and the director section", () => {
    expect(validateTemplate(DEV_OFFER_TEMPLATE)).toEqual([]);
    expect(validateTemplate("<p>{{customer_name}}</p>").length).toBeGreaterThan(3);
    expect(validateTemplate(DEV_OFFER_TEMPLATE + "<script>alert(1)</script>")).toContain("Templates must not contain scripts.");
  });
  it("generated offers record the template version and are frozen document versions", async () => {
    const id = await createSubmittedCase({ initiator: "ANM_NORTH", type: "LIMITED", amountKobo: NAIRA(1_000_000) });
    await driveToOffer(id);
    await preparePack(id);
    const offer = (await listDocuments(db, id)).find((d) => d.category === "GENERATED_OFFER")!;
    expect(offer.generated).toBe(true);
    expect(offer.template_version).toBe(1);
    const { data } = await readDocumentForActor(await ctxFor("anm.north@altbank.ng"), offer.id, "download");
    const html = data.toString();
    expect(html).toContain("Kano Fresh Foods Ltd");
    expect(html.match(/class="director"/g)).toHaveLength(3);
  });
  it("production refuses an offer template that is not bank-approved", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    await driveToOffer(id);
    const { generateOffer } = await import("@/server/domain/offer");
    process.env.APP_ENV = "production";
    try {
      await expect(generateOffer(await ctxFor("rm.ade@altbank.ng"), id)).rejects.toThrow(/not approved for production/);
    } finally {
      process.env.APP_ENV = "test";
    }
  });
});

describe("APR / DSR calculator", () => {
  const dir = path.join(__dirname, "fixtures/apr");
  const fixtures = readdirSync(dir).filter((f) => f.endsWith(".json"));
  it("has fixtures for every registered calculator", () => {
    for (const c of listCalculators()) {
      expect(fixtures.some((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")).calculator === `${c.id}@${c.version}`)).toBe(true);
    }
  });
  for (const f of fixtures) {
    const fx = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    for (const c of fx.cases) {
      it(`${fx.calculator} fixture: ${c.name}`, () => {
        const calc = listCalculators().find((x) => `${x.id}@${x.version}` === fx.calculator)!;
        const r = calc.calculate(c.inputs);
        expect(r.aprPercent).toBe(c.expected.aprPercent);
        expect(r.dsrPercent).toBe(c.expected.dsrPercent);
        expect(r.markupKobo).toBe(c.expected.markupKobo);
        expect(r.costPlusMarkupKobo).toBe(c.expected.costPlusMarkupKobo);
      });
    }
  }
  it("the development calculator is not production validated", () => {
    expect(devIllustrativeCalculator.productionValidated).toBe(false);
  });
  it("APR/DSR propagate to every subsequent review-assignment email; pending before assessment; no BVN in emails", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await act(id, "ENDORSE");
    let mails = (await outbox("ASSIGNMENT")).filter((m) => m.application_id === id);
    expect(mails.at(-1).body_text).toContain("APR: assessment pending");
    await approveFirstReview(id);
    const a = (await db.query("SELECT apr_percent, dsr_percent FROM credit_assessments WHERE application_id = $1", [id])).rows[0];
    await act(id, "APPROVE");
    mails = (await outbox("ASSIGNMENT")).filter((m) => m.application_id === id);
    const later = mails.slice(-2); // second review + unit head
    for (const m of later) {
      expect(m.body_text).toContain(`APR: ${a.apr_percent}%`);
      expect(m.body_text).toContain(`DSR: ${a.dsr_percent}%`);
      expect(m.body_text).toContain("Halima Yusuf");
      expect(m.body_text).toMatch(/\/requests\/[0-9a-f-]+\?task=/);
    }
    const all = (await db.query("SELECT body_text, subject FROM notification_outbox")).rows;
    for (const m of all) expect(m.body_text + m.subject).not.toContain("22212345678");
  });
});
