import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { applyConfig, createRetailCase, driveBusinessReview, syntheticConfig } from "@/server/demo/retail-scenario";
import { activeWorkflow, publishWorkflow, workflowHistory } from "@/server/domain/approval-workflows";
import { DEFAULT_CREDIT_BANDS, defaultDefinition, planRoute, validateDefinition, type WorkflowDefinition } from "@/lib/approval-workflow";
import { CREDIT_ROUTES } from "@/server/domain/routing";

const N = (naira: number) => naira * 100;
const ADMIN = "superadmin@altbank.ng";
const REASON = "Credit committee decision CC-2026-14: simplify business review and split route 2.";
const vfCase = (amount = 15_000_000) =>
  createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(amount), tenorMonths: 12, incomeBasisKobo: N(10_000_000), proposedMonthlyKobo: N(1_000_000) });
const tasks = async (id: string) => (await db.query<{ stage: string; assignee_role: string }>("SELECT stage, assignee_role FROM tasks WHERE application_id = $1 ORDER BY seq", [id])).rows;
const app = async (id: string) => (await db.query("SELECT * FROM applications WHERE id = $1", [id])).rows[0];

/** Version 2 for Vendor Financing: no Head of Retail Sales on the standard route; route 2 split at ₦10m. */
function v2(): WorkflowDefinition {
  const d = defaultDefinition("RETAIL");
  d.standard!.businessStages = d.standard!.businessStages.filter((s) => s.stage !== "HRS_REVIEW");
  d.creditBands = [
    DEFAULT_CREDIT_BANDS[0],
    { ...DEFAULT_CREDIT_BANDS[1], maxKobo: N(10_000_000) },
    { minKobo: N(10_000_000) + 1, maxKobo: N(50_000_000), firstReviewRoles: ["CREDIT_OFFICER_3"], secondReviewRoles: ["CREDIT_LEAD_1", "CREDIT_LEAD_2"] },
  ];
  return d;
}

beforeEach(async () => {
  await resetDb();
  await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING"));
});

describe("version 1 is the routing in force before", () => {
  it("reproduces the original credit table and business reviews", async () => {
    expect(DEFAULT_CREDIT_BANDS.map((b) => [b.minKobo, b.maxKobo, b.firstReviewRoles, b.secondReviewRoles])).toEqual(CREDIT_ROUTES.map((r) => [r.minKobo, r.maxKobo, r.firstReviewRoles, r.secondReviewRoles]));
    for (const f of ["RETAIL", "WAKEELBOOST", "ALTPHONES"] as const) expect(validateDefinition(defaultDefinition(f), f)).toEqual([]);
    const w = await activeWorkflow(db, "VENDOR_FINANCING");
    expect(w.version).toBe(1);
    expect(w.published_by).toBeNull();
  });
});

describe("Test D/E: direct publication by a Super Admin, with audit", () => {
  it("publishes immediately with a reason, no second approval; records old and new configuration, who, role, when and version", async () => {
    const r = await publishWorkflow(await ctxFor(ADMIN), { productCode: "VENDOR_FINANCING", definition: v2(), reason: REASON, expectedVersion: 1 });
    expect(r.version).toBe(2);
    expect(r.auditReference).toMatch(/^WF-VENDOR_FINANCING-v2-/);
    const w = await activeWorkflow(db, "VENDOR_FINANCING");
    expect(w).toMatchObject({ version: 2, reason: REASON, published_role: "SUPER_ADMIN" });
    expect(w.published_by).toBe((await db.query("SELECT id FROM staff WHERE email = $1", [ADMIN])).rows[0].id);
    expect(w.previous_definition).toEqual(defaultDefinition("RETAIL"));
    expect(w.changes.map((c) => c.kind).sort()).toEqual(["REMOVED", "THRESHOLD", "THRESHOLD"]);
    const ev = (await db.query("SELECT * FROM audit_events WHERE action = 'APPROVAL_WORKFLOW_PUBLISHED'")).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_role: "SUPER_ADMIN", reason: REASON, outcome: "SUCCESS" });
    expect(ev[0].details).toMatchObject({ product: "VENDOR_FINANCING", version: 2, previousVersion: 1, outcome: "PUBLISHED" });
    expect(ev[0].details.previousDefinition).toEqual(defaultDefinition("RETAIL"));
    expect(ev[0].details.newDefinition).toEqual(v2());
    // Versions are append-only.
    await expect(db.query("UPDATE approval_workflows SET reason = 'x' WHERE version = 2")).rejects.toThrow(/cannot be changed/);
    await expect(db.query("DELETE FROM approval_workflows")).rejects.toThrow(/cannot be changed/);
    // Restore = a new audited publication.
    const v1 = (await workflowHistory(db, "VENDOR_FINANCING")).find((h) => h.version === 1)!;
    const back = await publishWorkflow(await ctxFor(ADMIN), { productCode: "VENDOR_FINANCING", definition: null, restoreFromId: v1.id, reason: "Restoring the original routing after the pilot ended.", expectedVersion: 2 });
    expect(back.version).toBe(3);
    expect((await activeWorkflow(db, "VENDOR_FINANCING")).definition).toEqual(defaultDefinition("RETAIL"));
  });
});

