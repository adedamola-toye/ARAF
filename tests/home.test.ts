import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { createSubmittedCase, ctxFor } from "@/server/demo/scenario";
import { createDraft } from "@/server/domain/workflow";
import { deleteDraft, initiatorFigures, myDrafts, periodStart } from "@/server/domain/home";
import { fromLagos } from "@/server/time";

beforeEach(resetDb);

describe("Personal home figures and drafts", () => {
  it("counts submitted applications as initiated and never counts drafts", async () => {
    const rm = (await db.query("SELECT id FROM staff WHERE email = 'rm.ade@altbank.ng'")).rows[0].id;
    await createDraft(await ctxFor("rm.ade@altbank.ng"), { initiatorRole: "RM", applicantType: "INDIVIDUAL" });
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: 250_000_000 });
    const sub = (await db.query("SELECT submitted_at, requested_amount_kobo FROM applications WHERE id = $1", [id])).rows[0];
    const f = await initiatorFigures(db, rm, "year", new Date(new Date(sub.submitted_at).getTime() + 60_000));
    expect(f.initiated).toEqual({ kobo: String(sub.requested_amount_kobo), count: 1 });
    expect(f.approved.count).toBe(0);
    expect(f.disbursed.count).toBe(0);
  });

  it("only the person who started a draft can delete it, only while unsubmitted, and other applications are untouched", async () => {
    const ctx = await ctxFor("rm.ade@altbank.ng");
    const a = await createDraft(ctx, { initiatorRole: "RM", applicantType: "INDIVIDUAL" });
    const b = await createDraft(ctx, { initiatorRole: "RM", applicantType: "INDIVIDUAL" });
    const submitted = await createSubmittedCase({ initiator: "RM", amountKobo: 100_000_000 });
    await expect(deleteDraft(await ctxFor("rm.bola@altbank.ng"), a.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(deleteDraft(ctx, submitted)).rejects.toMatchObject({ code: "CONFLICT" });
    await deleteDraft(ctx, a.id);
    const rm = (await db.query("SELECT id FROM staff WHERE email = 'rm.ade@altbank.ng'")).rows[0].id;
    expect((await myDrafts(db, rm)).map((d) => d.id)).toEqual([b.id]);
    expect((await db.query("SELECT stage FROM applications WHERE id = $1", [a.id])).rows[0].stage).toBe("WITHDRAWN");
    expect((await db.query("SELECT stage FROM applications WHERE id = $1", [submitted])).rows[0].stage).not.toBe("WITHDRAWN");
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'DRAFT_DELETED' AND application_id = $1", [a.id])).rows[0].n).toBe(1);
  });

  it("uses Lagos calendar boundaries for the periods", () => {
    const now = fromLagos(2026, 11, 26, 10, 30); // Thursday
    expect(periodStart("today", now).getTime()).toBe(fromLagos(2026, 11, 26).getTime());
    expect(periodStart("week", now).getTime()).toBe(fromLagos(2026, 11, 23).getTime()); // Monday
    expect(periodStart("month", now).getTime()).toBe(fromLagos(2026, 11, 1).getTime());
    expect(periodStart("year", now).getTime()).toBe(fromLagos(2026, 1, 1).getTime());
  });
});
