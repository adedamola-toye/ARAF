import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor, openTaskOf, withVerification } from "@/server/demo/scenario";
import { applyConfig, createRetailCase, recordFinal, syntheticConfig } from "@/server/demo/retail-scenario";
import { performTaskAction, type TaskActionInput } from "@/server/domain/workflow";
import { CHECKLISTS, checklistFor } from "@/lib/approval-checklists";

const N = (n: number) => n * 100;
const TL = { reason: "Analysis verified; certified for credit.", visitComments: "Management visit completed; business operating as described.", rmPhotoConfirmed: true };
const vf = () => createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(2_000_000), tenorMonths: 12, incomeBasisKobo: N(10_000_000), proposedMonthlyKobo: N(200_000) });
const rows = async (id: string) => (await db.query("SELECT * FROM approval_verifications WHERE subject_id = $1 ORDER BY acknowledged_at", [id])).rows;
async function tlInput(id: string, extra: Partial<TaskActionInput> = {}) {
  const t = await openTaskOf(id);
  return { ctx: await ctxFor(t.email!), input: { taskId: t.id, action: "RECOMMEND" as const, idempotencyKey: randomUUID(), ...TL, ...extra } };
}

beforeEach(async () => {
  await resetDb();
  await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING", (c) => (c.approvalPolicy = "RETAIL_CX_V1")));
  const id = (await db.query("INSERT INTO staff (email, full_name, region, business_unit, status) VALUES ('cx.v@altbank.ng','Ada CX','LAGOS','Credit','ACTIVE') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO role_assignments (staff_id, role, active) VALUES ($1,'CX_CREDIT_REVIEWER',true)", [id]);
});

describe("approval verification", () => {
  it("is required for Team Lead certification: missing, incomplete or outdated acknowledgements are refused", async () => {
    const id = await vf();
    const { ctx, input } = await tlInput(id);
    const lock = (await db.query("SELECT lock_version FROM applications WHERE id = $1", [id])).rows[0].lock_version;
    const list = CHECKLISTS.TL_CERTIFICATION;
    await expect(performTaskAction(ctx, { ...input, verification: null })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(performTaskAction(ctx, { ...input, idempotencyKey: randomUUID(), verification: { checklistId: list.id, version: list.version, items: list.items.slice(1).map((i) => i.code), viewedVersion: lock } })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(performTaskAction(ctx, { ...input, idempotencyKey: randomUUID(), verification: { checklistId: list.id, version: list.version + 1, items: list.items.map((i) => i.code), viewedVersion: lock } })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(performTaskAction(ctx, { ...input, idempotencyKey: randomUUID(), verification: { checklistId: list.id, version: list.version, items: list.items.map((i) => i.code), viewedVersion: lock - 1 } })).rejects.toMatchObject({ code: "CONFLICT" }); // stale version
    await expect(performTaskAction(ctx, { ...input, idempotencyKey: randomUUID(), verification: { checklistId: CHECKLISTS.DH_FINAL.id, version: 1, items: CHECKLISTS.DH_FINAL.items.map((i) => i.code), viewedVersion: lock } })).rejects.toMatchObject({ code: "CONFLICT" }); // the DH checklist is not the TL's
    expect(await rows(id)).toHaveLength(0);
    expect((await openTaskOf(id)).stage).toBe("TEAM_LEAD_REVIEW"); // nothing happened
  });

  it("records the acknowledgement atomically with the decision; duplicates and edits are impossible", async () => {
    const id = await vf();
    const { ctx, input } = await tlInput(id);
    const full = await withVerification(input);
    await performTaskAction(ctx, full);
    await performTaskAction(ctx, full); // the same submission again (double click): returns the first result
    const r = await rows(id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ subject_kind: "APPLICATION", role: "TEAM_LEAD", stage: "TEAM_LEAD_REVIEW", decision: "RECOMMEND", checklist_id: "TL_CERTIFICATION", checklist_version: 1, outcome: "FIRST_CREDIT_REVIEW" });
    expect(r[0].items.map((i: { code: string }) => i.code)).toEqual(CHECKLISTS.TL_CERTIFICATION.items.map((i) => i.code));
    expect(r[0].version_id).toBeTruthy();
    expect((await db.query("SELECT details FROM audit_events WHERE action = 'APPROVAL_VERIFIED' AND application_id = $1", [id])).rows[0].details).toMatchObject({ checklist: "TL_CERTIFICATION", decision: "RECOMMEND" });
    await expect(db.query("UPDATE approval_verifications SET outcome = 'X' WHERE subject_id = $1", [id])).rejects.toThrow(/cannot be changed/);
    await expect(db.query("DELETE FROM approval_verifications WHERE subject_id = $1", [id])).rejects.toThrow(/cannot be changed/);
  });

  it("Return and Reject never ask for certification; they keep their reason requirement", async () => {
    const id = await vf();
    const { ctx, input } = await tlInput(id);
    await expect(performTaskAction(ctx, { ...input, action: "RETURN", reason: "" })).rejects.toMatchObject({ code: "VALIDATION" });
    await performTaskAction(ctx, { ...input, idempotencyKey: randomUUID(), action: "RETURN", reason: "Add the latest bank statement." });
    expect(await rows(id)).toHaveLength(0);
  });

  it("uses the CX checklist at CX credit review and the DH checklist only at the Divisional Head", async () => {
    expect(checklistFor({ kind: "APPLICATION", stage: "FIRST_CREDIT_REVIEW", action: "APPROVE", policy: "RETAIL_CX_V1" })?.id).toBe("CX_REVIEW");
    expect(checklistFor({ kind: "APPLICATION", stage: "FIRST_CREDIT_REVIEW", action: "APPROVE", policy: "STANDARD" })?.id).toBe("CREDIT_APPRAISAL");
    expect(checklistFor({ kind: "APPLICATION", stage: "SECOND_CREDIT_REVIEW", action: "PROCEED" })?.id).toBe("CONCURRENCE");
    expect(checklistFor({ kind: "APPLICATION", stage: "UNIT_HEAD_REVIEW", action: "APPROVE" })?.id).toBe("UNIT_HEAD");
    expect(checklistFor({ kind: "APPLICATION", stage: "DIVISIONAL_HEAD_REVIEW", action: "APPROVE" })?.id).toBe("DH_FINAL");
    expect(checklistFor({ kind: "APPLICATION", stage: "OFFER_PREPARATION", action: "SUBMIT_PACK" })).toBeNull();
    expect(checklistFor({ kind: "APPLICATION", stage: "DIVISIONAL_HEAD_REVIEW", action: "REJECT" })).toBeNull();
    const id = await vf();
    const t = await tlInput(id);
    await performTaskAction(t.ctx, await withVerification(t.input));
    await recordFinal(id);
    const cx = await openTaskOf(id);
    await performTaskAction(await ctxFor(cx.email!), await withVerification({ taskId: cx.id, action: "APPROVE", idempotencyKey: randomUUID() }));
    expect((await rows(id)).map((r) => r.checklist_id)).toEqual(["TL_CERTIFICATION", "CX_REVIEW"]);
  });

  it("re-checks authority at confirmation: a reviewer whose role was removed cannot complete it", async () => {
    const id = await vf();
    const { ctx, input } = await tlInput(id);
    const full = await withVerification(input);
    await db.query("UPDATE role_assignments SET active = false WHERE staff_id = $1 AND role = 'TEAM_LEAD'", [ctx.actor!.staffId]);
    await expect(performTaskAction(ctx, full)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await rows(id)).toHaveLength(0);
  });
});
