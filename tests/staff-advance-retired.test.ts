import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db, withTx } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor, makePdf } from "@/server/demo/scenario";
import { approveStaffTemplate, disburse, divisionalApprove, officerEmail, pmForward, returnSignedOffer, reqRow, sid, submittedStaffRequest, unitHeadApprove, STAFF } from "@/server/demo/staff-scenario";
import { requireStaffFinancing, setStaffAdvanceRetiredForTests, staffFinancingAccess, STAFF_SALARY_ADVANCE_RETIRED_MESSAGE } from "@/server/staff/permission";
import { createStaffDraft } from "@/server/staff/requests";
import { completeDisbursement, reviewDisbursementDocumentation, startDisbursement } from "@/server/staff/disbursement";
import { uploadStaffDocument } from "@/server/staff/documents";
import { recordRepayment, saveRecord } from "@/server/staff/register";
import { setDocumentLibraryForTests } from "@/server/staff/sharepoint";
import { MemoryLibrary } from "@/server/demo/staff-scenario";

const lv = async (id: string) => (await reqRow(id)).lock_version as number;

beforeEach(async () => {
  await resetDb();
  setStaffAdvanceRetiredForTests(false);
  setDocumentLibraryForTests(new MemoryLibrary());
});
afterEach(() => {
  setStaffAdvanceRetiredForTests(true);
  setDocumentLibraryForTests(null);
});

/** Re-runs the withdrawal of migration 058 (idempotent) against requests created in the test. */
async function runRetirementMigration() {
  const sql = readFileSync(join(process.cwd(), "migrations/058_retire_staff_salary_advance.sql"), "utf8");
  await withTx(async (tx) => {
    await tx.query(sql);
  });
}

describe("Staff Salary Advance retirement", () => {
  it("closes pending requests, leaves money in motion and completed advances alone, and blocks new activity", async () => {
    await approveStaffTemplate();
    // A completed advance (repayments must remain possible).
    const done = await submittedStaffRequest();
    await pmForward(done);
    await unitHeadApprove(done);
    await divisionalApprove(done);
    await returnSignedOffer(done);
    await disburse(done);
    // A disbursement already started (payment may be with core banking).
    const moving = await submittedStaffRequest({ amount: "500,000" });
    await pmForward(moving);
    await unitHeadApprove(moving);
    await divisionalApprove(moving);
    await returnSignedOffer(moving);
    const officer = await ctxFor(await officerEmail(moving));
    await reviewDisbursementDocumentation(officer, moving, { lockVersion: await lv(moving) });
    await startDisbursement(officer, moving, { instructionRef: "INSTR-9", lockVersion: await lv(moving) });
    // A request still under review.
    const pending = await submittedStaffRequest({ amount: "300,000" });

    await runRetirementMigration();
    setStaffAdvanceRetiredForTests(true);

    expect((await reqRow(done)).status).toBe("COMPLETED");
    expect((await reqRow(moving)).status).toBe("DISBURSEMENT_IN_PROGRESS");
    expect((await reqRow(pending)).status).toBe("WITHDRAWN");
    const ev = (await db.query("SELECT action, from_status, to_status, actor_role FROM staff_request_events WHERE request_id = $1 ORDER BY id DESC LIMIT 1", [pending])).rows[0];
    expect(ev).toEqual({ action: "PRODUCT_RETIRED", from_status: "SUBMITTED", to_status: "WITHDRAWN", actor_role: "SYSTEM" });
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'STAFF_REQUEST_WITHDRAWN_PRODUCT_RETIRED' AND staff_request_id = $1", [pending])).rows[0].n).toBe(1);
    const applicant = await sid(STAFF.applicant);
    expect((await db.query("SELECT count(*)::int AS n FROM notifications WHERE recipient_id = $1 AND kind = 'STAFF_ADVANCE_RETIRED'", [applicant])).rows[0].n).toBe(1);
    // Running it again changes nothing (no second event, audit or notice).
    await runRetirementMigration();
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'STAFF_REQUEST_WITHDRAWN_PRODUCT_RETIRED'")).rows[0].n).toBe(1);

    // No new requests; the access policy says why.
    expect(await staffFinancingAccess(db, applicant)).toMatchObject({ allowed: false, reason: "RETIRED" });
    const me = await ctxFor(STAFF.applicant);
    await expect(createStaffDraft(me)).rejects.toMatchObject({ code: "FORBIDDEN", message: STAFF_SALARY_ADVANCE_RETIRED_MESSAGE });
    // Records stay readable.
    await expect(requireStaffFinancing(me, "VIEW_REQUEST", pending)).resolves.toBeUndefined();

    // The disbursement already started can still be completed.
    await expect(uploadStaffDocument(me, { requestId: pending, category: "PAYSLIP", filename: "p.pdf", data: makePdf("Payslip") })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { id: evidence } = await uploadStaffDocument(officer, { requestId: moving, category: "DISBURSEMENT_EVIDENCE", filename: "receipt.pdf", data: makePdf("Receipt") });
    const r = await reqRow(moving);
    await completeDisbursement(officer, moving, {
      transactionRef: "FT-RETIRE-1",
      valueDate: new Date().toISOString().slice(0, 10),
      amount: String(Number(r.net_kobo) / 100),
      evidenceDocumentId: evidence,
      confirmed: true,
      lockVersion: await lv(moving),
    });
    expect((await reqRow(moving)).status).toBe("COMPLETED");

    // The salary register is read-only; repayments on a paid advance are still recorded.
    const admin = await ctxFor("superadmin@altbank.ng");
    await expect(
      saveRecord(admin, { staffId: applicant, staffNumber: "S1", monthlySalary: "500000", accountNumber: "0123456789", accountName: "X", employmentStatus: "ACTIVE", salaryAsOf: "2026-11-01" } as never, "Correction"),
    ).rejects.toMatchObject({ code: "GATE" });
    const res = await recordRepayment(admin, done, { amount: "100000", valueDate: new Date().toISOString().slice(0, 10), reference: "PAY-NOV-001", source: "PAYROLL_DEDUCTION" });
    expect(res.settled).toBe(false);
  });
});
