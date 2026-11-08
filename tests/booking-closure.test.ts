import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { performTaskAction } from "@/server/domain/workflow";
import { uploadDocument } from "@/server/domain/documents";
import { caseAccess } from "@/server/domain/access";
import { processOutbox, retryOutbox } from "@/server/jobs/outbox";
import { setMailTransportForTests } from "@/server/notify/transport";
import { bookedRequests, repaymentPrompts } from "@/server/domain/views";
import { act, appRow, createSubmittedCase, ctxFor, driveToOffer, makePdf, openTaskOf, preparePack } from "@/server/demo/scenario";
import { addDaysToDateString, lagosDate } from "@/server/time";
import { key, outbox, resetDb, staffId } from "./helpers";

beforeEach(async () => {
  await resetDb();
  setMailTransportForTests(null);
});

async function atBooking() {
  const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(3_000_000) });
  await driveToOffer(id);
  await preparePack(id);
  await act(id, "SUBMIT_PACK");
  await uploadDocument(await ctxFor("co3@altbank.ng"), { applicationId: id, category: "INSURANCE_EVIDENCE", filename: "ins.pdf", data: makePdf("ins") });
  await act(id, "FORWARD");
  await act(id, "OKAY", { crmsLogged: true });
  return id;
}
const today = lagosDate(new Date());
const booking = (ref: string, amount = NAIRA(3_000_000)) => ({
  amountKobo: amount,
  disbursedOn: today,
  transactionRef: ref,
  schedule: [{ dueDate: addDaysToDateString(today, 3), amountKobo: NAIRA(1_700_000) }, { dueDate: addDaysToDateString(today, 33), amountKobo: NAIRA(1_700_000) }],
});

