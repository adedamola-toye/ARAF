import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { audits, outbox, resetDb } from "./helpers";
import { act, approveFirstReview, createSubmittedCase, ctxFor, driveToOffer } from "@/server/demo/scenario";
import { dhPeriodFor, duePeriod, runDhWeeklyReport, sendDhTestReport } from "@/server/jobs/dh-weekly";
import { updateDhWeeklySchedule } from "@/server/domain/admin";
import { setOrgLink } from "@/server/domain/org";
import { setRmClassification } from "@/server/domain/rm-routing";

const N = (n: number) => n * 100;
const sid = async (email: string) => (await db.query("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id as string;

beforeEach(resetDb);

/** The Week and MTD figures under a person's name row in the plain-text report: [requests, requested, disbursed, (altphones), decisions, actions]. */
function figures(body: string, label: string, from = 0) {
  const lines = body.slice(from).split("\n");
  const i = lines.findIndex((l) => l.trim().startsWith(label));
  if (i < 0) throw new Error(`No row for ${label}`);
  const nums = (l: string) => l.trim().split(/\s{2,}/).slice(1);
  return { label: lines[i].trim(), week: nums(lines[i + 1]), mtd: nums(lines[i + 2]) };
}

describe("Weekly Divisional Head report: timing", () => {
  it("is due every Sunday at 18:00 Africa/Lagos (17:00 UTC), covering Monday to Sunday and month to date", () => {
    const p = dhPeriodFor(new Date("2026-11-18T10:00:00Z"), 18, 0); // a Wednesday
    expect(p.sendAt.toISOString()).toBe("2026-11-22T17:00:00.000Z");
    expect(p.weekStart.toISOString()).toBe("2026-11-15T23:00:00.000Z"); // Monday 16 Nov 00:00 Lagos
    expect(p.monthStart.toISOString()).toBe("2026-10-31T23:00:00.000Z"); // 1 Nov 00:00 Lagos
    expect([p.key, p.fromWeek, p.fromMonth, p.to]).toEqual(["D2026-11-22", "2026-11-16", "2026-11-01", "2026-11-22"]);
    expect(duePeriod(new Date("2026-11-22T16:59:00Z"), 18, 0)).toBeNull(); // Sunday 17:59 Lagos
    expect(duePeriod(new Date("2026-11-22T17:01:00Z"), 18, 0)?.key).toBe("D2026-11-22");
    expect(duePeriod(new Date("2026-11-23T08:00:00Z"), 18, 0)?.key).toBe("D2026-11-22"); // Monday morning: caught up
    expect(duePeriod(new Date("2026-11-26T08:00:00Z"), 18, 0)).toBeNull(); // more than three days late
  });
});

describe("Weekly Divisional Head report: delivery", () => {
  it("emails every Divisional Head once with the week and month-to-date figures; reruns send nothing new", async () => {
    const now = new Date();
    const a = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000), now });
    await createSubmittedCase({ initiator: "MERCHANT_OFFICER", amountKobo: N(2_000_000), now });
    await driveToOffer(a, now);
    const second = (await db.query("INSERT INTO staff (email, full_name) VALUES ('dh.two@altbank.ng','Second Divisional-Head') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO role_assignments (staff_id, role) VALUES ($1,'DIVISIONAL_HEAD')", [second]);
    const runAt = new Date(dhPeriodFor(now, 18, 0).sendAt.getTime() + 5 * 60_000);
    const r = await runDhWeeklyReport(runAt);
    expect(r).toMatchObject({ ran: true, sent: 2 });
    const mails = await outbox("DH_WEEKLY_REPORT");
    expect(mails.map((m) => m.to_addresses[0]).sort()).toEqual(["dh.two@altbank.ng", "div.head@altbank.ng"]);
    const body: string = mails[0].body_text;
    for (const section of ["1. FINANCING HEADLINES", "2a. BY BUSINESS LINE", "2b. BY PRODUCT", "3. APPROVAL EFFICIENCY", "4. PIPELINE NOW", "5. CONTROLS", "6. DECISIONS BY STAGE", "7. ALTPHONES AND STAFF SALARY ADVANCE", "8. UNITS AND TEAMS — CUMULATIVE FIGURES"])
      expect(body).toContain(section);
    expect(body).toMatch(/Requests submitted\s+2 · ₦3,000,000\s+2 · ₦3,000,000/);
    expect(body).toMatch(/Final approvals\s+1 · ₦1,000,000/);
    expect(body).toContain("/reports/performance?from=");
    expect(body).not.toMatch(/\d{11}/); // no BVNs or phone numbers
    expect(mails[0].subject).toContain("weekly report");
    const html: string = mails[0].body_html;
    expect(html).toContain("<table");
    expect(html).toContain("Open the Performance Overview");
    expect(html).toContain("FINANCING HEADLINES");
    expect((await runDhWeeklyReport(new Date(runAt.getTime() + 60_000))).ran).toBe(false);
    expect((await outbox("DH_WEEKLY_REPORT")).length).toBe(2);
    expect((await audits("DH_WEEKLY_REPORT_RUN")).length).toBe(1);
  });

  it("the Divisional Head gets unit totals only; each Unit Head gets their team's individual figures", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    const uh = await sid("unit.head@altbank.ng");
    await setOrgLink(admin, { staffId: await sid("rm.ade@altbank.ng"), relation: "UNIT_HEAD", managerId: uh, reason: "Ade reports to Olu for reporting." });
    const now = new Date();
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_500_000), now });
    await driveToOffer(id, now); // includes a Unit Head approval
    const lonely = (await db.query("INSERT INTO staff (email, full_name) VALUES ('uh.two@altbank.ng','Second Unit-Head') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO role_assignments (staff_id, role) VALUES ($1,'UNIT_HEAD')", [lonely]);
    const r = await runDhWeeklyReport(new Date(dhPeriodFor(now, 18, 0).sendAt.getTime() + 60_000));
    // Divisional Head: the unit as a whole (Unit Head + Ade), no individual rows.
    const body: string = (await outbox("DH_WEEKLY_REPORT"))[0].body_text;
    const unit = figures(body, "Olu Unit-Head's unit — Unit Head + 1 direct report");
    expect(unit.week.slice(0, 3)).toEqual(["1", "₦1,500,000", "₦0"]);
    expect(Number(unit.week[3])).toBeGreaterThanOrEqual(1); // the Unit Head's approval
    expect(body).toContain("Second Unit-Head's unit — Unit Head + 0 direct reports");
    expect(body).not.toContain("Ade Okafor —");
    expect(body).not.toContain("own work");
    const all = figures(body, "ALL STAFF");
    expect(all.week.slice(0, 2)).toEqual(["1", "₦1,500,000"]);
    // Unit Heads and Team Leads: individual figures for their own team.
    const team = await outbox("TEAM_WEEKLY_REPORT");
    expect(r.teamSent).toBe(team.length);
    const olu = team.find((m) => m.to_addresses[0] === "unit.head@altbank.ng")!;
    expect(figures(olu.body_text, "Olu Unit-Head — Unit Head, own work").week[3]).toBe("1");
    const ade = figures(olu.body_text, "Ade Okafor — Relationship Manager · not yet classified");
    expect(ade.week.slice(0, 3)).toEqual(["1", "₦1,500,000", "₦0"]);
    expect(figures(olu.body_text, "TEAM TOTAL").week[0]).toBe("1");
    expect(olu.body_html).toContain("YOUR TEAM");
    const second = team.find((m) => m.to_addresses[0] === "uh.two@altbank.ng")!;
    expect(second.body_text).toContain("No direct reports are mapped to you yet");
    // Team Leads: the Relationship Managers on their team.
    const tl = team.find((m) => m.to_addresses[0] === "tl.lagos@altbank.ng")!;
    expect(tl.body_text).toMatch(/Bola Adisa — Relationship Manager/);
    // Reruns never send a second copy.
    await runDhWeeklyReport(new Date(dhPeriodFor(now, 18, 0).sendAt.getTime() + 120_000));
    expect((await outbox("TEAM_WEEKLY_REPORT")).length).toBe(team.length);
  });

  it("unit totals cover Non-DBC teams, the Merchant Officer line and every other function, with an all-staff total", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    await setRmClassification(admin, { staffId: await sid("rm.ade@altbank.ng"), segment: "NON_DBC", rbeId: await sid("rbe.lagos@altbank.ng"), reason: "Ade is a Non-DBC RM under Tunde." });
    const now = new Date();
    const cx = (await db.query("INSERT INTO staff (email, full_name) VALUES ('cx.r@altbank.ng','Ada CX-Reviewer') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO role_assignments (staff_id, role) VALUES ($1,'CX_CREDIT_REVIEWER')", [cx]);
    const nd = await createSubmittedCase({ initiator: "RM", amountKobo: N(2_000_000), now });
    await act(nd, "ENDORSE", { reason: "RBE review complete." }, now);
    await act(nd, "RECOMMEND", { reason: "CX review complete; recommend." }, now);
    await approveFirstReview(nd, now);
    await runDhWeeklyReport(new Date(dhPeriodFor(now, 18, 0).sendAt.getTime() + 60_000));
    const body: string = (await outbox("DH_WEEKLY_REPORT"))[0].body_text;
    const rbe = figures(body, "Tunde Adeyemi's Non-DBC team — RBE + 1 Relationship Manager");
    expect(rbe.week.slice(0, 2)).toEqual(["1", "₦2,000,000"]);
    expect(rbe.week[3]).toBe("1"); // the RBE's approval
    expect(body).toMatch(/Relationship Managers not yet classified as DBC or Non-DBC/);
    expect(body).toMatch(/Alexander Olasinde's Merchant Officer line — Head \+ 1 Lead/);
    const credit = figures(body, "Credit (Credit Officers, Credit Leads, CX)");
    expect(credit.week[3]).toBe("2"); // CX recommendation + Credit Officer approval
    expect(figures(body, "ALL STAFF").week.slice(0, 2)).toEqual(["1", "₦2,000,000"]);
    expect(body).not.toContain("Ada CX-Reviewer");
    expect(body).not.toContain("Ade Okafor —");
    expect(body).toMatch(/6\. DECISIONS BY STAGE[\s\S]*Business endorsement\s+1 approved · 0 returned · 0 declined/);
  });

  it("the Super Admin can send a [TEST] report now, to the Divisional Heads or to themself, without affecting Sunday's run", async () => {
    const now = new Date();
    await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000), now });
    const admin = await ctxFor("superadmin@altbank.ng", now);
    expect(await sendDhTestReport(admin, "ME")).toMatchObject({ sent: 1 });
    expect(await sendDhTestReport(admin, "DIVISIONAL_HEADS")).toMatchObject({ sent: 1, to: ["Grace Divisional-Head"] });
    const tests = await outbox("DH_WEEKLY_REPORT_TEST");
    expect(tests.map((m) => m.to_addresses[0]).sort()).toEqual(["div.head@altbank.ng", "superadmin@altbank.ng"]);
    expect(tests[0].subject).toMatch(/^\[TEST\]/);
    expect(tests[0].body_text).toContain("TEST REPORT");
    expect(figures(tests[0].body_text, "ALL STAFF").week.slice(0, 2)).toEqual(["1", "₦1,000,000"]);
    expect((await audits("DH_TEST_REPORT_SENT")).length).toBe(2);
    await expect(sendDhTestReport(await ctxFor("div.head@altbank.ng"), "ME")).rejects.toThrow();
    // Sunday's real report still goes out.
    expect((await runDhWeeklyReport(new Date(dhPeriodFor(now, 18, 0).sendAt.getTime() + 60_000))).sent).toBe(1);
  });

  it("the Super Admin can switch it off, change the time and add recipients", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    const extra = await sid("unit.head@altbank.ng");
    await updateDhWeeklySchedule(admin, { enabled: true, hour: 19, minute: 30, recipientIds: [extra] });
    const p = dhPeriodFor(new Date(), 19, 30);
    expect((await runDhWeeklyReport(new Date(p.sendAt.getTime() - 60_000))).ran).toBe(false);
    expect((await runDhWeeklyReport(new Date(p.sendAt.getTime() + 60_000))).sent).toBe(2);
    expect((await outbox("DH_WEEKLY_REPORT")).map((m) => m.to_addresses[0]).sort()).toEqual(["div.head@altbank.ng", "unit.head@altbank.ng"]);
    await updateDhWeeklySchedule(admin, { enabled: false, hour: 18, minute: 0, recipientIds: [] });
    const next = dhPeriodFor(new Date(Date.now() + 7 * 86_400_000), 18, 0);
    expect((await runDhWeeklyReport(new Date(next.sendAt.getTime() + 60_000))).ran).toBe(false);
    await expect(updateDhWeeklySchedule(admin, { enabled: true, hour: 25, minute: 0, recipientIds: [] })).rejects.toThrow();
    await expect(updateDhWeeklySchedule(await ctxFor("rm.ade@altbank.ng"), { enabled: true, hour: 18, minute: 0, recipientIds: [] })).rejects.toThrow();
  });
});
