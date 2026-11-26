import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { audits, resetDb } from "./helpers";
import { act, approveFirstReview, createSubmittedCase, ctxFor, openTaskOf } from "@/server/demo/scenario";
import { applyConfig, createRetailCase, recordFinal, syntheticConfig } from "@/server/demo/retail-scenario";
import { classificationGaps, setRmClassification, setRoutingAssignment } from "@/server/domain/rm-routing";
import { defaultDefinition, planRoute } from "@/lib/approval-workflow";
import { DomainError } from "@/server/errors";

const N = (n: number) => n * 100;
const ADMIN = "superadmin@altbank.ng";
const REASON = "Business owner instruction for the RM routing.";
const RECOMMEND = { reason: "Eligibility, assessment and documents reviewed; recommend." };
const sid = async (email: string) => (await db.query("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id as string;
const app = async (id: string) => (await db.query("SELECT * FROM applications WHERE id = $1", [id])).rows[0];
const stages = async (id: string) => (await db.query("SELECT t.stage FROM tasks t WHERE application_id = $1 ORDER BY seq", [id])).rows.map((r) => r.stage as string);
async function addStaff(email: string, name: string, role: string) {
  const id = (await db.query("INSERT INTO staff (email, full_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id", [email, name])).rows[0].id;
  await db.query("INSERT INTO role_assignments (staff_id, role, active) VALUES ($1,$2,true)", [id, role]);
  return id as string;
}

let admin: Awaited<ReturnType<typeof ctxFor>>;
beforeEach(async () => {
  await resetDb();
  admin = await ctxFor(ADMIN);
  await addStaff("cx.one@altbank.ng", "Ada CX-Reviewer", "CX_CREDIT_REVIEWER");
  await addStaff("ecom.uh@altbank.ng", "Efe E-commerce", "UNIT_HEAD");
  await addStaff("dbc.sw@altbank.ng", "Seyi South-West", "UNIT_HEAD");
  await addStaff("dbc.north@altbank.ng", "Musa North", "UNIT_HEAD");
});

const nonDbc = async (rmEmail: string, rbeEmail = "rbe.abuja@altbank.ng") =>
  setRmClassification(admin, { staffId: await sid(rmEmail), segment: "NON_DBC", rbeId: await sid(rbeEmail), businessUnit: "Commercial", reason: REASON });
const ecom = async () => setRoutingAssignment(admin, { key: "ECOMMERCE_UNIT_HEAD", staffId: await sid("ecom.uh@altbank.ng"), reason: REASON });

describe("RM classification (Super Admin)", () => {
  it("requires a DBC answer, a DBC region or an RBE, a reason, and a Super Admin; changes are audited", async () => {
    const rm = await sid("rm.ade@altbank.ng");
    await expect(setRmClassification(admin, { staffId: rm, segment: "", reason: REASON })).rejects.toBeInstanceOf(DomainError);
    await expect(setRmClassification(admin, { staffId: rm, segment: "DBC", reason: REASON })).rejects.toThrow(/DBC region/);
    await expect(setRmClassification(admin, { staffId: rm, segment: "NON_DBC", reason: REASON })).rejects.toThrow(/Regional Business Executive/);
    await expect(setRmClassification(admin, { staffId: rm, segment: "NON_DBC", rbeId: await sid("unit.head@altbank.ng"), reason: REASON })).rejects.toThrow(/not an active Regional Business Executive/);
    await expect(setRmClassification(admin, { staffId: rm, segment: "DBC", dbcRegion: "NORTH", reason: "short" })).rejects.toThrow(/reason/);
    await expect(setRmClassification(await ctxFor("rm.bola@altbank.ng"), { staffId: rm, segment: "DBC", dbcRegion: "NORTH", reason: REASON })).rejects.toBeInstanceOf(DomainError);
    await nonDbc("rm.ade@altbank.ng");
    await setRmClassification(admin, { staffId: rm, segment: "DBC", dbcRegion: "SOUTH_WEST", reason: "Moved to DBC South & West after restructuring." });
    const a = await audits("RM_CLASSIFICATION_CHANGED");
    expect(a.length).toBe(2);
    expect(a[1].details.previous.segment).toBe("NON_DBC");
    expect(a[1].details.next).toMatchObject({ segment: "DBC", dbcRegion: "SOUTH_WEST", rbeId: null });
    expect((await db.query("SELECT 1 FROM org_links WHERE staff_id = $1 AND relation = 'RBE'", [rm])).rowCount).toBe(0);
  });

  it("unclassified RMs are flagged for the Super Admin; a configured Unit Head must hold the Unit Head role", async () => {
    expect((await classificationGaps(db)).some((g) => g.full_name === "Ade Okafor")).toBe(true);
    await nonDbc("rm.ade@altbank.ng");
    expect((await classificationGaps(db)).some((g) => g.full_name === "Ade Okafor")).toBe(false);
    await expect(setRoutingAssignment(admin, { key: "ECOMMERCE_UNIT_HEAD", staffId: await sid("rbe.lagos@altbank.ng"), reason: REASON })).rejects.toThrow(/Unit Head/);
    await ecom();
    expect((await audits("ROUTING_ASSIGNMENT_CHANGED")).length).toBe(1);
  });
});

describe("Non-DBC route: RM → RBE → CX → Credit Officer → E-commerce Unit Head → Divisional Head", () => {
  it("WakeelBoost follows the confirmed sequence; the RM cannot pick another RBE; no Product Manager stage", async () => {
    await nonDbc("rm.ade@altbank.ng");
    await ecom();
    // The RM's form names rbe.lagos, but the request goes to the RBE the Super Admin assigned.
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000), rbeEmail: "rbe.lagos@altbank.ng" });
    let t = await openTaskOf(id);
    expect([t.stage, t.email]).toEqual(["BUSINESS_ENDORSEMENT", "rbe.abuja@altbank.ng"]);
    await act(id, "ENDORSE", { reason: "RBE review complete." });
    t = await openTaskOf(id);
    expect([t.stage, t.email]).toEqual(["CX_CREDIT_REVIEW", "cx.one@altbank.ng"]);
    await expect(act(id, "RECOMMEND", { reason: "" })).rejects.toBeInstanceOf(DomainError); // remarks are mandatory
    await act(id, "RECOMMEND", RECOMMEND);
    t = await openTaskOf(id);
    expect(t.stage).toBe("FIRST_CREDIT_REVIEW");
    expect(t.assignee_role).toBe("CREDIT_OFFICER_1"); // ₦1m: the lowest configured band
    await approveFirstReview(id);
    await act(id, "APPROVE"); // concurrence (route 1)
    t = await openTaskOf(id);
    expect([t.stage, t.email]).toEqual(["UNIT_HEAD_REVIEW", "ecom.uh@altbank.ng"]);
    await act(id, "APPROVE");
    expect((await openTaskOf(id)).stage).toBe("DIVISIONAL_HEAD_REVIEW");
    await act(id, "APPROVE");
    expect((await openTaskOf(id)).stage).toBe("OFFER_PREPARATION");
    expect(await stages(id)).toEqual(["BUSINESS_ENDORSEMENT", "CX_CREDIT_REVIEW", "FIRST_CREDIT_REVIEW", "SECOND_CREDIT_REVIEW", "UNIT_HEAD_REVIEW", "DIVISIONAL_HEAD_REVIEW", "OFFER_PREPARATION"]);
    const a = await app(id);
    expect(a.routing_segment).toBe("NON_DBC");
    expect(a.selected_rbe_id).toBe(await sid("rbe.abuja@altbank.ng"));
    expect(a.cx_reviewer_id).toBe(await sid("cx.one@altbank.ng"));
  });

  it("higher amounts go to the Credit Officer for their band (exact boundaries)", async () => {
    await nonDbc("rm.ade@altbank.ng");
    for (const [amount, role] of [
      [5_000_000, "CREDIT_OFFICER_1"],
      [5_000_001, "CREDIT_OFFICER_2"],
      [20_000_001, "CREDIT_OFFICER_3"],
    ] as const) {
      const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(amount) });
      await act(id, "ENDORSE", { reason: "RBE review complete." });
      await act(id, "RECOMMEND", RECOMMEND);
      expect((await openTaskOf(id)).assignee_role).toBe(role);
    }
  });

  it("CX can return the request; the resubmission goes back to the same CX reviewer", async () => {
    await nonDbc("rm.ade@altbank.ng");
    await addStaff("cx.two@altbank.ng", "Bola CX-Reviewer", "CX_CREDIT_REVIEWER"); // another CX reviewer must never take it
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) });
    await act(id, "ENDORSE", { reason: "RBE review complete." });
    await act(id, "RETURN", { reason: "Provide the latest bank statement." });
    expect((await openTaskOf(id)).stage).toBe("INITIATOR_CORRECTION");
    await act(id, "RESUBMIT");
    const back = await openTaskOf(id);
    expect(back.stage).toBe("CX_CREDIT_REVIEW");
    expect(back.email).toBe("cx.one@altbank.ng");
    expect((await app(id)).cx_reviewer_id).toBe(await sid("cx.one@altbank.ng"));
  });

  it("without a configured E-commerce Unit Head the stage waits for the Super Admin; no other Unit Head is used", async () => {
    await nonDbc("rm.ade@altbank.ng");
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) });
    await act(id, "ENDORSE", { reason: "RBE review complete." });
    await act(id, "RECOMMEND", RECOMMEND);
    await approveFirstReview(id);
    await act(id, "APPROVE");
    const t = await openTaskOf(id);
    expect([t.stage, t.assignee_id]).toEqual(["UNIT_HEAD_REVIEW", null]);
  });

  it("a Non-DBC RM whose RBE is no longer active cannot submit (the RBE stage is never bypassed)", async () => {
    await nonDbc("rm.ade@altbank.ng");
    await db.query("UPDATE role_assignments SET active = false WHERE staff_id = $1 AND role = 'RBE'", [await sid("rbe.abuja@altbank.ng")]);
    await expect(createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) })).rejects.toThrow(/Regional Business Executive/);
  });

  it("retail (Vendor Financing): RBE → CX → Credit Officer by amount, whatever the product's business policy", async () => {
    await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING", (c) => (c.approvalPolicy = "RETAIL_CX_V1")));
    await nonDbc("rm.bola@altbank.ng", "rbe.lagos@altbank.ng");
    await ecom();
    const id = await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(2_000_000), tenorMonths: 12, incomeBasisKobo: N(10_000_000), proposedMonthlyKobo: N(200_000) });
    let t = await openTaskOf(id);
    expect([t.stage, t.email]).toEqual(["BUSINESS_ENDORSEMENT", "rbe.lagos@altbank.ng"]);
    await act(id, "ENDORSE", { reason: "RBE review complete." });
    t = await openTaskOf(id);
    expect([t.stage, t.email]).toEqual(["CX_CREDIT_REVIEW", "cx.one@altbank.ng"]);
    await act(id, "RECOMMEND", RECOMMEND);
    t = await openTaskOf(id);
    expect([t.stage, t.assignee_role]).toEqual(["FIRST_CREDIT_REVIEW", "CREDIT_OFFICER_1"]);
    expect((await app(id)).approval_policy).toBe("STANDARD");
    await recordFinal(id);
    await act(id, "APPROVE");
    await act(id, "APPROVE");
    t = await openTaskOf(id);
    expect([t.stage, t.email]).toEqual(["UNIT_HEAD_REVIEW", "ecom.uh@altbank.ng"]);
    await act(id, "APPROVE");
    await act(id, "APPROVE");
    expect((await openTaskOf(id)).stage).toBe("OFFER_PREPARATION");
    expect(await stages(id)).not.toContain("TEAM_LEAD_REVIEW");
  });
});

