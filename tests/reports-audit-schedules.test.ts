import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { exportReport, reportFilterSchema, reportScope, runReport } from "@/server/reports";
import { grantRole, updateMonthlySchedule } from "@/server/domain/admin";
import { sendReminder } from "@/server/domain/workflow";
import { currentMonthlyPeriod, currentWeeklyPeriod, runMonthlyReport, runWeeklyDigest } from "@/server/jobs/schedules";
import { act, createSubmittedCase, ctxFor, driveToClosed, driveToOffer, openTaskOf } from "@/server/demo/scenario";
import { addDaysToDateString, fromLagos, lagosDate } from "@/server/time";
import { audits, key, outbox, resetDb, staffId } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

describe("admin reporting and exports", () => {
  it("filters, totals and exports use the same filters and permissions, and are audited with masking", async () => {
    const a = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    const b = await createSubmittedCase({ initiator: "ANM_NORTH", type: "ENTERPRISE", amountKobo: NAIRA(30_000_000) });
    await act(b, "ENDORSE");
    await act(a, "REJECT", { reason: "Out of policy" });
    const admin = await ctxFor("reports@altbank.ng");
    const scope = (await reportScope(db, admin.actor!.staffId))!;
    const all = await runReport(db, reportFilterSchema.parse({}), scope, new Date());
    expect(all.totals.requests).toBe(2);
    expect(all.totals.rejections).toBe(1);
    const north = await runReport(db, reportFilterSchema.parse({ region: "NORTH" }), scope, new Date());
    expect(north.rows.map((r) => r.id)).toEqual([b]);
    const r3 = await runReport(db, reportFilterSchema.parse({ route: "3", amountMin: "20,000,000.01" }), scope, new Date());
    expect(r3.rows.map((r) => r.id)).toEqual([b]);
    expect(r3.queues).toEqual([{ stage: "FIRST_CREDIT_REVIEW", n: "1" }]);

    const csv = await exportReport(admin, { region: "NORTH" }, "csv");
    const text = csv.body.toString("utf8");
    expect(csv.rowCount).toBe(1);
    expect(text).toContain("BVN (masked)");
    expect(text).toContain("•••••••5678");
    expect(text).not.toContain("22212345678");
    const xlsx = await exportReport(admin, { region: "NORTH" }, "xlsx");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as unknown as ArrayBuffer);
    expect(wb.getWorksheet("Requests")!.rowCount).toBe(2);
    const ev = await audits("REPORT_EXPORT");
    expect(ev.map((e) => e.details.format)).toEqual(["csv", "xlsx"]);
    expect(ev[0].details.filters.region).toBe("NORTH");
    expect(ev[0].actor_email).toBe("reports@altbank.ng");

    await expect(exportReport(await ctxFor("co1@altbank.ng"), {}, "csv")).rejects.toThrow(/Reporting access/);
    expect((await audits("REPORT_EXPORT")).at(-1).outcome).toBe("DENIED");
  });

  it("region-scoped reporting admins see only their region", async () => {
    await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    await createSubmittedCase({ initiator: "ANM_NORTH", amountKobo: NAIRA(1_000) });
    const sa = await ctxFor("superadmin@altbank.ng");
    await grantRole(sa, { staffId: await staffId("lead1@altbank.ng"), role: "REPORTING_ADMIN", region: "NORTH" });
    const scope = (await reportScope(db, await staffId("lead1@altbank.ng")))!;
    expect(scope.regions).toEqual(["NORTH"]);
    const r = await runReport(db, reportFilterSchema.parse({}), scope, new Date());
    expect(r.rows.every((x) => x.region === "NORTH")).toBe(true);
    expect(r.rows).toHaveLength(1);
  });

  it("CSV export neutralises formula injection", async () => {
    const { toCsv } = await import("@/server/reports");
    const csv = toCsv([{ ref: "=HYPERLINK(1)", customer_name: "+cmd", created_at: new Date() } as never]);
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toContain("'+cmd");
  });
});

