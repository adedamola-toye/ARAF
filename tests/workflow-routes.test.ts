import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { actionQueue } from "@/server/domain/views";
import { adminAssignTask, grantRole, revokeRole, eligibleForTask } from "@/server/domain/admin";
import { performTaskAction } from "@/server/domain/workflow";
import { act, appRow, approveFirstReview, createSubmittedCase, ctxFor, driveToClosed, driveToOffer, openTaskOf } from "@/server/demo/scenario";
import { key, resetDb, staffId } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function stagesOf(appId: string) {
  return (
    await db.query(
      `SELECT t.stage, s.email, t.assignee_role, t.outcome FROM tasks t LEFT JOIN staff s ON s.id = t.assignee_id WHERE application_id = $1 ORDER BY t.seq`,
      [appId],
    )
  ).rows;
}

describe("all three credit routes end to end (synthetic cases)", () => {
  it("Route 1 (₦5,000,000.00): CO1 → CO2/CO3 → UH → DH → initiator → CO3 → DO1 → DO2 → CO3 → initiator → Closed", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(5_000_000) });
    await driveToOffer(id);
    await driveToClosed(id);
    const app = await appRow(id);
    expect(app.route).toBe(1);
    expect(app.status).toBe("CLOSED");
    expect(app.stage).toBe("CLOSED");
    const s = await stagesOf(id);
    expect(s.map((x) => x.stage)).toEqual([
      "BUSINESS_ENDORSEMENT",
      "FIRST_CREDIT_REVIEW",
      "SECOND_CREDIT_REVIEW",
      "UNIT_HEAD_REVIEW",
      "DIVISIONAL_HEAD_REVIEW",
      "OFFER_PREPARATION",
      "CO3_PACK_REVIEW",
      "DISBURSEMENT_CHECK",
      "DISBURSEMENT_BOOKING",
      "COMPLETION",
      "VENDOR_CONFIRMATION",
    ]);
    expect(s[0].email).toBe("rbe.lagos@altbank.ng");
    expect(s[1].email).toBe("co1@altbank.ng");
    expect(["co2@altbank.ng", "co3@altbank.ng"]).toContain(s[2].email);
    expect(s[3].email).toBe("unit.head@altbank.ng");
    expect(s[4].email).toBe("div.head@altbank.ng");
    expect(s[5].email).toBe("rm.ade@altbank.ng");
    expect(s[6].email).toBe("co3@altbank.ng");
    expect(s[7].email).toBe("do1@altbank.ng");
    expect(s[8].email).toBe("do2@altbank.ng");
    expect(s[9].email).toBe("co3@altbank.ng");
    expect(s[10].email).toBe("rm.ade@altbank.ng");
  });

  it("Route 2 (₦5,000,000.01): CO2 → Lead1/Lead2/CO3 with Proceed", async () => {
    const id = await createSubmittedCase({ initiator: "MERCHANT_OFFICER", type: "ENTERPRISE", amountKobo: 500_000_001 });
    await act(id, "ENDORSE");
    await approveFirstReview(id);
    const t = await openTaskOf(id);
    expect(t.stage).toBe("SECOND_CREDIT_REVIEW");
    expect(["lead1@altbank.ng", "lead2@altbank.ng", "co3@altbank.ng"]).toContain(t.email);
    await expect(act(id, "APPROVE")).rejects.toThrow(/not available/);
    await expect(act(id, "RETURN", { reason: "need more" })).rejects.toThrow(/not available/);
    await act(id, "PROCEED");
    await act(id, "APPROVE");
    await act(id, "APPROVE");
    await driveToClosed(id);
    const app = await appRow(id);
    expect(app.route).toBe(2);
    expect(app.status).toBe("CLOSED");
    const s = await stagesOf(id);
    expect(s[1].email).toBe("co2@altbank.ng");
    expect(s[0].email).toBe("mo.lead@altbank.ng");
  });

  it("Route 3 (₦50,000,000.00): CO3 → Lead 1 or Lead 2 (Proceed/Reject)", async () => {
    const id = await createSubmittedCase({ initiator: "ANM_NORTH", type: "LIMITED", amountKobo: NAIRA(50_000_000) });
    await act(id, "ENDORSE");
    await approveFirstReview(id);
    const t = await openTaskOf(id);
    expect(["lead1@altbank.ng", "lead2@altbank.ng"]).toContain(t.email);
    await act(id, "PROCEED");
    await act(id, "APPROVE");
    await act(id, "APPROVE");
    await driveToClosed(id);
    const app = await appRow(id);
    expect(app.route).toBe(3);
    const s = await stagesOf(id);
    expect(s[0].email).toBe("anm.lead.north@altbank.ng");
    expect(s[1].email).toBe("co3@altbank.ng");
    // Pack goes to CO3 irrespective of route
    expect(s.find((x) => x.stage === "CO3_PACK_REVIEW")!.email).toBe("co3@altbank.ng");
  });
});

