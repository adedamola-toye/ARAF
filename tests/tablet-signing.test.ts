import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { db } from "@/server/db";
import { audits, resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { applyConfig, approveRetailTemplates, createRetailCase, driveBusinessReview, driveCredit, syntheticConfig } from "@/server/demo/retail-scenario";
import { generateClosingDocuments } from "@/server/domain/closing-docs";
import { htmlToBlocks, signDocumentOnDevice } from "@/server/domain/signing";
import { objectStore } from "@/server/storage";
import { checklistStatus } from "@/server/domain/closing-checklist";

const N = (n: number) => n * 100;
const RM = "rm.bola@altbank.ng";
const SIG = `data:image/png;base64,${readFileSync("templates/closing/nibss.png").toString("base64")}`;

beforeEach(async () => {
  await resetDb();
  await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING"));
});

async function atOffer() {
  const id = await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(10_000_000), tenorMonths: 12, incomeBasisKobo: N(10_000_000), proposedMonthlyKobo: N(1_000_000) });
  await approveRetailTemplates();
  await driveBusinessReview(id);
  await driveCredit(id);
  await generateClosingDocuments(id);
  const offer = (await db.query("SELECT id FROM documents WHERE application_id = $1 AND category = 'GENERATED_OFFER' AND superseded_at IS NULL", [id])).rows[0];
  return { id, offerId: offer.id as string };
}
const base = (id: string, offerId: string) => ({ applicationId: id, sourceDocumentId: offerId, signatories: [{ name: "Amina Bello", role: "Customer", signaturePng: SIG }], consent: true, idType: "International passport", idLast4: "A123", idVerified: true });

describe("Signing on the RM's tablet", () => {
  it("produces a signed PDF with a signature record page, satisfies the signed-offer item and is audited", async () => {
    const { id, offerId } = await atOffer();
    const r = await signDocumentOnDevice(await ctxFor(RM), { ...base(id, offerId), signatories: [{ name: "Amina Bello", role: "Customer", signaturePng: SIG }, { name: "Musa Bello", role: "Guarantor", signaturePng: SIG }] }, "Mozilla/5.0 (iPad)");
    expect(r.category).toBe("SIGNED_OFFER");
    const doc = (await db.query("SELECT * FROM documents WHERE id = $1", [r.documentId])).rows[0];
    expect(doc.mime_type).toBe("application/pdf");
    expect(doc.meta.signedOnDevice).toBe("true");
    expect(doc.meta.signatories).toBe("Customer: Amina Bello; Guarantor: Musa Bello");
    const pdf = await PDFDocument.load(await objectStore().get(doc.storage_key));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    expect((await checklistStatus(db, (await db.query("SELECT * FROM applications WHERE id = $1", [id])).rows[0])).find((i) => i.code === "SIGNED_OFFER")?.onFile).toBe(true);
    const a = (await audits("DOCUMENT_SIGNED_ON_DEVICE"))[0];
    expect(a.details.idCheck).toMatchObject({ type: "International passport", last4: "A123" });
    expect(a.details.signatories).toHaveLength(2);
  });

  it("needs consent, an identity check and a real signature; only the officer preparing the pack can take signatures", async () => {
    const { id, offerId } = await atOffer();
    const rm = await ctxFor(RM);
    await expect(signDocumentOnDevice(rm, { ...base(id, offerId), consent: false }, null)).rejects.toThrow(/agrees to sign/);
    await expect(signDocumentOnDevice(rm, { ...base(id, offerId), idVerified: false }, null)).rejects.toThrow(/identity/);
    await expect(signDocumentOnDevice(rm, { ...base(id, offerId), signatories: [{ name: "Amina Bello", role: "Customer", signaturePng: "data:image/png;base64,iVBORw0KGgo=" }] }, null)).rejects.toThrow(/empty/);
    await expect(signDocumentOnDevice(await ctxFor("tl.lagos@altbank.ng"), base(id, offerId), null)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("renders the HTML letter as readable text", () => {
    const b = htmlToBlocks("<body><h1>Offer of Alt Drive facility</h1><p>Dear <strong>Amina</strong>,</p><table><tr><th>Principal</th><td>N1,000</td></tr></table></body>");
    expect(b).toEqual([{ text: "Offer of Alt Drive facility", heading: true }, { text: "Dear Amina,", heading: false }, { text: "Principal: N1,000", heading: false }]);
  });
});
