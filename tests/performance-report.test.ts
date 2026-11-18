import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { act, createSubmittedCase, ctxFor } from "@/server/demo/scenario";
import { setOrgLink } from "@/server/domain/org";
import { actionsByPerformer, altphonesFacts, financingFacts, groupAlt, groupFacts, officerPerformance, reportScope, toCsv, trend } from "@/server/performance-report";
import { setRmClassification, setRoutingAssignment } from "@/server/domain/rm-routing";

const N = (n: number) => n * 100;
const ADMIN = "superadmin@altbank.ng";
const sid = async (email: string) => (await db.query("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id as string;
async function staff(email: string, name: string, role: string) {
  const id = (await db.query("INSERT INTO staff (email, full_name) VALUES ($1,$2) RETURNING id", [email, name])).rows[0].id;
  await db.query("INSERT INTO role_assignments (staff_id, role) VALUES ($1,$2)", [id, role]);
  return id as string;
}

beforeEach(resetDb);

describe("Reporting scope", () => {
  it("God's Eye and Super Admin see everything; a Unit Head sees their mapped staff; a Divisional Head their Unit Heads' staff; unmapped heads are told why", async () => {
    expect((await reportScope(db, await sid(ADMIN))).kind).toBe("ALL");
    const uh = await staff("uh.report@altbank.ng", "Uche Unit-Head", "UNIT_HEAD");
    const dh = await staff("dh.report@altbank.ng", "Dayo Div-Head", "DIVISIONAL_HEAD");
    expect(await financingFacts(db, await reportScope(db, uh))).toEqual([]); // nothing approved, nobody mapped yet
    const admin = await ctxFor(ADMIN);
    await setOrgLink(admin, { staffId: await sid("mo.chi@altbank.ng"), relation: "UNIT_HEAD", managerId: uh, reason: "Chioma reports to Uche for reporting." });
    await setOrgLink(admin, { staffId: uh, relation: "DIVISIONAL_HEAD", managerId: dh, reason: "Uche's unit is in Dayo's division." });
    const mo = await createSubmittedCase({ initiator: "MERCHANT_OFFICER", amountKobo: N(1_000_000) });
    const other = await createSubmittedCase({ initiator: "RM", amountKobo: N(2_000_000) });
    const uhFacts = await financingFacts(db, await reportScope(db, uh));
    expect(uhFacts.map((f) => f.id)).toEqual([mo]);
    expect(uhFacts[0]).toMatchObject({ unitHead: "Uche Unit-Head", division: "Dayo Div-Head", officer: "Chioma Nwosu" });
    expect((await financingFacts(db, await reportScope(db, dh))).map((f) => f.id)).toEqual([mo]);
    const all = await financingFacts(db, await reportScope(db, await sid(ADMIN)));
    expect(all.map((f) => f.id).sort()).toEqual([mo, other].sort());
  });
});

describe("Attribution and drill-down", () => {
  it("credits the facility to its originator once, and each review to the person who performed it", async () => {
    const id = await createSubmittedCase({ initiator: "MERCHANT_OFFICER", amountKobo: N(1_000_000) });
    await act(id, "ENDORSE", { reason: "Endorsed after review." });
    await act(id, "ENDORSE", { reason: "Head review completed." });
    const facts = await financingFacts(db, { kind: "ALL" });
    const byOfficer = groupFacts(facts, "officer");
    expect(byOfficer).toHaveLength(1);
    expect(byOfficer[0]).toMatchObject({ key: "Chioma Nwosu", requests: 1, requestedKobo: N(1_000_000) });
    const byProduct = groupFacts(facts, "product");
    expect(byProduct[0]).toMatchObject({ key: "WakeelBoost", requests: 1 });
    expect(facts[0].moLead).not.toBe("—");
    const perf = await actionsByPerformer(db, [id]);
    expect(perf.map((p) => p.performer)).not.toContain("Chioma Nwosu");
    expect(perf.length).toBe(2); // the Lead's endorsement and the Head's review, each to its own person
  });

  it("CSV export neutralises spreadsheet formulas", () => {
    expect(toCsv([{ a: "=SUM(A1)", b: "x,y" }])).toBe('a,b\n\'=SUM(A1),"x,y"');
  });
});

describe("AltPhones: per person and per location at the time of sale", () => {
  it("shows each Smile Associate's own transactions; a later move does not rewrite history", async () => {
    const loc = (await db.query("SELECT id FROM locations WHERE name = 'AltLounge Alaba Lagos'")).rows[0].id;
    const sa1 = await staff("sa.one@altbank.ng", "Sade One", "SMILE_ASSOCIATE");
    const sa2 = await staff("sa.two@altbank.ng", "Sola Two", "SMILE_ASSOCIATE");
    const ins = (originator: string, ref: string, status: string, fin: number) =>
      db.query(
        `INSERT INTO altphones_applications (ref, kind, channel, status, originator_id, originator_role, origin_location_id, financed_kobo, down_payment_kobo, model_name, created_at, submitted_at, settings_id)
         VALUES ($1,'CREDIT','SA',$2,$3,'SMILE_ASSOCIATE',$4,$5,$6,'Model X',now(),now(),(SELECT id FROM altphones_settings ORDER BY 1 LIMIT 1))`,
        [ref, status, originator, loc, fin, N(29_000)],
      );
    await ins(sa1, "AP-T-1", "DISBURSED", N(116_000));
    await ins(sa1, "AP-T-2", "UNDER_PM_REVIEW", N(116_000));
    await ins(sa2, "AP-T-3", "COMPLETED", N(116_000));
    const facts = await altphonesFacts(db, { kind: "ALL" });
    const byOfficer = groupAlt(facts, "officer");
    expect(byOfficer.find((g) => g.key === "Sade One")).toMatchObject({ transactions: 2, completed: 1, pending: 1 });
    expect(byOfficer.find((g) => g.key === "Sola Two")).toMatchObject({ transactions: 1, completed: 1 });
    expect(groupAlt(facts, "location").find((g) => g.key === "AltLounge Alaba Lagos")?.transactions).toBe(3);
    // Sade moves to another location: her earlier sales stay with the location they were made at.
    const other = (await db.query("SELECT id FROM locations WHERE name <> 'AltLounge Alaba Lagos' LIMIT 1")).rows[0].id;
    await db.query("INSERT INTO altphones_applications (ref, kind, channel, status, originator_id, originator_role, origin_location_id, financed_kobo, down_payment_kobo, model_name, created_at, submitted_at, settings_id) VALUES ('AP-T-4','CREDIT','SA','UNDER_BPM_REVIEW',$1,'SMILE_ASSOCIATE',$2,0,0,'Model X',now(),now(),(SELECT id FROM altphones_settings ORDER BY 1 LIMIT 1))", [sa1, other]);
    const after = await altphonesFacts(db, { kind: "ALL" });
    expect(groupAlt(after, "location").find((g) => g.key === "AltLounge Alaba Lagos")?.transactions).toBe(3);
  });
});

describe("Location correction", () => {
  it("AltLounge Allen Lagos 2 is now AltLounge Alaba Lagos: same record, no duplicate", async () => {
    const rows = (await db.query("SELECT name FROM locations WHERE name ILIKE '%alaba%' OR name = 'AltLounge Allen Lagos 2'")).rows.map((r) => r.name);
    expect(rows).toEqual(["AltLounge Alaba Lagos"]);
    expect((await db.query("SELECT 1 FROM locations WHERE name = 'AltLounge Allen Lagos 1'")).rowCount).toBe(1);
  });
});

describe("Business lines, RBE and DBC Unit Head reporting", () => {
  it("attributes Non-DBC requests to the RBE, DBC requests to the regional Unit Head, and scopes each to their own", async () => {
    const admin = await ctxFor(ADMIN);
    const reason = "Business owner instruction for reporting.";
    const north = await staff("dbc.north.r@altbank.ng", "Musa North", "UNIT_HEAD");
    await setRoutingAssignment(admin, { key: "DBC_UNIT_HEAD_NORTH", staffId: north, reason });
    await setRmClassification(admin, { staffId: await sid("rm.ade@altbank.ng"), segment: "NON_DBC", rbeId: await sid("rbe.abuja@altbank.ng"), businessUnit: "Commercial", reason });
    const nd = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) });
    await setRmClassification(admin, { staffId: await sid("rm.ade@altbank.ng"), segment: "DBC", dbcRegion: "NORTH", businessUnit: "DBC", reason });
    const dbc = await createSubmittedCase({ initiator: "RM", amountKobo: N(2_000_000) });
    const mo = await createSubmittedCase({ initiator: "MERCHANT_OFFICER", amountKobo: N(500_000) });
    const all = await financingFacts(db, { kind: "ALL" });
    const by = (id: string) => all.find((f) => f.id === id)!;
    expect(by(nd)).toMatchObject({ segment: "Non-DBC", rbe: "Hauwa Sani", reportingHead: "Hauwa Sani" });
    expect(by(dbc)).toMatchObject({ segment: "DBC", region: "DBC North", reportingHead: "Musa North", rbe: "—" });
    expect(by(mo).segment).toBe("Merchant Officer line");
    // Totals reconcile across business lines without double counting.
    const lines = groupFacts(all, "segment");
    expect(lines.reduce((s, g) => s + g.requestedKobo, 0)).toBe(all.reduce((s, f) => s + f.requestedKobo, 0));
    // The DBC North Unit Head sees the DBC RM's work (the RM is currently DBC North); the RBE keeps only the request they approved.
    const uhScope = await reportScope(db, north);
    expect(uhScope.kind).toBe("STAFF");
    expect((await financingFacts(db, uhScope)).map((f) => f.id).sort()).toEqual([nd, dbc].sort());
    // The RBE keeps the request they were the named approver for, but not the RM's later DBC request.
    expect((await financingFacts(db, await reportScope(db, await sid("rbe.abuja@altbank.ng")))).map((f) => f.id)).toEqual([nd]);
    // Dimension filters.
    expect((await financingFacts(db, { kind: "ALL" }, { dims: { segment: "Non-DBC" } })).map((f) => f.id)).toEqual([nd]);
  });

  it("an RBE sees the RMs assigned to them; officer rows and the trend reconcile with the facts", async () => {
    const admin = await ctxFor(ADMIN);
    await setRmClassification(admin, { staffId: await sid("rm.ade@altbank.ng"), segment: "NON_DBC", rbeId: await sid("rbe.lagos@altbank.ng"), reason: "Ade reports to Tunde as RBE." });
    const a = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) });
    await createSubmittedCase({ initiator: "MERCHANT_OFFICER", amountKobo: N(700_000) });
    const facts = await financingFacts(db, await reportScope(db, await sid("rbe.lagos@altbank.ng")));
    expect(facts.map((f) => f.id)).toEqual([a]);
    const rows = officerPerformance(facts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ officer: "Ade Okafor", requests: 1, requestedKobo: N(1_000_000), slaOnTimePercent: 100 });
    const t = trend(facts);
    expect(t.grain).toBe("day");
    expect(t.points.reduce((s, p) => s + p.requestedKobo, 0)).toBe(N(1_000_000));
  });
});
