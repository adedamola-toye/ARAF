import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { createDraft } from "@/server/domain/workflow";
import { readDocumentForActor } from "@/server/domain/documents";
import { abortUpload, CHUNK_BYTES, completeUpload, purgeExpiredUploads, putChunk, startUpload, uploadStatus } from "@/server/uploads";

/** A valid PDF of the requested size (header + padding + trailer). */
function pdf(bytes: number) {
  const head = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n");
  const tail = Buffer.from("\ntrailer<<>>\n%%EOF\n");
  return Buffer.concat([head, Buffer.alloc(bytes - head.length - tail.length, 0x20), tail]);
}
const parts = (b: Buffer) => Array.from({ length: Math.ceil(b.length / CHUNK_BYTES) }, (_, n) => b.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES));

let appId: string;
beforeEach(async () => {
  await resetDb();
  appId = (await createDraft(await ctxFor("rm.ade@altbank.ng"), { initiatorRole: "RM", applicantType: "INDIVIDUAL" })).id;
});

describe("Large documents in resumable parts", () => {
  it("uploads an 8 MB bank statement in parts and stores it through the normal document rules", async () => {
    const ctx = await ctxFor("rm.ade@altbank.ng");
    const file = pdf(8 * 1024 * 1024);
    const s = await startUpload(ctx, { target: "APPLICATION", targetId: appId, category: "BANK_STATEMENT", filename: "statement.pdf", size: file.length });
    expect(s.chunkCount).toBe(3);
    const p = parts(file);
    // Wrong-size part refused; completing early refused.
    await expect(putChunk(ctx, s.id, 0, p[0].subarray(1))).rejects.toMatchObject({ code: "VALIDATION" });
    await putChunk(ctx, s.id, 0, p[0]);
    await putChunk(ctx, s.id, 2, p[2]);
    await expect(completeUpload(ctx, s.id)).rejects.toMatchObject({ code: "CONFLICT" });
    // Resume: the server reports which parts it already has.
    expect((await uploadStatus(ctx, s.id)).received).toEqual([0, 2]);
    await putChunk(ctx, s.id, 1, p[1]);
    await putChunk(ctx, s.id, 1, p[1]); // a retried part is harmless
    const r = await completeUpload(ctx, s.id);
    expect(r).toMatchObject({ scanStatus: "CLEAN", version: 1 });
    // Completing twice returns the same result (no duplicate document).
    expect(await completeUpload(ctx, s.id)).toEqual(r);
    expect(Number((await db.query("SELECT count(*) FROM documents WHERE application_id = $1 AND category = 'BANK_STATEMENT'", [appId])).rows[0].count)).toBe(1);
    const read = await readDocumentForActor(ctx, String(r.documentId), "download");
    expect(read.data.equals(file)).toBe(true);
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'DOCUMENT_UPLOADED'")).rows[0].n).toBe(1);
  });

  it("refuses before any data is sent when the person may not upload, the type is wrong or the file is too large", async () => {
    await expect(startUpload(await ctxFor("rm.bola@altbank.ng"), { target: "APPLICATION", targetId: appId, category: "BANK_STATEMENT", filename: "s.pdf", size: 5_000_000 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ctx = await ctxFor("rm.ade@altbank.ng");
    await expect(startUpload(ctx, { target: "APPLICATION", targetId: appId, category: "BANK_STATEMENT", filename: "s.exe", size: 5_000_000 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(startUpload(ctx, { target: "APPLICATION", targetId: appId, category: "BANK_STATEMENT", filename: "s.pdf", size: 60 * 1024 * 1024 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(startUpload(ctx, { target: "APPLICATION", targetId: appId, category: "CREDIT_REPORT", filename: "s.pdf", size: 1000 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a file whose content is not what its name says is rejected at completion and its parts removed", async () => {
    const ctx = await ctxFor("rm.ade@altbank.ng");
    const fake = Buffer.alloc(4 * 1024 * 1024, 0x41); // not a PDF
    const s = await startUpload(ctx, { target: "APPLICATION", targetId: appId, category: "BANK_STATEMENT", filename: "fake.pdf", size: fake.length });
    for (const [n, b] of parts(fake).entries()) await putChunk(ctx, s.id, n, b);
    await expect(completeUpload(ctx, s.id)).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await uploadStatus(ctx, s.id)).status).toBe("FAILED");
    expect(Number((await db.query("SELECT count(*) FROM documents WHERE application_id = $1", [appId])).rows[0].count)).toBe(0);
  });

  it("uploads belong to the person who started them; cancelled and expired uploads are cleaned up", async () => {
    const ctx = await ctxFor("rm.ade@altbank.ng");
    const file = pdf(1_000_000);
    const s = await startUpload(ctx, { target: "APPLICATION", targetId: appId, category: "BANK_STATEMENT", filename: "s.pdf", size: file.length });
    await expect(putChunk(await ctxFor("rm.bola@altbank.ng"), s.id, 0, file)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await abortUpload(ctx, s.id);
    await expect(putChunk(ctx, s.id, 0, file)).rejects.toMatchObject({ code: "CONFLICT" });
    const s2 = await startUpload(ctx, { target: "APPLICATION", targetId: appId, category: "BANK_STATEMENT", filename: "s.pdf", size: file.length });
    await putChunk(ctx, s2.id, 0, file);
    expect(await purgeExpiredUploads(new Date(Date.now() + 25 * 3600_000))).toBe(1);
    expect((await uploadStatus(ctx, s2.id)).status).toBe("EXPIRED");
  });
});