describe("audit trail", () => {
  it("records actor, role, case, stage, outcome, correlation id, IP and device separately; excludes BVN; is append-only", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    const t = await openTaskOf(id);
    const ctx = await ctxFor(t.email!, new Date(), { ip: "196.46.10.5", correlationId: "corr-123" });
    const { performTaskAction } = await import("@/server/domain/workflow");
    await performTaskAction(ctx, { taskId: t.id, action: "ENDORSE", idempotencyKey: key() });
    const ev = (await db.query("SELECT * FROM audit_events WHERE correlation_id = 'corr-123' AND action = 'TASK_ENDORSE'")).rows[0];
    expect(ev.actor_email).toBe("rbe.lagos@altbank.ng");
    expect(ev.actor_role).toBe("RBE");
    expect(ev.application_id).toBe(id);
    expect(ev.customer_id).not.toBeNull();
    expect(ev.stage).toBe("BUSINESS_ENDORSEMENT");
    expect(ev.client_ip).toBe("196.46.10.5");
    expect(ev.device).toBe("Chrome 130 on Windows (desktop)");
    expect(ev.user_agent).toContain("Mozilla/5.0");
    const assign = (await db.query("SELECT * FROM audit_events WHERE correlation_id = 'corr-123' AND action = 'TASK_ASSIGNED'")).rows[0];
    expect(assign.assignment_to).toBe((await openTaskOf(id)).assignee_id);
    const dump = JSON.stringify((await db.query("SELECT * FROM audit_events")).rows);
    expect(dump).not.toContain("22212345678");
    await expect(db.query("UPDATE audit_events SET action = 'X' WHERE id = $1", [ev.id])).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM audit_events WHERE id = $1", [ev.id])).rejects.toThrow(/append-only/);
    await expect(db.query("UPDATE decisions SET reason = 'tampered'")).rejects.toThrow(/immutable/);
  });

  it("per-customer trail links repeat applications for the same customer", async () => {
    const a = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    const b = await createSubmittedCase({ initiator: "MERCHANT_OFFICER", amountKobo: NAIRA(2_000) });
    const c = (await db.query("SELECT DISTINCT customer_id FROM applications WHERE id = ANY($1::uuid[])", [[a, b]])).rows;
    expect(c).toHaveLength(1);
    const trail = await db.query("SELECT DISTINCT application_id FROM audit_events WHERE customer_id = $1 AND application_id IS NOT NULL", [c[0].customer_id]);
    expect(trail.rows).toHaveLength(2);
  });
});

describe("initiator reminders", () => {
  it("allowed only when the current assignment is older than six hours; deduplicated; timer resets on new assignment", async () => {
    const t0 = new Date("2026-06-01T08:00:00Z");
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000), now: t0 });
    const rm = (s: number) => ctxFor("rm.ade@altbank.ng", new Date(t0.getTime() + s * 1000));
    await expect(sendReminder(await rm(6 * 3600), id, key())).rejects.toThrow(/older than six hours/);
    const k = key();
    const r1 = await sendReminder(await rm(6 * 3600 + 1), id, k);
    const r2 = await sendReminder(await rm(6 * 3600 + 2), id, k); // double click
    expect(r1.message).toBe("Reminder sent.");
    expect(r2.replayed).toBe(true);
    await expect(sendReminder(await rm(7 * 3600), id, key())).rejects.toThrow(/already sent in the last six hours/);
    expect((await outbox("REMINDER")).length).toBe(1);
    expect((await outbox("REMINDER"))[0].to_addresses).toEqual(["rbe.lagos@altbank.ng"]);
    // New assignment resets the timer; previous durations preserved in task history.
    await act(id, "ENDORSE", {}, new Date(t0.getTime() + 8 * 3600_000));
    await expect(sendReminder(await rm(9 * 3600), id, key())).rejects.toThrow(/older than six hours/);
    const hist = (await db.query("SELECT stage, entered_at, completed_at FROM tasks WHERE application_id = $1 ORDER BY seq", [id])).rows;
    expect(new Date(hist[0].completed_at).getTime() - new Date(hist[0].entered_at).getTime()).toBe(8 * 3600_000);
    await expect(sendReminder(await ctxFor("co1@altbank.ng", new Date(t0.getTime() + 20 * 3600_000)), id, key())).rejects.toThrow(/Only the initiator/);
    expect((await audits("REMINDER_SENT")).filter((a) => a.outcome === "SUCCESS")).toHaveLength(1);
  });
});

