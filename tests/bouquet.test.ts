import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { act, appRow, approveFirstReview, createSubmittedCase, ctxFor, openTaskOf } from "@/server/demo/scenario";
import { setSwitch } from "@/server/domain/switches";
import {
  assembleBouquet,
  bouquetDetail,
  candidates,
  concurBouquet,
  excludeMember,
  markInspected,
  restoreMember,
  sampleMember,
  saveBouquetSettings,
} from "@/server/domain/bouquet";

beforeEach(resetDb);

const SA = "superadmin@altbank.ng";

async function driveToDh(amountKobo = 150_000_000) {
  const id = await createSubmittedCase({ initiator: "RM", amountKobo });
  for (let i = 0; i < 2; i++) {
    const t = await openTaskOf(id);
    if (t?.stage !== "BUSINESS_ENDORSEMENT" && t?.stage !== "MO_HEAD_REVIEW") break;
    await act(id, "ENDORSE", t.stage === "MO_HEAD_REVIEW" ? { reason: "Merchant Officer Head review completed; endorsed." } : {});
  }
  await approveFirstReview(id);
  const app = await appRow(id);
  await act(id, app.route === 1 ? "APPROVE" : "PROCEED");
  await act(id, "APPROVE"); // Unit Head
  const t = await openTaskOf(id);
  expect(t.stage).toBe("DIVISIONAL_HEAD_REVIEW");
  return { id, dhEmail: t.email! };
}

async function enable(products = ["WAKEELBOOST"], over: Partial<Parameters<typeof saveBouquetSettings>[1]> = {}) {
  const sa = await ctxFor(SA);
  await setSwitch(sa, "BOUQUET_APPROVALS", true, "Risk governance approval recorded for the test");
  await saveBouquetSettings(sa, { eligibleProducts: products, maxSize: 30, minInspections: 1, individualReviewAboveKobo: null, maxTotalKobo: null, exclusionDefault: "INDIVIDUAL_REVIEW", ...over }, "Test configuration of bouquet policy");
}

