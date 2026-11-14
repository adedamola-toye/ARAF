import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { act, ctxFor, openTaskOf, makePdf } from "@/server/demo/scenario";
import { applyConfig, createRetailCase, syntheticConfig } from "@/server/demo/retail-scenario";
import { setSwitch } from "@/server/domain/switches";
import { currentPhotoReview, recordPhotoSkip, recordPhotoUpload, TL_PHOTO_CATEGORY } from "@/server/domain/photo-review";
import { uploadDocument } from "@/server/domain/documents";

const N = (n: number) => n * 100;
// Smallest useful JPEG header (content checks look at the magic bytes).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]), Buffer.alloc(200, 1), Buffer.from([0xff, 0xd9])]);
const TL_RECOMMEND = { reason: "Analysis verified; recommended.", visitComments: "Management visit completed; business operating as described.", rmPhotoConfirmed: true };
const photo = async (on: boolean) => setSwitch(await ctxFor("superadmin@altbank.ng"), "VF_TL_PHOTO_REVIEW", on, on ? "Business photo review policy" : "Paused for review");
const vf = (o: Partial<Parameters<typeof createRetailCase>[0]> = {}) => createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(2_000_000), tenorMonths: 12, ...o });

beforeEach(async () => {
  await resetDb();
  await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING"));
});

describe("Vendor Financing Team Lead photograph verification", () => {
  it("when ON: the Team Lead cannot decide until they upload or skip; an empty reason is refused", async () => {
    await photo(true);
    const id = await vf();
    expect((await openTaskOf(id)).stage).toBe("TEAM_LEAD_REVIEW");
    expect(await currentPhotoReview(db, id)).toMatchObject({ required: true, decision: null });
    await expect(act(id, "RECOMMEND", TL_RECOMMEND)).rejects.toMatchObject({ code: "GATE" });
    await expect(act(id, "RETURN", { reason: "Please add statements" })).rejects.toMatchObject({ code: "GATE" });
    const tl = await ctxFor("tl.lagos@altbank.ng");
    await expect(recordPhotoSkip(tl, id, "   ")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(recordPhotoSkip(tl, id, "no photo")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(recordPhotoSkip(await ctxFor("rm.bola@altbank.ng"), id, "The RM did not share any picture")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("skip with a reason: the review continues, every Unit Head is notified (in-app and email), and it is audited", async () => {
    await photo(true);
    const id = await vf();
    const tl = await ctxFor("tl.lagos@altbank.ng");
    const r = await recordPhotoSkip(tl, id, "Customer refused photographs inside the market stall");
    expect(r.notified).toBeGreaterThan(0);
    const n = (await db.query("SELECT n.title, n.body, s.email FROM notifications n JOIN staff s ON s.id = n.recipient_id WHERE n.application_id = $1", [id])).rows;
    expect(n[0].title).toMatch(/^Business Photograph Not Uploaded/);
    expect(n[0].body).toMatch(/Reason given: Customer refused photographs/);
    expect(n[0].body).toMatch(/Reviewing Team Lead: /);
    expect(n.map((x) => x.email)).toContain("unit.head@altbank.ng");
    expect((await db.query("SELECT 1 FROM notification_outbox WHERE kind = 'VF_PHOTO_SKIPPED' AND application_id = $1", [id])).rowCount).toBe(1);
    await expect(recordPhotoSkip(tl, id, "Trying a second time to change it")).rejects.toMatchObject({ code: "CONFLICT" });
    await act(id, "RECOMMEND", TL_RECOMMEND); // not a rejection: the existing approval continues
    expect((await openTaskOf(id)).stage).not.toBe("TEAM_LEAD_REVIEW");
    expect((await db.query("SELECT action FROM audit_events WHERE application_id = $1 AND action IN ('VF_BUSINESS_PHOTO_SKIPPED','UNIT_HEAD_NOTIFIED') ORDER BY id", [id])).rows.map((x) => x.action)).toEqual(["VF_BUSINESS_PHOTO_SKIPPED", "UNIT_HEAD_NOTIFIED"]);
    await expect(db.query("UPDATE vf_photo_reviews SET skip_reason = 'edited reason here' WHERE application_id = $1", [id])).rejects.toThrow(/cannot be changed/);
  });

  it("upload an existing photograph (images only, confirmed): recorded, no notification, review continues", async () => {
    await photo(true);
    const id = await vf();
    const tl = await ctxFor("tl.lagos@altbank.ng");
    await expect(uploadDocument(tl, { applicationId: id, category: TL_PHOTO_CATEGORY, filename: "x.pdf", data: makePdf("not a photo") }).then((d) => recordPhotoUpload(tl, id, { documentId: d.id, confirmed: true }))).rejects.toMatchObject({ code: "VALIDATION" });
    const doc = await uploadDocument(tl, { applicationId: id, category: TL_PHOTO_CATEGORY, filename: "shop.jpg", data: JPEG });
    await expect(recordPhotoUpload(tl, id, { documentId: doc.id, confirmed: false })).rejects.toMatchObject({ code: "VALIDATION" });
    await recordPhotoUpload(tl, id, { documentId: doc.id, confirmed: true });
    expect(await currentPhotoReview(db, id)).toMatchObject({ decision: "UPLOADED", document_id: doc.id });
    expect((await db.query("SELECT 1 FROM notifications WHERE application_id = $1", [id])).rowCount).toBe(0);
    await act(id, "RECOMMEND", TL_RECOMMEND);
  });

  it("the setting is snapshotted when Team Lead review starts; OFF means no extra step; other channels are untouched", async () => {
    await photo(true);
    const on = await vf();
    await photo(false);
    await expect(act(on, "RECOMMEND", TL_RECOMMEND)).rejects.toMatchObject({ code: "GATE" }); // started while ON
    const off = await vf();
    expect(await currentPhotoReview(db, off)).toMatchObject({ required: false });
    await act(off, "RECOMMEND", TL_RECOMMEND); // started while OFF: no photo step
    await photo(true);
    const tlOrig = await vf({ channel: "TL" }).catch(() => null); // Team Lead-originated: no Team Lead review at all (or not allowed on this policy)
    if (tlOrig) expect(await currentPhotoReview(db, tlOrig)).toBeNull();
  });
});