describe("disbursement booking", () => {
  it("validates booking details and cannot exceed the approved amount", async () => {
    const id = await atBooking();
    await expect(act(id, "DISBURSED", { booking: booking("TX1", NAIRA(3_000_001)) })).rejects.toMatchObject({ fields: { amount: expect.stringMatching(/exceed/) } });
    await expect(act(id, "DISBURSED", { booking: { ...booking("TX1"), schedule: [] } })).rejects.toMatchObject({ fields: { schedule: expect.any(String) } });
    await expect(act(id, "DISBURSED", { booking: { ...booking("TX1"), schedule: [{ dueDate: today, amountKobo: 1 }] } })).rejects.toThrow(/Check the disbursement/);
  });

  it("prevents duplicate disbursement (double click replay, concurrent submit, reused reference)", async () => {
    const id = await atBooking();
    const t = await openTaskOf(id);
    const ctx = await ctxFor(t.email!);
    const k = key();
    const results = await Promise.allSettled([
      performTaskAction(ctx, { taskId: t.id, action: "DISBURSED", idempotencyKey: k, booking: booking("TXA-0001") }),
      performTaskAction(ctx, { taskId: t.id, action: "DISBURSED", idempotencyKey: k, booking: booking("TXA-0001") }),
      performTaskAction(ctx, { taskId: t.id, action: "DISBURSED", idempotencyKey: key(), booking: booking("TXA-0002") }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const d = await db.query("SELECT * FROM disbursements WHERE application_id = $1", [id]);
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0].transaction_ref).toBe("TXA-0001");
    expect((await outbox("DISBURSED")).length).toBe(1);
    // Another case cannot reuse the transaction reference.
    const id2 = await atBooking();
    await expect(act(id2, "DISBURSED", { booking: booking("TXA-0001") })).rejects.toThrow(/already recorded/);
  });

  it("persists booking, notifies CO3 and the initiator, and booking is visible from disbursement", async () => {
    const id = await atBooking();
    await act(id, "DISBURSED", { booking: booking("TXB-1") });
    const app = await appRow(id);
    expect(app.status).toBe("BOOKED");
    expect((await openTaskOf(id)).stage).toBe("COMPLETION");
    const mail = (await outbox("DISBURSED"))[0];
    expect(mail.to_addresses.sort()).toEqual(["co3@altbank.ng", "rm.ade@altbank.ng"]);
    const booked = await bookedRequests(db, { initiatorId: await staffId("rm.ade@altbank.ng") });
    expect(booked).toHaveLength(1);
    expect(booked[0].schedule).toHaveLength(2);
    expect(booked[0].vendor_confirmed_at).toBeNull();
  });
});

describe("closure actions", () => {
  it("Complete Process queues exactly one closure email to Legal and Shariah, copying the initiator; vendor confirmation closes the case", async () => {
    const id = await atBooking();
    await act(id, "DISBURSED", { booking: booking("TXC-1") });
    // Initiator cannot confirm vendor payment before CO3 completes the process.
    const rm = await ctxFor("rm.ade@altbank.ng");
    const t = await openTaskOf(id);
    await expect(performTaskAction(rm, { taskId: t.id, action: "CONFIRM_VENDOR_PAYMENT", idempotencyKey: key() })).rejects.toThrow(/not assigned to you/);
    await act(id, "COMPLETE_PROCESS");
    const closure = await outbox("CLOSURE_PACK");
    expect(closure).toHaveLength(1);
    expect(closure[0].to_addresses.sort()).toEqual(["legal.officer@altbank.ng", "legal@altbank.ng", "shariah.officer@altbank.ng", "shariah@altbank.ng"]);
    expect(closure[0].cc_addresses).toEqual(["rm.ade@altbank.ng"]);
    expect(closure[0].attachment_document_ids.length).toBeGreaterThan(10);
    expect(closure[0].body_text).toContain("TXC-1");
    expect(closure[0].body_text).not.toMatch(/22212345678/);
    const ev = await db.query("SELECT * FROM closure_events WHERE application_id = $1", [id]);
    expect(ev.rows).toHaveLength(1);

    // Vendor confirmation is a separate initiator action that closes the case.
    let app = await appRow(id);
    expect(app.process_completed_by).toBe(await staffId("co3@altbank.ng"));
    expect(app.status).toBe("BOOKED");
    await act(id, "CONFIRM_VENDOR_PAYMENT");
    app = await appRow(id);
    expect(app.status).toBe("CLOSED");
    expect(app.vendor_confirmed_by).toBe(await staffId("rm.ade@altbank.ng"));
    expect(app.vendor_confirmed_at).not.toBeNull();
    expect(app.repayment_prompts_active_at).not.toBeNull();
    const prompts = await repaymentPrompts(db, await staffId("rm.ade@altbank.ng"), today, addDaysToDateString(today, 40));
    expect(prompts).toHaveLength(2);
  });

  it("closure delivery is tracked and retried without creating duplicate closure events", async () => {
    const id = await atBooking();
    await act(id, "DISBURSED", { booking: booking("TXD-1") });
    await act(id, "COMPLETE_PROCESS");
    let calls = 0;
    setMailTransportForTests({
      name: "flaky",
      async send() {
        calls++;
        if (calls === 1) throw new Error("SMTP 451 temporary failure");
        return { messageId: "ok-1" };
      },
    });
    const now = new Date();
    await processOutbox(now);
    let row = (await outbox("CLOSURE_PACK"))[0];
    // first message processed may not be the closure one; loop until closure attempted
    while (row.attempts === 0) {
      await processOutbox(new Date(now.getTime() + 3600_000));
      row = (await outbox("CLOSURE_PACK"))[0];
    }
    for (let i = 0; i < 5 && row.status !== "SENT"; i++) {
      await processOutbox(new Date(now.getTime() + (i + 2) * 3600_000));
      row = (await outbox("CLOSURE_PACK"))[0];
    }
    expect(row.status).toBe("SENT");
    expect((await outbox("CLOSURE_PACK")).length).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM closure_events")).rows[0].n).toBe(1);
    const failedAudit = await db.query("SELECT * FROM audit_events WHERE action = 'EMAIL_FAILED'");
    expect(failedAudit.rows.length).toBeGreaterThanOrEqual(1);
    // Repeat Complete Process is impossible (task already completed)
    await retryOutbox(row.id);
    expect((await outbox("CLOSURE_PACK")).length).toBe(1);
  });

  it("Legal and Shariah recipients get scoped read access only to closure cases delivered to them", async () => {
    const closed = await atBooking();
    await act(closed, "DISBURSED", { booking: booking("TXE-1") });
    const other = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000) });
    const legal = await staffId("legal.officer@altbank.ng");
    expect((await caseAccess(db, legal, closed)).canView).toBe(false);
    await act(closed, "COMPLETE_PROCESS");
    expect((await caseAccess(db, legal, closed)).capacities).toEqual(["LEGAL_RECIPIENT"]);
    expect((await caseAccess(db, await staffId("shariah.officer@altbank.ng"), closed)).capacities).toEqual(["SHARIAH_RECIPIENT"]);
    expect((await caseAccess(db, legal, other)).canView).toBe(false);
  });

  it("closure requires configured Legal and Shariah groups", async () => {
    const id = await atBooking();
    await act(id, "DISBURSED", { booking: booking("TXF-1") });
    await db.query("DELETE FROM recipient_group_members WHERE group_code = 'SHARIAH'");
    await expect(act(id, "COMPLETE_PROCESS")).rejects.toThrow(/recipient groups must be configured/);
  });
});
