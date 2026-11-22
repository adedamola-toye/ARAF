import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { createDraft } from "@/server/domain/workflow";
import { createSubmittedCase, ctxFor, driveToClosed, driveToOffer } from "@/server/demo/scenario";
import { dhPeriodFor, runDhWeeklyReport } from "@/server/jobs/dh-weekly";
import { computeBriefing, previewBriefing, sendBriefingTest } from "@/server/jobs/briefing";

beforeEach(resetDb);

// A fixed mid-week moment, so the run does not depend on the real clock.
const NOW = new Date("2026-11-18T10:00:00Z");
const N = (naira: number) => naira * 100;
const rmId = async () => (await db.query("SELECT id FROM staff WHERE email = 'rm.ade@altbank.ng'")).rows[0].id as string;

async function enableBriefing() {
  await db.query("UPDATE schedule_settings SET enabled = true WHERE code = 'PERSONAL_BRIEFING'");
}

describe("Weekly Performance Briefing (personal)", () => {
  it("is off by default: the Sunday run sends no personal briefings", async () => {
    await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000), now: NOW });
    const r = await runDhWeeklyReport(new Date(dhPeriodFor(NOW, 18, 0).sendAt.getTime() + 60_000));
    expect(r.ran).toBe(true);
    expect(r.briefingsSent).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM notification_outbox WHERE kind = 'PERSONAL_BRIEFING'")).rows[0].n).toBe(0);
  });

  it("disbursements are the dominant figure; drafts and approvals are never counted as disbursements; sent once per week", async () => {
    await enableBriefing();
    await createDraft(await ctxFor("rm.ade@altbank.ng", NOW), { initiatorRole: "RM", applicantType: "INDIVIDUAL" });
    const disbursed = await createSubmittedCase({ initiator: "RM", amountKobo: N(1_000_000), now: NOW });
    await driveToOffer(disbursed, NOW);
    await driveToClosed(disbursed, NOW);
    const approvedOnly = await createSubmittedCase({ initiator: "RM", amountKobo: N(2_000_000), now: NOW });
    await driveToOffer(approvedOnly, NOW);

    const p = dhPeriodFor(NOW, 18, 0);
    const b = await computeBriefing(db, { kind: "STAFF", staffIds: [await rmId()], label: "me" }, p, { targetStaffId: await rmId() });
    expect(b.disbursed).toMatchObject({ n: 1, kobo: N(1_000_000), prevN: 0 });
    expect(b.disbursed.change.text).toBe("up from nothing the previous week");
    expect(b.submitted.n).toBe(2); // the draft is not counted
    expect(b.approved.n).toBe(2); // approvals are separate from disbursements

    const at = new Date(p.sendAt.getTime() + 60_000);
    const r = await runDhWeeklyReport(at);
    expect(r.briefingsSent).toBeGreaterThan(0);
    const mail = (await db.query("SELECT o.subject, o.body_text, o.body_html FROM notification_outbox o WHERE o.kind = 'PERSONAL_BRIEFING' AND 'rm.ade@altbank.ng' = ANY(o.to_addresses)")).rows;
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toBe("ARAF | Weekly Performance Briefing | Week Ending 22 November 2026");
    expect(mail[0].body_text).toContain("Successful disbursements: ₦1,000,000.00 (1)");
    expect(mail[0].body_html).toContain("Open ARAF");
    expect(mail[0].body_html).toContain("Internal and confidential");
    expect(mail[0].body_text).not.toMatch(/\d{11}/); // no BVNs or phone numbers
    // Rerun: nothing new.
    await runDhWeeklyReport(new Date(at.getTime() + 60_000));
    expect((await db.query("SELECT count(*)::int AS n FROM notification_outbox WHERE kind = 'PERSONAL_BRIEFING' AND 'rm.ade@altbank.ng' = ANY(to_addresses)")).rows[0].n).toBe(1);
  });

  it("compares with the previous week without double counting", async () => {
    const lastWeek = new Date(NOW.getTime() - 7 * 86_400_000);
    const a = await createSubmittedCase({ initiator: "RM", amountKobo: N(3_000_000), now: lastWeek });
    await driveToOffer(a, lastWeek);
    await driveToClosed(a, lastWeek);
    const b = await computeBriefing(db, { kind: "STAFF", staffIds: [await rmId()], label: "me" }, dhPeriodFor(NOW, 18, 0));
    expect(b.disbursed).toMatchObject({ n: 0, kobo: 0, prevN: 1, prevKobo: N(3_000_000) });
    expect(b.disbursed.change.text).toBe("down 100% on the previous week");
  });

  it("preview and test send are Super Admin tools and never count as the weekly delivery", async () => {
    const pv = await previewBriefing(db, await rmId(), NOW);
    expect(pv!.subject).toMatch(/^\[PREVIEW\] ARAF \| Weekly Performance Briefing/);
    await expect(sendBriefingTest(await ctxFor("rm.ade@altbank.ng", NOW), await rmId())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await sendBriefingTest(await ctxFor("superadmin@altbank.ng", NOW), await rmId());
    const t = (await db.query("SELECT subject, to_addresses FROM notification_outbox WHERE kind = 'PERSONAL_BRIEFING_TEST'")).rows;
    expect(t).toHaveLength(1);
    expect(t[0].to_addresses).toEqual(["superadmin@altbank.ng"]);
    expect((await db.query("SELECT count(*)::int AS n FROM digest_deliveries WHERE code = 'PERSONAL_BRIEFING'")).rows[0].n).toBe(0);
  });
});