describe("Facility Bouquet", () => {
  it("is switched off by default and refuses to build a bouquet", async () => {
    const { dhEmail } = await driveToDh();
    const sw = (await db.query("SELECT enabled FROM feature_switches WHERE key = 'BOUQUET_APPROVALS'")).rows[0];
    expect(sw.enabled).toBe(false);
    await expect(assembleBouquet(await ctxFor(dhEmail))).rejects.toMatchObject({ code: "GATE" });
  });

  it("with the switch on but no eligible product, nothing aggregates", async () => {
    const { dhEmail } = await driveToDh();
    await setSwitch(await ctxFor(SA), "BOUQUET_APPROVALS", true, "Risk governance approval recorded for the test");
    await expect(assembleBouquet(await ctxFor(dhEmail))).rejects.toMatchObject({ code: "GATE" });
  });

  it("aggregates, samples randomly, inspects, excludes and concurs all-or-nothing with individual records", async () => {
    const a = await driveToDh(100_000_000);
    const b = await driveToDh(200_000_000);
    const c = await driveToDh(300_000_000);
    expect(new Set([a.dhEmail, b.dhEmail, c.dhEmail]).size).toBe(1);
    await enable();
    const dh = await ctxFor(a.dhEmail);
    const bq = await assembleBouquet(dh);
    expect(bq.added).toBe(3);
    let d = (await bouquetDetail(db, bq.id, dh.actor!.staffId))!;
    expect(d.included).toHaveLength(3);
    expect(d.totalKobo).toBe("600000000");

    // Concurrence needs the minimum inspections first.
    await expect(concurBouquet(dh, { bouquetId: bq.id, acknowledged: true, expectedCount: 3, expectedTotalKobo: "600000000" })).rejects.toMatchObject({ code: "GATE" });

    const s = await sampleMember(dh, bq.id);
    expect([a.id, b.id, c.id]).toContain(s.applicationId);
    await markInspected(dh, s.memberId, "Documents and assessment consistent.");

    // Exclude C for individual review; restore; exclude again.
    const mc = d.members.find((m) => m.application_id === c.id)!;
    await expect(excludeMember(dh, mc.id, "short", "INDIVIDUAL_REVIEW")).rejects.toMatchObject({ code: "VALIDATION" });
    await excludeMember(dh, mc.id, "Supplier concentration needs my own review", "INDIVIDUAL_REVIEW");
    await restoreMember(dh, mc.id);
    await excludeMember(dh, mc.id, "Supplier concentration needs my own review", "INDIVIDUAL_REVIEW");
    d = (await bouquetDetail(db, bq.id, dh.actor!.staffId))!;
    expect(d.included).toHaveLength(2);
    expect(d.totalKobo).toBe("300000000");

    // Stale totals are refused.
    await expect(concurBouquet(dh, { bouquetId: bq.id, acknowledged: true, expectedCount: 3, expectedTotalKobo: "600000000" })).rejects.toMatchObject({ code: "CONFLICT" });
    // Acknowledgement is mandatory.
    await expect(concurBouquet(dh, { bouquetId: bq.id, acknowledged: false, expectedCount: 2, expectedTotalKobo: "300000000" })).rejects.toMatchObject({ code: "VALIDATION" });

    const r = await concurBouquet(dh, { bouquetId: bq.id, acknowledged: true, expectedCount: 2, expectedTotalKobo: "300000000" });
    expect(r.count).toBe(2);
    for (const id of [a.id, b.id]) {
      expect((await appRow(id)).stage).toBe("OFFER_PREPARATION");
      const dec = await db.query("SELECT actor_role, action, reason FROM decisions WHERE application_id = $1 AND stage = 'DIVISIONAL_HEAD_REVIEW'", [id]);
      expect(dec.rows).toHaveLength(1);
      expect(dec.rows[0]).toMatchObject({ actor_role: "DIVISIONAL_HEAD", action: "APPROVE" });
      expect(dec.rows[0].reason).toContain(bq.ref);
      expect((await appRow(id)).disbursed_at).toBeNull(); // concurrence never disburses
    }
    // The excluded facility did not inherit concurrence and stays for individual review.
    expect((await appRow(c.id)).stage).toBe("DIVISIONAL_HEAD_REVIEW");
    const cand = await candidates(db, dh.actor!.staffId);
    expect(cand.individual.map((x) => x.application_id)).toContain(c.id);

    // Idempotent replay: no second decision.
    const again = await concurBouquet(dh, { bouquetId: bq.id, acknowledged: true, expectedCount: 2, expectedTotalKobo: "300000000" });
    expect(again.replayed).toBe(true);
    expect((await db.query("SELECT count(*)::int AS n FROM decisions WHERE application_id = ANY($1) AND stage = 'DIVISIONAL_HEAD_REVIEW'", [[a.id, b.id]])).rows[0].n).toBe(2);
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'BOUQUET_CONCURRED'")).rows[0].n).toBe(1);

    // New arrivals go to a new bouquet.
    const e = await driveToDh(120_000_000);
    const bq2 = await assembleBouquet(dh);
    expect(bq2.id).not.toBe(bq.id);
    expect((await bouquetDetail(db, bq2.id, dh.actor!.staffId))!.included.map((m) => m.application_id)).toEqual([e.id]);
  });

  it("concurs nothing if any facility changed after it was added", async () => {
    const a = await driveToDh(100_000_000);
    const b = await driveToDh(200_000_000);
    await enable(["WAKEELBOOST"], { minInspections: 0 });
    const dh = await ctxFor(a.dhEmail);
    const bq = await assembleBouquet(dh);
    await db.query("UPDATE applications SET lock_version = lock_version + 1 WHERE id = $1", [b.id]);
    await expect(concurBouquet(dh, { bouquetId: bq.id, acknowledged: true, expectedCount: 2, expectedTotalKobo: "300000000" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await appRow(a.id)).stage).toBe("DIVISIONAL_HEAD_REVIEW");
    expect((await appRow(b.id)).stage).toBe("DIVISIONAL_HEAD_REVIEW");
    // Refreshing re-snapshots the changed facility for review; then concurrence succeeds.
    const r = await assembleBouquet(dh);
    expect(r.refreshed).toBe(1);
    await concurBouquet(dh, { bouquetId: bq.id, acknowledged: true, expectedCount: 2, expectedTotalKobo: "300000000" });
    expect((await appRow(b.id)).stage).toBe("OFFER_PREPARATION");
  });

  it("keeps material exceptions and large facilities out of bouquets", async () => {
    const a = await driveToDh(100_000_000);
    const big = await driveToDh(900_000_000);
    await enable(["WAKEELBOOST"], { individualReviewAboveKobo: 500_000_000 });
    await db.query("UPDATE applications SET suspended_at = now(), suspension_reason = 'test' WHERE id = $1", [a.id]);
    const dh = await ctxFor(a.dhEmail);
    const cand = await candidates(db, dh.actor!.staffId);
    expect(cand.eligible).toHaveLength(0);
    const reasons = Object.fromEntries(cand.individual.map((x) => [x.application_id, x.reasons.join(" | ")]));
    expect(reasons[a.id]).toMatch(/suspended/i);
    expect(reasons[big.id]).toMatch(/individual-review threshold/i);
  });

  it("returning an excluded facility sends it to credit correction", async () => {
    const a = await driveToDh();
    await enable();
    const dh = await ctxFor(a.dhEmail);
    const bq = await assembleBouquet(dh);
    const m = (await bouquetDetail(db, bq.id, dh.actor!.staffId))!.members[0];
    await excludeMember(dh, m.id, "Turnover evidence needs to be re-verified", "RETURN_FOR_CORRECTION");
    expect((await appRow(a.id)).stage).toBe("CREDIT_CORRECTION");
    await expect(restoreMember(dh, m.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("only a Super Admin changes settings, and only the owning Divisional Head works the bouquet", async () => {
    const a = await driveToDh();
    await expect(saveBouquetSettings(await ctxFor(a.dhEmail), { eligibleProducts: ["WAKEELBOOST"], maxSize: 10, minInspections: 1, individualReviewAboveKobo: null, maxTotalKobo: null, exclusionDefault: "INDIVIDUAL_REVIEW" }, "Trying to change the policy")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await enable();
    const bq = await assembleBouquet(await ctxFor(a.dhEmail));
    await expect(sampleMember(await ctxFor("rm.ade@altbank.ng"), bq.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