describe("Test F: versions are pinned at submission", () => {
  it("requests already submitted keep their route; new requests use the new version; the simulation predicts the live route", async () => {
    const before = await vfCase();
    const legacy = await vfCase();
    await db.query("UPDATE applications SET workflow_version_id = NULL WHERE id = $1", [legacy]); // submitted before configurable workflows
    expect((await app(before)).workflow_version_id).toBe((await activeWorkflow(db, "VENDOR_FINANCING")).id);
    await publishWorkflow(await ctxFor(ADMIN), { productCode: "VENDOR_FINANCING", definition: v2(), reason: REASON, expectedVersion: 1 });
    const after = await vfCase();
    for (const id of [before, legacy, after]) await driveBusinessReview(id);
    expect((await tasks(before)).map((t) => t.stage)).toEqual(["TEAM_LEAD_REVIEW", "HRS_REVIEW", "HEAD_OF_UNIT_APPROVAL", "FIRST_CREDIT_REVIEW"]);
    expect((await tasks(legacy)).map((t) => t.stage)).toEqual(["TEAM_LEAD_REVIEW", "HRS_REVIEW", "HEAD_OF_UNIT_APPROVAL", "FIRST_CREDIT_REVIEW"]);
    expect((await tasks(after)).map((t) => t.stage)).toEqual(["TEAM_LEAD_REVIEW", "HEAD_OF_UNIT_APPROVAL", "FIRST_CREDIT_REVIEW"]);
    // ₦15m: route 2 (CO2) on the original routing, route 3 (CO3) on version 2.
    expect((await app(before)).route).toBe(2);
    expect((await tasks(before)).at(-1)!.assignee_role).toBe("CREDIT_OFFICER_2");
    expect((await app(after)).route).toBe(3);
    expect((await tasks(after)).at(-1)!.assignee_role).toBe("CREDIT_OFFICER_3");
    const plan = planRoute(v2(), { amountKobo: N(15_000_000), initiatorRole: "RM", policy: "STANDARD", headOfUnitDistinct: true });
    expect(plan.stages.slice(0, 3).map((s) => s.stage)).toEqual(["TEAM_LEAD_REVIEW", "HEAD_OF_UNIT_APPROVAL", "FIRST_CREDIT_REVIEW"]);
    expect(plan.stages[2].roles).toEqual(["CREDIT_OFFICER_3"]);
    expect(plan.stages.map((s) => s.stage).slice(-2)).toEqual(["UNIT_HEAD_REVIEW", "DIVISIONAL_HEAD_REVIEW"]);
    // Amount conditions apply live too: Head of Unit only from ₦20m.
    const v3 = v2();
    v3.standard!.businessStages = [{ stage: "TEAM_LEAD_REVIEW", minKobo: null, maxKobo: null }, { stage: "HEAD_OF_UNIT_APPROVAL", minKobo: N(20_000_000), maxKobo: null }];
    await publishWorkflow(await ctxFor(ADMIN), { productCode: "VENDOR_FINANCING", definition: v3, reason: "Head of Unit approval only for larger requests (memo 22).", expectedVersion: 2 });
    const small = await vfCase();
    await driveBusinessReview(small);
    expect((await tasks(small)).map((t) => t.stage)).toEqual(["TEAM_LEAD_REVIEW", "FIRST_CREDIT_REVIEW"]);
  });
});

