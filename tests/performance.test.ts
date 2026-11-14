import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { applyConfig, createRetailCase, syntheticConfig } from "@/server/demo/retail-scenario";
import { dailySummary, decideTarget, markSummarySeen, proposeTarget, summaryDue, workingDays } from "@/server/domain/performance";
import { fromLagos } from "@/server/time";

const N = (n: number) => n * 100;
const MON_16_NOV = fromLagos(2026, 11, 16, 9);
const staff = async (email: string) => (await db.query("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id as string;

/** Synthetic disbursement against a real (submitted) request: test data only. */
async function disburse(appId: string, kobo: number, on: string) {
  await db.query("INSERT INTO disbursements (application_id, amount_kobo, approved_amount_kobo, disbursed_on, transaction_ref, recorded_by, recorded_at) VALUES ($1,$2,$2,$3,$4,$5,now())", [appId, kobo, on, `TEST-${appId}`, await staff("superadmin@altbank.ng")]);
}
const vf = (channel: "RM" | "TL" = "RM") => createRetailCase({ channel, product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(2_000_000), tenorMonths: 12 });

beforeEach(async () => {
  await resetDb();
  await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING", (c) => (c.approvalPolicy = "RETAIL_CX_V1")));
});

describe("working days", () => {
  it("count Monday to Friday and skip recorded public holidays", async () => {
    expect(await workingDays(db, "2026-11-01", "2026-11-30")).toBe(21);
    await db.query("INSERT INTO altphones_holidays (holiday_date, name) VALUES ('2026-11-20', 'Test holiday')");
    expect(await workingDays(db, "2026-11-01", "2026-11-30")).toBe(20);
  });
});

describe("daily performance summary", () => {
  it("says the target is not configured until one is approved; never invents one", async () => {
    const s = await dailySummary(db, await staff("rm.bola@altbank.ng"), MON_16_NOV);
    expect(s?.mine?.target).toBeNull();
    expect(s?.mine?.achievementPercent).toBeNull();
    expect(s?.mine?.requiredDailyKobo).toBeNull();
    expect(s?.mine?.mtd).toEqual({ valueKobo: 0, count: 0 });
  });

  it("month-to-date, achievement, run rate and required daily rate from recorded disbursements", async () => {
    const rm = await staff("rm.bola@altbank.ng");
    await disburse(await vf(), N(2_000_000), "2026-11-13");
    await disburse(await vf(), N(3_000_000), "2026-11-16");
    await disburse(await vf(), N(9_000_000), "2026-10-30"); // last month: not counted
    const id = await proposeTarget(await ctxFor("superadmin@altbank.ng"), { scopeType: "STAFF", staffId: rm, metric: "DISBURSED_VALUE", month: "2026-11", value: N(22_000_000), reason: "November allocation" });
    await decideTarget(await ctxFor("unit.head@altbank.ng"), id, "APPROVE", "");
    const s = (await dailySummary(db, rm, MON_16_NOV))!;
    expect(s.workingDays).toEqual({ elapsed: 11, remaining: 11, total: 21 });
    expect(s.mine).toMatchObject({
      target: { value: N(22_000_000) },
      mtd: { valueKobo: N(5_000_000), count: 2 },
      today: { valueKobo: N(3_000_000), count: 1 },
      yesterday: { valueKobo: N(2_000_000), count: 1, date: "2026-11-13" },
      achievementPercent: 22.7,
      runRateKobo: Math.round(N(5_000_000) / 11),
      projectedKobo: Math.round(N(5_000_000) / 11) * 21,
      requiredDailyKobo: Math.ceil(N(17_000_000) / 11),
    });
  });

  it("Team Lead sees own originations and the team total side by side, not added", async () => {
    const tl = await staff("tl.lagos@altbank.ng");
    await disburse(await vf("RM"), N(4_000_000), "2026-11-16");
    await disburse(await vf("TL"), N(1_000_000), "2026-11-16");
    const s = (await dailySummary(db, tl, MON_16_NOV))!;
    expect(s.mine?.mtd.valueKobo).toBe(N(1_000_000));
    expect(s.teams).toHaveLength(1);
    expect(s.teams[0].label).toBe("My team: RETAIL-LAGOS-1");
    expect(s.teams[0].mtd.valueKobo).toBe(N(5_000_000));
    expect(s.teams[0].target).toBeNull();
  });

  it("is shown once per Lagos day, only to Relationship Managers and Team Leads", async () => {
    const rm = await staff("rm.bola@altbank.ng");
    expect(await summaryDue(db, rm, MON_16_NOV)).toBe(true);
    await markSummarySeen(db, rm, MON_16_NOV);
    await markSummarySeen(db, rm, MON_16_NOV); // idempotent
    expect(await summaryDue(db, rm, fromLagos(2026, 11, 16, 17))).toBe(false);
    expect(await summaryDue(db, rm, fromLagos(2026, 11, 17, 8))).toBe(true);
    expect(await summaryDue(db, await staff("unit.head@altbank.ng"), MON_16_NOV)).toBe(false);
  });
});

describe("target maker-checker", () => {
  it("needs a different approver; a replacement supersedes and keeps history; proposals are immutable", async () => {
    const rm = await staff("rm.bola@altbank.ng");
    const admin = await ctxFor("superadmin@altbank.ng");
    const uh = await ctxFor("unit.head@altbank.ng");
    await expect(proposeTarget(await ctxFor("rm.bola@altbank.ng"), { scopeType: "STAFF", staffId: rm, metric: "DISBURSED_VALUE", month: "2026-12", value: N(1), reason: "mine" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const own = await proposeTarget(uh, { scopeType: "TEAM", team: "RETAIL-LAGOS-1", metric: "DISBURSED_COUNT", month: "2026-12", value: 12, reason: "Team plan" });
    await expect(decideTarget(uh, own, "APPROVE", "")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideTarget(await ctxFor("rm.bola@altbank.ng"), own, "APPROVE", "")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await decideTarget(await ctxFor("div.head@altbank.ng"), own, "APPROVE", "");
    const first = await proposeTarget(admin, { scopeType: "STAFF", staffId: rm, metric: "DISBURSED_VALUE", month: "2026-12", value: N(10_000_000), reason: "Initial" });
    await expect(proposeTarget(admin, { scopeType: "STAFF", staffId: rm, metric: "DISBURSED_VALUE", month: "2026-12", value: N(11_000_000), reason: "Again" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(decideTarget(uh, first, "REJECT", "")).rejects.toMatchObject({ code: "VALIDATION" });
    await decideTarget(uh, first, "APPROVE", "");
    const second = await proposeTarget(admin, { scopeType: "STAFF", staffId: rm, metric: "DISBURSED_VALUE", month: "2026-12", value: N(12_000_000), reason: "Revised budget" });
    const r = await decideTarget(uh, second, "APPROVE", "ok");
    expect(r).toEqual({ status: "APPROVED", superseded: first });
    const rows = (await db.query("SELECT id, status FROM performance_targets WHERE staff_id = $1 ORDER BY proposed_at", [rm])).rows;
    expect(rows.map((x) => x.status)).toEqual(["SUPERSEDED", "APPROVED"]);
    await expect(db.query("UPDATE performance_targets SET target_value = 1 WHERE id = $1", [second])).rejects.toThrow(/cannot be edited/);
    await expect(db.query("DELETE FROM performance_targets WHERE id = $1", [first])).rejects.toThrow(/cannot be deleted/);
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'TARGET_%'")).rows[0].n).toBe(6);
  });
});
