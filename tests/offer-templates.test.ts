import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { nairaInWords } from "@/server/words";
import { listDocuments, readDocumentForActor } from "@/server/domain/documents";
import { renderDocx, validateDocxTemplate, docxToPdf } from "@/server/domain/offer-docx";
import { activateTemplate, approveTemplate, createDocxTemplateVersion } from "@/server/domain/admin";
import { act, createSubmittedCase, ctxFor, driveToOffer, openTaskOf, preparePack } from "@/server/demo/scenario";
import { generateOffer } from "@/server/domain/offer";
import { audits, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function text(buf: Buffer) {
  const z = await JSZip.loadAsync(buf);
  const xml = await z.file("word/document.xml")!.async("string");
  return xml.replace(/<w:tab\/>/g, "\t").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
}
async function offerFor(initiator: "RM" | "ANM_NORTH" | "MERCHANT_OFFICER", type: "INDIVIDUAL" | "ENTERPRISE" | "LIMITED", amount: number) {
  const id = await createSubmittedCase({ initiator, type, amountKobo: amount });
  await driveToOffer(id);
  const t = await openTaskOf(id);
  const r = await generateOffer(await ctxFor(t.email!), id);
  const doc = (await listDocuments(db, id)).find((d) => d.id === r.documentId)!;
  const { data } = await readDocumentForActor(await ctxFor(t.email!), doc.id, "download");
  return { id, doc, body: await text(data), zip: await JSZip.loadAsync(data) };
}

describe("amounts in words", () => {
  it.each([
    [40_000_000, "Four Hundred Thousand Naira Only"],
    [2_000_000_000, "Twenty Million Naira Only"],
    [495_000_050, "Four Million, Nine Hundred and Fifty Thousand Naira and Fifty Kobo Only"],
    [2_000_005_000, "Twenty Million and Fifty Naira Only"],
    [5_000_000_000, "Fifty Million Naira Only"],
  ])("%i kobo", (k, w) => expect(nairaInWords(k)).toBe(w));
});

describe("bank DOCX offer letters per applicant type", () => {
  it("Individual: person's name, BVN, cost/selling price in words, mark-up for the tenor, APR, items, signatories", async () => {
    const { body, doc, zip } = await offerFor("RM", "INDIVIDUAL", NAIRA(400_000));
    expect(doc.template_version).toBe(1);
    expect(body).toContain("Halima Yusuf");
    expect(body).toContain("22212345678");
    expect(body).toContain("N400,000.00 (Four Hundred Thousand Naira Only)");
    expect(body).toMatch(/Mark Up rate \(b\):\s*\(15%\)/); // 6 months → 15% flat band
    expect(body).toContain("N460,000.00 (Four Hundred and Sixty Thousand Naira Only)");
    expect(body).toMatch(/Annual Percentage Rate:\s*\(51\.86%\)/);
    expect(body).toContain("To finance 10 Bags of rice (50kg) and 10 Cartons of noodles");
    expect(body).toMatch(/Equal monthly payment of N76,666\.67/);
    expect(body).toContain("Tunde Adeyemi");
    expect(body).toContain("Head, Payment & Collection");
    expect(body).not.toMatch(/\{\{|JOSEPH|AYOOLA/);
    expect(Object.keys(zip.files).some((f) => /media\/image5/.test(f))).toBe(false); // no signature image
    expect(body).toContain("Wakeel POS terminal"); // bank clauses kept
  });

  it("Enterprise: 'Name trading under the Name and Style of Business', BVN and TIN", async () => {
    const { body } = await offerFor("MERCHANT_OFFICER", "ENTERPRISE", NAIRA(20_000_000));
    expect(body).toContain("Halima Yusuf (trading under the Name and Style of Halima Provisions)");
    expect(body).toContain("22212345678");
    expect(body).toContain("12345678-0001");
    expect(body).toContain("N20,000,000.00 (Twenty Million Naira Only)");
    expect(body).toContain("Kemi Ajayi"); // MO Lead endorsed
    expect(body).not.toMatch(/\{\{|MUHAMMAD|DANTURAWA|EMILOKAN/);
  });

  it("Limited: company name, TIN, every director with BVN (repeating), RM and RBE signatories", async () => {
    const { body } = await offerFor("RM", "LIMITED", NAIRA(30_000_000));
    expect(body).toMatch(/Customer:\s*Kano Fresh Foods Ltd/);
    expect(body).toContain("12345678-0001");
    expect(body).toMatch(/1\. Director One BVN: 22200000001\n2\. Director Two BVN: 22200000002\n3\. Director Three BVN: 22200000003/);
    expect(body).toContain("on behalf of Kano Fresh Foods Ltd");
    expect(body).toContain("Ade Okafor");
    expect(body).toContain("Relationship Manager");
    expect(body).toContain("Regional Business Executive");
    expect(body).toMatch(/Stamp Duty:\s*0\.125% of the facility amount/);
    expect(body).not.toMatch(/\{\{|Insert Name|xxxx/);
  });

  it("a single-director company drops the repeated director line", async () => {
    const tpl = readFileSync("templates/offers/murabaha-limited.docx");
    const out = await text(await renderDocx(tpl, Object.fromEntries([...(await text(tpl)).matchAll(/\{\{([a-z0-9_]+)\}\}/g)].map((m) => [m[1], "X"])), { directors_rest: [] }));
    expect(out).not.toMatch(/\{\{/);
    expect(out).toContain("1. X BVN: X");
    expect(out).not.toMatch(/2\. X BVN/);
  });
});

describe("template administration", () => {
  it("validates uploaded DOCX templates", async () => {
    const tpl = readFileSync("templates/offers/murabaha-individual.docx");
    expect(await validateDocxTemplate(tpl, "INDIVIDUAL")).toEqual([]);
    expect((await validateDocxTemplate(tpl, "LIMITED")).join(" ")).toMatch(/Missing placeholder \{\{company_name\}\}/);
    expect(await validateDocxTemplate(Buffer.from("not a zip"), "INDIVIDUAL")).toEqual(["The file is not a valid .docx document."]);
    // A placeholder split across Word runs is rejected
    const z = await JSZip.loadAsync(tpl);
    const xml = (await z.file("word/document.xml")!.async("string")).replace("{{bvn}}", "{{b</w:t></w:r><w:r><w:t>vn}}");
    z.file("word/document.xml", xml);
    const broken = await z.generateAsync({ type: "nodebuffer" });
    expect((await validateDocxTemplate(broken, "INDIVIDUAL")).join(" ")).toMatch(/split by Word formatting/);
  });

  it("upload, approve and activate per applicant type; production needs an approved template", async () => {
    const sa = await ctxFor("superadmin@altbank.ng");
    const id = await createDocxTemplateVersion(sa, { name: "Murabaha Individual Offer", applicantType: "INDIVIDUAL", filename: "x.docx", data: readFileSync("templates/offers/murabaha-individual.docx"), productionApproved: false });
    await activateTemplate(sa, id);
    const active = (await db.query("SELECT applicant_type, version FROM offer_templates WHERE status = 'ACTIVE' ORDER BY applicant_type")).rows;
    expect(active).toEqual([{ applicant_type: "ENTERPRISE", version: 1 }, { applicant_type: "INDIVIDUAL", version: 2 }, { applicant_type: "LIMITED", version: 1 }]);
    const caseId = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    await driveToOffer(caseId);
    process.env.APP_ENV = "production";
    try {
      await expect(generateOffer(await ctxFor("rm.ade@altbank.ng"), caseId)).rejects.toThrow(/not approved for production/);
    } finally {
      process.env.APP_ENV = "test";
    }
    await approveTemplate(sa, id);
    expect((await audits("TEMPLATE_APPROVED")).length).toBe(1);
    const r = await generateOffer(await ctxFor("rm.ade@altbank.ng"), caseId);
    expect(r.templateVersion).toBe(2);
    expect(r.format).toBe("DOCX");
  });

  it("produces a PDF copy for preview when LibreOffice is available", async () => {
    const pdf = await (async () => {
      const prev = process.env.OFFER_PDF_CONVERTER;
      process.env.OFFER_PDF_CONVERTER = "soffice";
      try {
        return await docxToPdf(readFileSync("templates/offers/murabaha-enterprise.docx"));
      } finally {
        process.env.OFFER_PDF_CONVERTER = prev;
      }
    })();
    if (pdf) expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  }, 120_000);
});

describe("offer pack gate", () => {
  it("still requires the generated offer plus the signed pack", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    await driveToOffer(id);
    await expect(act(id, "SUBMIT_PACK")).rejects.toThrow(/generated offer/);
    await preparePack(id);
    await act(id, "SUBMIT_PACK");
  });
});
