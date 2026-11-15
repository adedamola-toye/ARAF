import { actAs } from "@/server/demo/scenario";
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { act, ctxFor, openTaskOf } from "@/server/demo/scenario";
import { applyConfig, createRetailCase, recordFinal, syntheticConfig } from "@/server/demo/retail-scenario";
import { stageLabel } from "@/server/domain/stages";

const N = (n: number) => n * 100;

async function addStaff(email: string, name: string, role: string) {
  const id = (await db.query("INSERT INTO staff (email, full_name, region, business_unit, status) VALUES ($1,$2,'LAGOS','Credit','ACTIVE') RETURNING id", [email, name])).rows[0].id;
  await db.query("INSERT INTO role_assignments (staff_id, role, active) VALUES ($1,$2,true)", [id, role]);
  return id as string;
}
const stages = async (id: string) => (await db.query("SELECT t.stage, s.email FROM tasks t LEFT JOIN staff s ON s.id = t.assignee_id WHERE application_id = $1 ORDER BY seq", [id])).rows as { stage: string; email: string | null }[];
const app = async (id: string) => (await db.query("SELECT * FROM applications WHERE id = $1", [id])).rows[0];
const rules = async (id: string) => (await db.query("SELECT details->>'rule' AS rule, stage FROM audit_events WHERE application_id = $1 AND action = 'ROUTING_RULE_APPLIED' ORDER BY id", [id])).rows;

/** Vendor Financing on the CX policy, with the business's affordability settings. */
const cxConfig = (policy: "RETAIL_CX_V1" | "STANDARD" = "RETAIL_CX_V1") =>
  applyConfig(
    "VENDOR_FINANCING",
    syntheticConfig("VENDOR_FINANCING", (c) => {
      c.approvalPolicy = policy;
      for (const r of Object.values(c.profiles)) {
        if (!r) continue;
        r.dsr.maxPercent = "30";
        r.minTenorMonths = 12;
        r.maxTenorMonths = 36;
      }
    }),
  );
const vfCase = (channel: "RM" | "TL" | "UH") => createRetailCase({ channel, product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(2_000_000), tenorMonths: 12, incomeBasisKobo: N(10_000_000), proposedMonthlyKobo: N(200_000) });

beforeEach(async () => {
  await resetDb();
});

