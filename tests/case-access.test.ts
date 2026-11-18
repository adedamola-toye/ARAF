import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { createSubmittedCase, ctxFor } from "@/server/demo/scenario";
import { createDraft } from "@/server/domain/workflow";
import { getCase } from "@/server/domain/views";
import { caseAccess } from "@/server/domain/access";
import { setOrgLink } from "@/server/domain/org";
import { setRmClassification } from "@/server/domain/rm-routing";
import { financingFacts, reportScope } from "@/server/performance-report";
import { act, driveToOffer, openTaskOf } from "@/server/demo/scenario";
import { reviewedRequests } from "@/server/domain/views";
import { adminAssignTask } from "@/server/domain/admin";

const N = (n: number) => n * 100;
const ADMIN = "superadmin@altbank.ng";
const REASON = "Reporting line set by the business owner.";
const sid = async (email: string) => (await db.query("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id as string;
async function staff(email: string, name: string, role: string, extra: { region?: string; team?: string } = {}) {
  const id = (await db.query("INSERT INTO staff (email, full_name) VALUES ($1,$2) RETURNING id", [email, name])).rows[0].id as string;
  await db.query("INSERT INTO role_assignments (staff_id, role, region, team) VALUES ($1,$2,$3,$4)", [id, role, extra.region ?? null, extra.team ?? null]);
  return id;
}
const view = async (staffId: string, appId: string) => (await caseAccess(db, staffId, appId)).capacities;

beforeEach(resetDb);

describe("Who can open a request", () => {
  it("RM → Team Lead → Unit Head: the Unit Head the Team Lead reports to sees the team's requests (read only)", async () => {
    const uh = await staff("uh.lagos@altbank.ng", "Lola Unit-Head", "UNIT_HEAD");
    const tl = await staff("tl.wb@altbank.ng", "Tayo Team-Lead", "TEAM_LEAD", { team: "RETAIL-LAGOS-1" }); // rm.ade's team
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) });
    expect(await view(uh, id)).toEqual([]); // not yet in the Unit Head's line
    await setOrgLink(await ctxFor(ADMIN), { staffId: tl, relation: "UNIT_HEAD", managerId: uh, reason: REASON });
    expect(await view(uh, id)).toContain("SUPERVISOR");
    expect(await view(tl, id)).toContain("SUPERVISOR"); // the Team Lead sees their RM's WakeelBoost request too
    await expect(getCase(await ctxFor("uh.lagos@altbank.ng"), id)).resolves.toBeTruthy();
    // A Unit Head with nobody mapped to them still cannot open it.
    const other = await staff("uh.other@altbank.ng", "Other Unit-Head", "UNIT_HEAD");
    await expect(getCase(await ctxFor("uh.other@altbank.ng"), id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await view(other, id)).toEqual([]);
  });

  it("an RM mapped directly to a Unit Head, and requests in the Unit Head's region, are visible; drafts are not", async () => {
    const uh = await staff("uh.direct@altbank.ng", "Dami Unit-Head", "UNIT_HEAD");
    await setOrgLink(await ctxFor(ADMIN), { staffId: await sid("rm.ade@altbank.ng"), relation: "UNIT_HEAD", managerId: uh, reason: REASON });
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) });
    expect(await view(uh, id)).toContain("SUPERVISOR");
    const draft = await createDraft(await ctxFor("rm.ade@altbank.ng"), { initiatorRole: "RM", applicantType: "INDIVIDUAL" });
    expect(await view(uh, draft.id)).toEqual([]);
    // Region on the Unit Head role.
    const region = (await db.query("SELECT region FROM applications WHERE id = $1", [id])).rows[0].region as string;
    const regional = await staff("uh.region@altbank.ng", "Regional Unit-Head", "UNIT_HEAD", { region });
    expect(await view(regional, id)).toContain("SUPERVISOR");
  });

  it("the Super Admin sees every request, including drafts", async () => {
    const admin = await sid(ADMIN);
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) });
    const draft = await createDraft(await ctxFor("rm.ade@altbank.ng"), { initiatorRole: "RM", applicantType: "INDIVIDUAL" });
    expect(await view(admin, id)).toContain("SUPER_ADMIN");
    expect(await view(admin, draft.id)).toContain("SUPER_ADMIN");
    await expect(getCase(await ctxFor(ADMIN), id)).resolves.toBeTruthy();
  });

  it("the Divisional Head sees their Unit Heads' areas; an RBE sees their Relationship Managers' requests", async () => {
    const admin = await ctxFor(ADMIN);
    const uh = await staff("uh.div@altbank.ng", "Femi Unit-Head", "UNIT_HEAD");
    const dh = await staff("dh.div@altbank.ng", "Second Divisional-Head", "DIVISIONAL_HEAD");
    await setOrgLink(admin, { staffId: await sid("rm.ade@altbank.ng"), relation: "UNIT_HEAD", managerId: uh, reason: REASON });
    await setOrgLink(admin, { staffId: uh, relation: "DIVISIONAL_HEAD", managerId: dh, reason: REASON });
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) });
    expect(await view(dh, id)).toContain("SUPERVISOR");
    await setRmClassification(admin, { staffId: await sid("rm.ade@altbank.ng"), segment: "NON_DBC", rbeId: await sid("rbe.abuja@altbank.ng"), reason: REASON });
    expect(await view(await sid("rbe.abuja@altbank.ng"), id)).toContain("SUPERVISOR");
  });

  it("every facility in a Unit Head's performance report can be opened by that Unit Head", async () => {
    const uh = await staff("uh.rep@altbank.ng", "Rep Unit-Head", "UNIT_HEAD");
    const tl = await staff("tl.rep@altbank.ng", "Rep Team-Lead", "TEAM_LEAD", { team: "RETAIL-LAGOS-1" });
    await setOrgLink(await ctxFor(ADMIN), { staffId: tl, relation: "UNIT_HEAD", managerId: uh, reason: REASON });
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) });
    await createSubmittedCase({ initiator: "MERCHANT_OFFICER", amountKobo: N(500_000) }); // outside the unit
    const facts = await financingFacts(db, await reportScope(db, uh));
    expect(facts.map((f) => f.id)).toEqual([id]);
    for (const f of facts) expect((await caseAccess(db, uh, f.id)).canView).toBe(true);
  });

  it("with nothing configured, the Unit Head and RBE who approved a request can follow it to disbursement", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) });
    const rbe = await sid("rbe.lagos@altbank.ng"); // the RBE named on the request
    expect(await view(rbe, id)).toContain("APPROVER"); // from submission
    await driveToOffer(id); // RBE → credit → Unit Head → Divisional Head
    const uh = await sid("unit.head@altbank.ng");
    expect(await view(uh, id)).toContain("APPROVER");
    // Their list shows where it is now.
    const mine = await reviewedRequests(db, uh);
    expect(mine.map((r) => [r.id, r.stage, (r.my_decision as { stage: string }).stage])).toEqual([[id, "OFFER_PREPARATION", "UNIT_HEAD_REVIEW"]]);
    expect((await reviewedRequests(db, rbe)).map((r) => r.id)).toEqual([id]);
    // Their performance report includes it, with no reporting lines set.
    expect((await financingFacts(db, await reportScope(db, uh))).map((f) => f.id)).toEqual([id]);
    expect((await financingFacts(db, await reportScope(db, rbe))).map((f) => f.id)).toEqual([id]);
  });

  it("someone whose task was reassigned to another officer keeps read access", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000) });
    await act(id, "ENDORSE");
    const t = await openTaskOf(id);
    const first = t.assignee_id!;
    const others = (await db.query("SELECT ra.staff_id FROM role_assignments ra WHERE ra.role = $1 AND ra.active AND ra.staff_id <> $2", [t.assignee_role, first])).rows;
    if (!others.length) {
      const extra = await staff("co.extra@altbank.ng", "Extra Credit-Officer", t.assignee_role);
      others.push({ staff_id: extra });
    }
    await adminAssignTask(await ctxFor(ADMIN), t.id, others[0].staff_id, "Rebalancing the credit queue for leave.");
    expect(await view(first, id)).toContain("APPROVER");
  });
});