describe("scheduled emails", () => {
  it("weekly digest fires at Sunday midnight as Monday begins in Africa/Lagos (Sun 23:00 UTC)", () => {
    // 2026-06-07 is a Sunday. 22:59 UTC = 23:59 Lagos Sunday; 23:00 UTC = 00:00 Lagos Monday.
    const before = currentWeeklyPeriod(new Date("2026-06-07T22:59:00Z"));
    const at = currentWeeklyPeriod(new Date("2026-06-07T23:00:00Z"));
    expect(before.startDate).toBe("2026-06-01");
    expect(at.startDate).toBe("2026-06-08");
    expect(at.start.toISOString()).toBe("2026-06-07T23:00:00.000Z");
    expect(at.endDate).toBe("2026-06-14");
  });

  it("weekly digest summarises disbursements and repayments due Mon–Sun, only after vendor confirmation; deduplicated", async () => {
    const monday = fromLagos(2026, 6, 8); // Mon 8 Jun 2026 00:00 Lagos
    const disbAt = new Date(monday.getTime() - 3 * 86400_000); // Friday before
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000), now: disbAt });
    await driveToOffer(id, disbAt);
    // schedule: first instalment due Wednesday of the digest week
    const { preparePack } = await import("@/server/demo/scenario");
    await preparePack(id, disbAt);
    await act(id, "SUBMIT_PACK", {}, disbAt);
    const { uploadDocument } = await import("@/server/domain/documents");
    const { makePdf } = await import("@/server/demo/scenario");
    await uploadDocument(await ctxFor("co3@altbank.ng", disbAt), { applicationId: id, category: "INSURANCE_EVIDENCE", filename: "i.pdf", data: makePdf("i") });
    await act(id, "FORWARD", {}, disbAt);
    await act(id, "OKAY", { crmsLogged: true }, disbAt);
    await act(id, "DISBURSED", {
      booking: { amountKobo: NAIRA(1_000_000), disbursedOn: lagosDate(disbAt), transactionRef: "WK-1", schedule: [{ dueDate: "2026-06-10", amountKobo: NAIRA(600_000) }, { dueDate: "2026-07-10", amountKobo: NAIRA(600_000) }] },
    }, disbAt);
    await act(id, "COMPLETE_PROCESS", {}, disbAt);

    // Before vendor confirmation: disbursement reported, repayment prompt not yet active.
    const r0 = await runWeeklyDigest(new Date(monday.getTime() + 60_000));
    expect(r0.ran).toBe(true);
    let mail = (await outbox("WEEKLY_DIGEST"))[0];
    expect(mail.to_addresses).toEqual(["rm.ade@altbank.ng"]);
    expect(mail.body_text).toContain("Successful disbursements in the past week: 1");
    expect(mail.body_text).toContain("Repayments due this week (Monday–Sunday): 0");
    // Re-running the same period never sends again.
    expect((await runWeeklyDigest(new Date(monday.getTime() + 120_000))).ran).toBe(false);
    expect((await outbox("WEEKLY_DIGEST")).length).toBe(1);

    await act(id, "CONFIRM_VENDOR_PAYMENT", {}, new Date(monday.getTime() + 3600_000));
    const nextWeek = new Date(monday.getTime() - 7 * 86400_000 + 60_000);
    expect(currentWeeklyPeriod(nextWeek).startDate).toBe("2026-06-01");
    // Simulate the following run on a clean period key where the instalment is in range.
    await db.query("DELETE FROM digest_deliveries");
    await db.query("DELETE FROM schedule_runs");
    await runWeeklyDigest(new Date(monday.getTime() + 2 * 3600_000));
    mail = (await outbox("WEEKLY_DIGEST"))[0];
    // outbox dedupe key prevents a second email for the same recipient+period even if run state is lost
    expect((await outbox("WEEKLY_DIGEST")).length).toBe(1);
    const deliveries = (await db.query("SELECT summary FROM digest_deliveries")).rows;
    expect(deliveries[0].summary.repaymentsDue).toBe(1);
  });

  it("monthly report defaults to the 1st at 08:00 Lagos for the prior calendar month and is admin configurable", async () => {
    const p = currentMonthlyPeriod(new Date("2026-07-01T07:00:00Z"), 1, 8, 0);
    expect(p.key).toBe("M2026-06");
    expect(p.dueAt.toISOString()).toBe("2026-07-01T07:00:00.000Z"); // 08:00 WAT
    expect(p.start.toISOString()).toBe("2026-05-31T23:00:00.000Z");
    const jan = currentMonthlyPeriod(new Date("2026-01-01T07:30:00Z"), 1, 8, 0);
    expect(jan.key).toBe("M2025-12");

    await createSubmittedCase({ initiator: "ANM_NORTH", amountKobo: NAIRA(1_000), now: new Date("2026-06-15T10:00:00Z") });
    expect((await runMonthlyReport(new Date("2026-07-01T06:59:00Z"))).ran).toBe(false); // 07:59 WAT
    const r = await runMonthlyReport(new Date("2026-07-01T07:00:30Z"));
    expect(r.ran).toBe(true);
    const mails = await outbox("MONTHLY_REPORT");
    const to = mails.flatMap((m) => m.to_addresses).sort();
    expect(to).toEqual(["anm.lead.north@altbank.ng", "anm.lead.south@altbank.ng", "lead1@altbank.ng", "lead2@altbank.ng", "mo.lead@altbank.ng", "unit.head@altbank.ng"]);
    const south = mails.find((m) => m.to_addresses[0] === "anm.lead.south@altbank.ng")!;
    expect(south.body_text).toContain("scope: SOUTH");
    expect(south.body_text).toContain("Submitted in month: 0");
    const uh = mails.find((m) => m.to_addresses[0] === "unit.head@altbank.ng")!;
    expect(uh.body_text).toContain("bank-wide");
    expect(uh.body_text).toContain("Submitted in month: 1");
    expect((await runMonthlyReport(new Date("2026-07-01T08:00:00Z"))).ran).toBe(false);

    // Admin reconfigures schedule & recipients
    const sa = await ctxFor("superadmin@altbank.ng");
    await updateMonthlySchedule(sa, { enabled: true, dayOfMonth: 3, hour: 9, minute: 30, recipientIds: [await staffId("unit.head@altbank.ng")] });
    expect((await runMonthlyReport(new Date("2026-08-01T07:00:00Z"))).ran).toBe(false);
    const aug = await runMonthlyReport(new Date("2026-08-03T08:30:00Z"));
    expect(aug.ran).toBe(true);
    expect(aug.sent).toBe(1);
    expect(addDaysToDateString("2026-08-03", 0)).toBe("2026-08-03");
  });
});