describe("RETAIL_CX_V1 approval chain", () => {
  it("RM-originated: Team Lead certification → CX credit review → Unit Head → Divisional Head → offer", async () => {
    await cxConfig();
    await addStaff("cx.one@altbank.ng", "Ada CX-Reviewer", "CX_CREDIT_REVIEWER");
    const id = await vfCase("RM");
    expect((await app(id)).approval_policy).toBe("RETAIL_CX_V1");
    expect((await openTaskOf(id)).stage).toBe("TEAM_LEAD_REVIEW");
    await act(id, "RECOMMEND", { reason: "Analysis verified; certified for credit.", visitComments: "Management visit completed; business operating as described.", rmPhotoConfirmed: true });
    const cx = await openTaskOf(id);
    expect(cx).toMatchObject({ stage: "FIRST_CREDIT_REVIEW", email: "cx.one@altbank.ng" });
    expect(stageLabel(cx.stage, "RETAIL_CX_V1")).toBe("CX credit review");
    await recordFinal(id);
    await act(id, "APPROVE", {});
    expect((await openTaskOf(id)).stage).toBe("UNIT_HEAD_REVIEW");
    await act(id, "APPROVE", {});
    expect((await openTaskOf(id)).stage).toBe("DIVISIONAL_HEAD_REVIEW");
    await act(id, "APPROVE", {});
    expect((await openTaskOf(id)).stage).toBe("OFFER_PREPARATION");
    const seen = (await stages(id)).map((s) => s.stage);
    expect(seen).toEqual(["TEAM_LEAD_REVIEW", "FIRST_CREDIT_REVIEW", "UNIT_HEAD_REVIEW", "DIVISIONAL_HEAD_REVIEW", "OFFER_PREPARATION"]);
    expect(seen).not.toContain("HRS_REVIEW");
    expect(seen).not.toContain("SECOND_CREDIT_REVIEW");
    expect((await app(id)).route).toBeNull(); // not routed by amount
  });

  it("Team Lead-originated: never certified by the originator; goes to independent CX credit review", async () => {
    await cxConfig();
    await addStaff("cx.one@altbank.ng", "Ada CX-Reviewer", "CX_CREDIT_REVIEWER");
    const id = await vfCase("TL");
    expect((await app(id)).initiator_role).toBe("TEAM_LEAD");
    expect(await openTaskOf(id)).toMatchObject({ stage: "FIRST_CREDIT_REVIEW", email: "cx.one@altbank.ng" });
    expect((await stages(id)).map((s) => s.stage)).not.toContain("TEAM_LEAD_REVIEW");
    expect(await rules(id)).toEqual([{ rule: "TL_ORIGINATOR_CERTIFICATION", stage: "TEAM_LEAD_REVIEW" }]);
  });

  it("Unit Head-originated: moves forward to CX credit review, then the Divisional Head; never another Unit Head", async () => {
    await cxConfig();
    await addStaff("cx.one@altbank.ng", "Ada CX-Reviewer", "CX_CREDIT_REVIEWER");
    await addStaff("uh.two@altbank.ng", "Second Unit-Head", "UNIT_HEAD"); // even with another Unit Head available
    const id = await vfCase("UH");
    expect((await openTaskOf(id)).stage).toBe("FIRST_CREDIT_REVIEW");
    await recordFinal(id);
    await act(id, "APPROVE", {});
    expect(await openTaskOf(id)).toMatchObject({ stage: "DIVISIONAL_HEAD_REVIEW", email: "div.head@altbank.ng" });
    expect((await rules(id)).map((r) => r.rule)).toEqual(["UH_ORIGINATOR_CERTIFICATION", "UH_ORIGINATOR_UNIT_HEAD_STAGE"]);
    const seen = (await stages(id)).map((s) => s.stage);
    expect(seen).not.toContain("TEAM_LEAD_REVIEW");
    expect(seen).not.toContain("UNIT_HEAD_REVIEW");
  });

  it("holds the request in the exception queue when no CX Credit Reviewer is eligible; Super Admin rights never approve", async () => {
    await cxConfig();
    const id = await vfCase("RM");
    await act(id, "RECOMMEND", { reason: "Analysis verified; certified for credit.", visitComments: "Management visit completed; business operating as described.", rmPhotoConfirmed: true });
    const t = await openTaskOf(id);
    expect(t).toMatchObject({ stage: "FIRST_CREDIT_REVIEW", email: null });
    const admin = await ctxFor("superadmin@altbank.ng");
    await expect(actAs(admin, { taskId: t.id, action: "APPROVE", idempotencyKey: randomUUID() })).rejects.toBeTruthy();
    expect((await db.query("SELECT 1 FROM audit_events WHERE application_id = $1 AND action = 'TASK_UNASSIGNED_NO_ELIGIBLE_STAFF'", [id])).rowCount).toBe(1);
  });

  it("CX can return to the initiator; the Unit Head can reject", async () => {
    await cxConfig();
    await addStaff("cx.one@altbank.ng", "Ada CX-Reviewer", "CX_CREDIT_REVIEWER");
    const id = await vfCase("TL");
    await act(id, "RETURN", { reason: "Add the latest bank statement page." });
    expect((await openTaskOf(id)).stage).toBe("INITIATOR_CORRECTION");
    const id2 = await vfCase("RM");
    await act(id2, "RECOMMEND", { reason: "Analysis verified; certified for credit.", visitComments: "Management visit completed; business operating as described.", rmPhotoConfirmed: true });
    await recordFinal(id2);
    await act(id2, "APPROVE", {});
    await act(id2, "REJECT", { reason: "Concentration risk in this sector." });
    expect((await app(id2)).status).toBe("REJECTED");
  });

  it("products still on the standard chain keep it; Team Leads cannot submit them", async () => {
    await cxConfig("STANDARD");
    const id = await vfCase("RM");
    expect((await app(id)).approval_policy).toBe("STANDARD");
    await act(id, "RECOMMEND", { reason: "Analysis verified; recommended.", visitComments: "Management visit completed; business operating as described.", rmPhotoConfirmed: true });
    expect((await openTaskOf(id)).stage).toBe("HRS_REVIEW");
    await expect(vfCase("TL")).rejects.toMatchObject({ code: "GATE" });
  });
});
