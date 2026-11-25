import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { act, openTaskOf } from "@/server/demo/scenario";
import { applyConfig, createRetailCase, syntheticConfig } from "@/server/demo/retail-scenario";
import { cxActivityAccess, cxReviewerActivity, requireCxActivityAccess } from "@/server/cx-activity";

const N = (n: number) => n * 100;

async function addStaff(email: string, name: string, role: string) {
  const id = (await db.query("INSERT INTO staff (email, full_name, region, business_unit, status) VALUES ($1,$2,'LAGOS','Credit','ACTIVE') RETURNING id", [email, name])).rows[0].id;
  await db.query("INSERT INTO role_assignments (staff_id, role, active) VALUES ($1,$2,true)", [id, role]);
  return id as string;
}
const staffId = async (email: string) => (await db.query("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id as string;
const vfCase = () =>
  createRetailCase({
    channel: "TL",
    product: "VENDOR_FINANCING",
    profile: "BUSINESS_OWNER",
    amountKobo: N(2_000_000),
    tenorMonths: 12,
    incomeBasisKobo: N(10_000_000),
    proposedMonthlyKobo: N(200_000),
  });

const cxConfig = () =>
  applyConfig(
    "VENDOR_FINANCING",
    syntheticConfig("VENDOR_FINANCING", (c) => {
      c.approvalPolicy = "RETAIL_CX_V1";
      for (const r of Object.values(c.profiles)) {
        if (!r) continue;
        r.dsr.maxPercent = "30";
        r.minTenorMonths = 12;
        r.maxTenorMonths = 36;
      }
    }),
  );

beforeEach(async () => {
  await resetDb();
});

describe("CX reviewer activity", () => {
  it("records what the CX reviewer decided and how long the request waited", async () => {
    await cxConfig();
    await addStaff("cx.one@altbank.ng", "Ada CX-Reviewer", "CX_CREDIT_REVIEWER");
    const id = await vfCase();
    expect((await openTaskOf(id)).stage).toBe("FIRST_CREDIT_REVIEW");
    await act(id, "RETURN", { reason: "Add the latest bank statement page." });

    const data = await cxReviewerActivity(db, {});
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({
      application_id: id,
      stage: "FIRST_CREDIT_REVIEW",
      action: "RETURN",
      reviewer_email: "cx.one@altbank.ng",
      reason: "Add the latest bank statement page.",
    });
    expect(data.summary).toMatchObject({ total: 1, corrections: 1, positive: 0, declines: 0, reviewers: 1 });
    expect(Number(data.rows[0].turnaround_ms)).toBeGreaterThanOrEqual(0);
    expect(data.reviewerOptions.map((r) => r.name)).toEqual(["Ada CX-Reviewer"]);
  });

  it("filters by reviewer and action", async () => {
    await cxConfig();
    await addStaff("cx.one@altbank.ng", "Ada CX-Reviewer", "CX_CREDIT_REVIEWER");
    const id = await vfCase();
    await act(id, "RETURN", { reason: "Add the latest bank statement page." });

    expect((await cxReviewerActivity(db, { action: "RECOMMEND" })).rows).toHaveLength(0);
    expect((await cxReviewerActivity(db, { action: "RETURN" })).rows).toHaveLength(1);
    expect((await cxReviewerActivity(db, { reviewer: await staffId("cx.one@altbank.ng") })).rows).toHaveLength(1);
  });

  it("is visible to credit leads and the CX Group Head, never to ordinary requesters", async () => {
    const groupHead = await addStaff("cx.group@altbank.ng", "Chika CX-Group-Head", "CX_GROUP_HEAD");
    const lead1 = await staffId("lead1@altbank.ng");
    const lead2 = await staffId("lead2@altbank.ng");
    const rm = await staffId("rm.ade@altbank.ng");

    expect(await cxActivityAccess(db, lead1)).toBe(true);
    expect(await cxActivityAccess(db, lead2)).toBe(true);
    expect(await cxActivityAccess(db, groupHead)).toBe(true);
    expect(await cxActivityAccess(db, rm)).toBe(false);
    await expect(requireCxActivityAccess(db, rm)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(requireCxActivityAccess(db, groupHead)).resolves.toBeUndefined();
  });
});
