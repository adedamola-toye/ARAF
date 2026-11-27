import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { act, appRow, createSubmittedCase, ctxFor, driveToOffer, makePdf, openTaskOf, preparePack } from "@/server/demo/scenario";
import { uploadDocument } from "@/server/domain/documents";

import { addDaysToDateString, lagosDate } from "@/server/time";
import { cadOverview, completionRecord, holdDisbursement, preDisbursementChecklist, recordAttempt, releaseHold, resolveAttempt } from "@/server/domain/cad";

beforeEach(resetDb);

async function toCheck() {
  const id = await createSubmittedCase({ initiator: "RM", amountKobo: 100_000_000 });
  await driveToOffer(id);
  await preparePack(id);
  await act(id, "SUBMIT_PACK");
  const t = await openTaskOf(id);
  await uploadDocument(await ctxFor(t.email!), { applicationId: id, category: "INSURANCE_EVIDENCE", filename: "insurance-evidence.pdf", data: makePdf("Insurance evidence") });
  await act(id, "FORWARD");
  expect((await openTaskOf(id)).stage).toBe("DISBURSEMENT_CHECK");
  return id;
}

function booking(ref: string) {
  const today = lagosDate(new Date());
  return { amountKobo: 100_000_000, disbursedOn: today, transactionRef: ref, schedule: [{ dueDate: addDaysToDateString(today, 30), amountKobo: 100_000_000 }] };
}

describe("CAD disbursement controls", () => {
  it("a hold blocks the DO1 check until released, with reasons recorded", async () => {
    const id = await toCheck();
    const do1 = await ctxFor((await openTaskOf(id)).email!);
    await expect(holdDisbursement(do1, id, "short")).rejects.toMatchObject({ code: "VALIDATION" });
    await holdDisbursement(do1, id, "Beneficiary account name does not match the invoice");
    await expect(act(id, "OKAY", { crmsLogged: true })).rejects.toMatchObject({ code: "GATE" });
    const items = await preDisbursementChecklist(db, id);
    expect(items.find((i) => i.code === "HOLD")!.ok).toBe(false);
    await releaseHold(do1, id, "Vendor confirmed the account name in writing");
    await act(id, "OKAY", { crmsLogged: true });
    expect((await openTaskOf(id)).stage).toBe("DISBURSEMENT_BOOKING");
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE application_id = $1 AND action IN ('DISBURSEMENT_HELD','DISBURSEMENT_HOLD_RELEASED')", [id])).rows[0].n).toBe(2);
  });

  it("an uncertain posting blocks booking until verified; a verified posting pins the reference", async () => {
    const id = await toCheck();
    await act(id, "OKAY", { crmsLogged: true });
    const do2 = await ctxFor((await openTaskOf(id)).email!);
    await recordAttempt(do2, id, { outcome: "UNCERTAIN", attemptedRef: "FT2611220001", amountKobo: 100_000_000, note: "Core banking timed out after submission" });
    const ov = await cadOverview(db, do2.actor!.staffId, new Date(0));
    expect(ov.processing.rows.map((r) => r.application_id)).toContain(id);
    expect(ov.ready.rows.map((r) => r.application_id)).not.toContain(id);
    await expect(act(id, "DISBURSED", { booking: booking("FT2611220002") })).rejects.toMatchObject({ code: "GATE" });
    const at = (await db.query("SELECT id FROM disbursement_attempts WHERE application_id = $1", [id])).rows[0].id;
    await resolveAttempt(do2, at, "POSTED", "Confirmed on the core banking statement for the day");
    // Booking with a different reference would be a second payment: refused.
    await expect(act(id, "DISBURSED", { booking: booking("FT2611220002") })).rejects.toMatchObject({ code: "GATE" });
    await act(id, "DISBURSED", { booking: booking("FT2611220001") });
    const done = await completionRecord(db, id);
    expect(done).toMatchObject({ transaction_ref: "FT2611220001", amount_kobo: "100000000" });
    expect((await appRow(id)).disbursed_at).not.toBeNull();
  });

  it("a failed posting is recorded and does not block a later, genuine booking", async () => {
    const id = await toCheck();
    await act(id, "OKAY", { crmsLogged: true });
    const do2 = await ctxFor((await openTaskOf(id)).email!);
    await recordAttempt(do2, id, { outcome: "FAILED", note: "Rejected by core banking: account dormant" });
    await act(id, "DISBURSED", { booking: booking("FT2611220009") });
    expect(await completionRecord(db, id)).not.toBeNull();
  });

  it("DO1 can reject at the disbursement check, with a reason recorded", async () => {
    const id = await toCheck();
    await expect(act(id, "REJECT", { reason: "no" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await appRow(id)).stage).toBe("DISBURSEMENT_CHECK");
    await act(id, "REJECT", { reason: "Beneficiary account is dormant and the facility must not be paid" });
    const row = await appRow(id);
    expect(row.stage).toBe("REJECTED");
    expect(row.rejected_at).not.toBeNull();
    const decision = (await db.query("SELECT action, decision_kind, reason FROM decisions WHERE application_id = $1 AND action = 'REJECT'", [id])).rows[0];
    expect(decision).toMatchObject({ action: "REJECT", decision_kind: "DECLINE", reason: "Beneficiary account is dormant and the facility must not be paid" });
    expect((await db.query("SELECT count(*)::int AS n FROM tasks WHERE application_id = $1 AND status = 'OPEN'", [id])).rows[0].n).toBe(0);
  });

  it("DO2 can reject at booking, with a reason recorded", async () => {
    const id = await toCheck();
    await act(id, "OKAY", { crmsLogged: true });
    expect((await openTaskOf(id)).stage).toBe("DISBURSEMENT_BOOKING");
    await act(id, "REJECT", { reason: "Core banking will not clear the beneficiary for this facility" });
    expect((await appRow(id)).stage).toBe("REJECTED");
    expect((await db.query("SELECT decision_kind FROM decisions WHERE application_id = $1 AND action = 'REJECT'", [id])).rows[0].decision_kind).toBe("DECLINE");
  });

  it("no completion record exists without a recorded disbursement, and non-CAD staff cannot hold", async () => {
    const id = await toCheck();
    expect(await completionRecord(db, id)).toBeNull();
    await expect(holdDisbursement(await ctxFor("rm.ade@altbank.ng"), id, "Not my role to hold this")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