describe("business endorsement paths", () => {
  it("RM → the RBE selected by name", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000), rbeEmail: "rbe.abuja@altbank.ng" });
    expect((await openTaskOf(id)).email).toBe("rbe.abuja@altbank.ng");
  });
  it("Merchant Officer → Merchant Officer Lead", async () => {
    const id = await createSubmittedCase({ initiator: "MERCHANT_OFFICER", amountKobo: NAIRA(1_000) });
    expect((await openTaskOf(id)).email).toBe("mo.lead@altbank.ng");
  });
  it("ANM North → North ANM Lead; ANM South → South ANM Lead", async () => {
    const n = await createSubmittedCase({ initiator: "ANM_NORTH", amountKobo: NAIRA(1_000) });
    const s = await createSubmittedCase({ initiator: "ANM_SOUTH", amountKobo: NAIRA(1_000) });
    expect((await openTaskOf(n)).email).toBe("anm.lead.north@altbank.ng");
    expect((await openTaskOf(s)).email).toBe("anm.lead.south@altbank.ng");
  });
  it("credit routing cannot start before endorsement", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    const app = await appRow(id);
    expect(app.route).toBeNull();
    expect((await openTaskOf(id)).stage).toBe("BUSINESS_ENDORSEMENT");
  });
});

describe("random assignment eligibility and separation of duties", () => {
  it("second reviewer is drawn only from eligible roles and never the first reviewer", async () => {
    // Make CO1 also hold CO2: they must still never be picked as their own second reviewer.
    const admin = await ctxFor("superadmin@altbank.ng");
    await grantRole(admin, { staffId: await staffId("co1@altbank.ng"), role: "CREDIT_OFFICER_2" });
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const id = await createSubmittedCase({ initiator: "MERCHANT_OFFICER", amountKobo: NAIRA(10_000) });
      await act(id, "ENDORSE");
      await approveFirstReview(id);
      const t = await openTaskOf(id);
      expect(t.email).not.toBe("co1@altbank.ng");
      expect(["co2@altbank.ng", "co3@altbank.ng"]).toContain(t.email);
      seen.add(t.email!);
      const pool = (await db.query("SELECT eligible_pool, method FROM assignment_changes WHERE task_id = $1", [t.id])).rows[0];
      expect(pool.method).toBe("RANDOM");
      expect(pool.eligible_pool.map((p: { id: string }) => p.id)).not.toContain(await staffId("co1@altbank.ng"));
    }
    expect(seen.size).toBe(2); // both eligible roles were selected across runs (p(fail) ≈ 2^-11)
  });

  it("an unstaffed stage creates an unassigned task surfaced to Super Admin and cannot be skipped", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    await revokeRole(admin, { staffId: await staffId("unit.head@altbank.ng"), role: "UNIT_HEAD" });
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(10_000) });
    await act(id, "ENDORSE");
    await approveFirstReview(id);
    await act(id, "APPROVE");
    const t = await openTaskOf(id);
    expect(t.stage).toBe("UNIT_HEAD_REVIEW");
    expect(t.assignee_id).toBeNull();
    const exc = (await db.query("SELECT * FROM notification_outbox WHERE kind = 'ASSIGNMENT_EXCEPTION'")).rows;
    expect(exc[0].to_addresses).toContain("superadmin@altbank.ng");
    // Nobody can act on it, including the Divisional Head trying to skip ahead.
    const dh = await ctxFor("div.head@altbank.ng");
    await expect(performTaskAction(dh, { taskId: t.id, action: "APPROVE", idempotencyKey: key() })).rejects.toThrow(/not assigned to you/);
    // Prior reviewers on the case are never eligible, even if they are granted the role.
    const first = await db.query("SELECT email FROM staff WHERE id = $1", [(await appRow(id)).first_reviewer_id]);
    await grantRole(admin, { staffId: await staffId(first.rows[0].email), role: "UNIT_HEAD" });
    expect(await eligibleForTask(t.id)).toEqual([]);
  });

  it("admin resolves an exception with an eligible officer only (and never themselves)", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    await revokeRole(admin, { staffId: await staffId("unit.head@altbank.ng"), role: "UNIT_HEAD" });
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(10_000) });
    await act(id, "ENDORSE");
    await approveFirstReview(id);
    await act(id, "APPROVE");
    const t = await openTaskOf(id);
    await grantRole(admin, { staffId: await staffId("lead2@altbank.ng"), role: "UNIT_HEAD" });
    const elig = await eligibleForTask(t.id);
    expect(elig.map((e) => e.email)).toEqual(["lead2@altbank.ng"]);
    await expect(adminAssignTask(admin, t.id, await staffId("co1@altbank.ng"), "cover")).rejects.toThrow(/not eligible/);
    await adminAssignTask(admin, t.id, await staffId("lead2@altbank.ng"), "Covering Unit Head");
    expect((await openTaskOf(id)).email).toBe("lead2@altbank.ng");
    await act(id, "APPROVE");
    expect((await openTaskOf(id)).stage).toBe("DIVISIONAL_HEAD_REVIEW");
  });

  it("initiator cannot be assigned as an approver of their own case", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    // RM also holds RBE; their own request must not be endorsed by themselves.
    await grantRole(admin, { staffId: await staffId("rm.ade@altbank.ng"), role: "RBE" });
    await expect(createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000), rbeEmail: "rm.ade@altbank.ng" })).rejects.toMatchObject({
      fields: { rbeId: expect.stringMatching(/Regional Business Executive/) },
    });
  });

  it("a revoked role removes the officer's actionable task and surfaces it for reassignment", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    const admin = await ctxFor("superadmin@altbank.ng");
    await revokeRole(admin, { staffId: await staffId("rbe.lagos@altbank.ng"), role: "RBE" });
    const t = await openTaskOf(id);
    expect(t.assignee_id).toBeNull();
    const q = await actionQueue(db, await staffId("rbe.lagos@altbank.ng"), {});
    expect(q.total).toBe(0);
  });
});