describe("DBC route: existing stage order, regional Unit Head", () => {
  it("DBC North and South & West requests go to their configured Unit Head", async () => {
    await setRoutingAssignment(admin, { key: "DBC_UNIT_HEAD_NORTH", staffId: await sid("dbc.north@altbank.ng"), reason: REASON });
    await setRoutingAssignment(admin, { key: "DBC_UNIT_HEAD_SOUTH_WEST", staffId: await sid("dbc.sw@altbank.ng"), reason: REASON });
    for (const [region, uh] of [
      ["NORTH", "dbc.north@altbank.ng"],
      ["SOUTH_WEST", "dbc.sw@altbank.ng"],
    ] as const) {
      await setRmClassification(admin, { staffId: await sid("rm.ade@altbank.ng"), segment: "DBC", dbcRegion: region, reason: REASON });
      const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) });
      const t0 = await openTaskOf(id);
      expect([t0.stage, t0.email]).toEqual(["BUSINESS_ENDORSEMENT", "rbe.lagos@altbank.ng"]); // the existing DBC route is unchanged
      await act(id, "ENDORSE");
      await approveFirstReview(id);
      await act(id, "APPROVE");
      const t = await openTaskOf(id);
      expect([t.stage, t.email]).toEqual(["UNIT_HEAD_REVIEW", uh]);
      expect(await stages(id)).not.toContain("CX_CREDIT_REVIEW");
    }
  });

  it("a request keeps the routing pinned at submission when the RM is later reclassified", async () => {
    await nonDbc("rm.ade@altbank.ng");
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) });
    await setRmClassification(admin, { staffId: await sid("rm.ade@altbank.ng"), segment: "DBC", dbcRegion: "NORTH", reason: "Moved to DBC North." });
    await act(id, "ENDORSE", { reason: "RBE review complete." });
    expect((await openTaskOf(id)).stage).toBe("CX_CREDIT_REVIEW");
  });

  it("an unclassified RM keeps the route in force before classification", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) });
    expect((await app(id)).routing_segment).toBeNull();
    await act(id, "ENDORSE");
    expect((await openTaskOf(id)).stage).toBe("FIRST_CREDIT_REVIEW");
  });
});

describe("Route simulation", () => {
  it("shows the Non-DBC sequence with no Product Manager stage", () => {
    for (const fam of ["WAKEELBOOST", "RETAIL"] as const) {
      const r = planRoute(defaultDefinition(fam), { amountKobo: N(1_000_000), initiatorRole: "RM", policy: "RETAIL_CX_V1", segment: "NON_DBC" });
      expect(r.stages.map((s) => s.stage)).toEqual(["BUSINESS_ENDORSEMENT", "CX_CREDIT_REVIEW", "FIRST_CREDIT_REVIEW", "SECOND_CREDIT_REVIEW", "UNIT_HEAD_REVIEW", "DIVISIONAL_HEAD_REVIEW"]);
      expect(r.stages.find((s) => s.stage === "UNIT_HEAD_REVIEW")!.name).toBe("E-commerce Unit Head approval");
    }
  });
});
