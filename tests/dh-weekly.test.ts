import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { audits, outbox, resetDb } from "./helpers";
import { createSubmittedCase, ctxFor, driveToOffer } from "@/server/demo/scenario";
import { dhPeriodFor, duePeriod, runDhWeeklyReport } from "@/server/jobs/dh-weekly";
import { updateDhWeeklySchedule } from "@/server/domain/admin";
import { setOrgLink } from "@/server/domain/org";

const N = (n: number) => n * 100;
const sid = async (email: string) => (await db.query("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id as string;

beforeEach(resetDb);

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
    for (const section of ["1. FINANCING HEADLINES", "2a. BY BUSINESS LINE", "2b. BY PRODUCT", "3. APPROVAL EFFICIENCY", "4. PIPELINE NOW", "5. CONTROLS", "6. TOP ORIGINATORS", "7. REVIEW AND APPROVAL DECISIONS", "8. ALTPHONES AND STAFF SALARY ADVANCE"])
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

  it("covers every Unit Head and each direct report: requests, decisions, work actions and open tasks", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    const uh = await sid("unit.head@altbank.ng");
    await setOrgLink(admin, { staffId: await sid("rm.ade@altbank.ng"), relation: "UNIT_HEAD", managerId: uh, reason: "Ade reports to Olu for reporting." });
    const lonely = (await db.query("INSERT INTO staff (email, full_name) VALUES ('uh.two@altbank.ng','Second Unit-Head') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO role_assignments (staff_id, role) VALUES ($1,'UNIT_HEAD')", [lonely]);
    const now = new Date();
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_500_000), now });
    await driveToOffer(id, now); // includes a Unit Head approval
    await runDhWeeklyReport(new Date(dhPeriodFor(now, 18, 0).sendAt.getTime() + 60_000));
    const body: string = (await outbox("DH_WEEKLY_REPORT"))[0].body_text;
    expect(body).toContain("9. UNIT HEADS AND THEIR DIRECT REPORTS");
    expect(body).toMatch(/9\.\d Olu Unit-Head, Unit Head \(1 direct report\)/);
    expect(body).toMatch(/Olu Unit-Head \(Unit Head, own work\)\s+1 decision · \d+ actions?/);
    expect(body).toMatch(/Ade Okafor \(Relationship Manager\)[^\n]*1 req ₦1,500,000/);
    expect(body).toMatch(/9\.\d Second Unit-Head, Unit Head \(0 direct reports\)/);
    expect(body).toContain("No direct reports are mapped yet");
    expect(body).toMatch(/Ade Okafor this week: [^\n]*Draft created ×1/);
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