describe("action queue", () => {
  it("shows every assigned item across roles; moves between queues after an action", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    await grantRole(admin, { staffId: await staffId("co1@altbank.ng"), role: "RBE" });
    const a = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000), rbeEmail: "co1@altbank.ng" });
    const b = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(2_000) });
    await act(b, "ENDORSE"); // b -> CO1 first review
    const co1 = await staffId("co1@altbank.ng");
    let q = await actionQueue(db, co1, {});
    expect(q.allTotal).toBe(2);
    expect(new Set(q.rows.map((r) => r.assignee_role))).toEqual(new Set(["RBE", "CREDIT_OFFICER_1"]));
    // Filtering reports the filtered total but the unfiltered total is preserved.
    q = await actionQueue(db, co1, { role: "RBE" });
    expect(q.total).toBe(1);
    expect(q.allTotal).toBe(2);
    // Pagination keeps every item reachable.
    const p1 = await actionQueue(db, co1, { pageSize: 5, page: 1, sort: "amount", dir: "desc" });
    expect(p1.rows[0].application_id).toBe(b);
    // Acting removes the item from this officer's queue and adds it to the next assignee's.
    await act(a, "ENDORSE");
    q = await actionQueue(db, co1, {});
    // a now routes to CO1 for first review (CO1 endorsed it, so separation of duties excludes them)
    expect(q.rows.find((r) => r.application_id === a)).toBeUndefined();
    const t = await openTaskOf(a);
    expect(t.assignee_id).toBeNull(); // only CO1 holds CREDIT_OFFICER_1, and they endorsed -> exception
  });
});

describe("concurrency and idempotency", () => {
  it("a duplicate submission replays the first result instead of acting twice", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    const t = await openTaskOf(id);
    const ctx = await ctxFor(t.email!);
    const k = key();
    const [r1, r2] = await Promise.all([
      performTaskAction(ctx, { taskId: t.id, action: "ENDORSE", idempotencyKey: k }),
      performTaskAction(ctx, { taskId: t.id, action: "ENDORSE", idempotencyKey: k }),
    ]);
    expect(r1.stage).toBe("FIRST_CREDIT_REVIEW");
    expect(r2.stage).toBe("FIRST_CREDIT_REVIEW");
    expect([r1.replayed, r2.replayed].filter(Boolean)).toHaveLength(1);
    const d = await db.query("SELECT count(*)::int AS n FROM decisions WHERE application_id = $1", [id]);
    expect(d.rows[0].n).toBe(1);
  });
  it("a second, different action on a completed task is refused", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    const t = await openTaskOf(id);
    const ctx = await ctxFor(t.email!);
    await performTaskAction(ctx, { taskId: t.id, action: "ENDORSE", idempotencyKey: key() });
    await expect(performTaskAction(ctx, { taskId: t.id, action: "REJECT", reason: "late", idempotencyKey: key() })).rejects.toThrow(/already been actioned/);
  });
  it("stale lock_version is rejected", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    const t = await openTaskOf(id);
    const ctx = await ctxFor(t.email!);
    const app = await appRow(id);
    await expect(
      performTaskAction(ctx, { taskId: t.id, action: "ENDORSE", idempotencyKey: key(), expectedLockVersion: app.lock_version - 1 }),
    ).rejects.toThrow(/changed since you opened it/);
  });
});