describe("Test G: governance", () => {
  const bad: [string, (d: WorkflowDefinition) => void, RegExp][] = [
    ["no Team Lead review", (d) => (d.standard!.businessStages = d.standard!.businessStages.filter((s) => s.stage !== "TEAM_LEAD_REVIEW")), /Team Lead review is mandatory/],
    ["Team Lead not first", (d) => d.standard!.businessStages.reverse(), /must be the first business review/],
    ["a stage twice", (d) => d.cx!.businessStages.push({ stage: "TEAM_LEAD_REVIEW", minKobo: null, maxKobo: null }), /appears twice/],
    ["gap in amounts", (d) => (d.creditBands![1].minKobo = N(6_000_000)), /No credit route covers/],
    ["overlap", (d) => (d.creditBands![1].minKobo = N(4_000_000)), /overlap/],
    ["not covering ₦50m", (d) => (d.creditBands![2].maxKobo = N(40_000_000)), /must end at/],
    ["authority exceeded", (d) => (d.creditBands![2].firstReviewRoles = ["CREDIT_OFFICER_1"]), /authority only up to/],
    ["no concurrence", (d) => (d.creditBands![0].secondReviewRoles = []), /concurrence is mandatory/],
    ["same role reviews twice", (d) => d.creditBands![0].secondReviewRoles.push("CREDIT_OFFICER_1"), /not an authorised second credit reviewer|cannot be both/],
    ["unknown role", (d) => (d.creditBands![0].firstReviewRoles = ["RM"]), /not an authorised first credit reviewer/],
    ["unreachable stage", (d) => (d.standard!.businessStages[1].minKobo = N(60_000_000)), /can never be reached/],
    ["no credit route", (d) => (d.creditBands = []), /no credit approval route/],
  ];
  for (const [name, mutate, msg] of bad) {
    it(`refuses ${name}`, async () => {
      const d = defaultDefinition("RETAIL");
      mutate(d);
      await expect(publishWorkflow(await ctxFor(ADMIN), { productCode: "VENDOR_FINANCING", definition: d, reason: REASON, expectedVersion: 1 })).rejects.toThrow(msg);
      expect((await activeWorkflow(db, "VENDOR_FINANCING")).version).toBe(1);
    });
  }

  it("needs a Super Admin, a meaningful reason, the latest version and an actual change; Altphones approvals cannot be changed", async () => {
    await expect(publishWorkflow(await ctxFor("rm.bola@altbank.ng"), { productCode: "VENDOR_FINANCING", definition: v2(), reason: REASON, expectedVersion: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(publishWorkflow(await ctxFor(ADMIN), { productCode: "VENDOR_FINANCING", definition: v2(), reason: "because", expectedVersion: 1 })).rejects.toThrow(/at least 20 characters/);
    await expect(publishWorkflow(await ctxFor(ADMIN), { productCode: "VENDOR_FINANCING", definition: defaultDefinition("RETAIL"), reason: REASON, expectedVersion: 1 })).rejects.toThrow(/no changes/);
    await publishWorkflow(await ctxFor(ADMIN), { productCode: "VENDOR_FINANCING", definition: v2(), reason: REASON, expectedVersion: 1 });
    await expect(publishWorkflow(await ctxFor(ADMIN), { productCode: "VENDOR_FINANCING", definition: defaultDefinition("RETAIL"), reason: REASON, expectedVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    const alt = { ...defaultDefinition("ALTPHONES"), creditBands: DEFAULT_CREDIT_BANDS };
    await expect(publishWorkflow(await ctxFor(ADMIN), { productCode: "ALTPHONES", definition: alt, reason: REASON, expectedVersion: 1 })).rejects.toThrow(/no changes|cannot be published/);
    const refused = await db.query("SELECT outcome FROM audit_events WHERE action = 'APPROVAL_WORKFLOW_PUBLISH_REFUSED'");
    expect(refused.rows.map((r) => r.outcome)).toContain("DENIED");
    expect(refused.rowCount).toBe(5);
  });
});
