import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor, makePdf } from "@/server/demo/scenario";
import { PROFILE, STAFF, approveStaffTemplate, disburse, divisionalApprove, pmForward, reqRow, returnSignedOffer, sid, unitHeadApprove } from "@/server/demo/staff-scenario";
import { createStaffDraft, saveStaffDraft, submitStaffRequest } from "@/server/staff/requests";
import { uploadStaffDocument } from "@/server/staff/documents";
import { proposeStaffSettings } from "@/server/staff/settings";
import { applyImport, eligibilityFor, holdRecord, importView, previewImport, recordRepayment, saveRecord } from "@/server/staff/register";
import { grantRole } from "@/server/domain/admin";
import { lagosDate } from "@/server/time";
import { setStaffAdvanceRetiredForTests } from "@/server/staff/permission";

// Staff Salary Advance is retired; these tests cover the retained workflow code as it ran before retirement.
beforeEach(() => setStaffAdvanceRetiredForTests(false));
afterEach(() => setStaffAdvanceRetiredForTests(true));

beforeEach(resetDb);

const ADMIN = "superadmin@altbank.ng";
const today = () => lagosDate(new Date());
const lv = async (id: string) => (await reqRow(id)).lock_version;

async function registerMode(percent = "50") {
  const cur = (await db.query("SELECT * FROM staff_financing_settings ORDER BY version DESC LIMIT 1")).rows[0];
  await proposeStaffSettings(await ctxFor(ADMIN), {
    deductionPercent: String(cur.deduction_rate_bps / 100),
    tenorOptions: cur.tenor_options_months.join(","),
    requiredDocuments: [],
    unitHeadId: await sid(STAFF.unitHead),
    eligibilityMode: "SALARY_REGISTER",
    eligibilityPercent: percent,
    reason: "Automatic eligibility approved",
  });
}

async function registerApplicant(salary = "1900000", asOf = today()) {
  await saveRecord(await ctxFor(ADMIN), { staffId: await sid(STAFF.applicant), staffNumber: "ALT-04217", monthlySalary: salary, accountNumber: "0123456789", accountName: "ADAEZE OKORO", employmentStatus: "ACTIVE", salaryAsOf: asOf }, "November payroll");
}

async function apply(amount: string) {
  const ctx = await ctxFor(STAFF.applicant);
  const { id } = await createStaffDraft(ctx);
  const r = await saveStaffDraft(ctx, id, { ...PROFILE, salaryAccountNumber: "9999999999", amount, acknowledgedNetKobo: null, acceptDeclaration: true, lockVersion: await lv(id) });
  await saveStaffDraft(ctx, id, { ...PROFILE, amount, acknowledgedNetKobo: String(r.figures.netKobo), acceptDeclaration: true, lockVersion: await lv(id) });
  return { ctx, id, net: String(r.figures.netKobo) };
}

describe("Salary register: automatic eligibility", () => {
  it("₦1,900,000 verified salary → ₦950,000 available; ₦19,000 fee; ₦931,000 received; no bureau check; snapshot recorded", async () => {
    await registerMode();
    await registerApplicant();
    const e = await eligibilityFor(db, await sid(STAFF.applicant), new Date());
    expect(e).toMatchObject({ state: "ELIGIBLE", limitKobo: 95_000_000, availableKobo: 95_000_000 });

    const ctx = await ctxFor(STAFF.applicant);
    const { id } = await createStaffDraft(ctx);
    expect((await reqRow(id)).salary_account_number).toBe("0123456789"); // from the register, not typed
    await expect(saveStaffDraft(ctx, id, { ...PROFILE, amount: "950,000.01", lockVersion: await lv(id) })).rejects.toMatchObject({ code: "VALIDATION", fields: { amount: expect.stringContaining("₦950,000.00") } });
    const r = await saveStaffDraft(ctx, id, { ...PROFILE, salaryAccountNumber: "9999999999", amount: "950,000", acknowledgedNetKobo: "93100000", acceptDeclaration: true, lockVersion: await lv(id) });
    expect(r.figures).toEqual({ grossKobo: "95000000", deductionKobo: "1900000", netKobo: "93100000" });
    expect((await reqRow(id)).salary_account_number).toBe("0123456789"); // the typed account is ignored
    await submitStaffRequest(ctx, id, { lockVersion: await lv(id), acknowledgedNetKobo: "93100000" });
    const row = await reqRow(id);
    expect(row.status).toBe("SUBMITTED");
    expect((row as unknown as { eligibility_snapshot: Record<string, unknown> }).eligibility_snapshot).toMatchObject({ source: "SALARY_REGISTER", salaryKobo: 190_000_000, limitKobo: 95_000_000, availableKobo: 95_000_000 });
    expect((await db.query("SELECT count(*)::int AS n FROM credit_checks WHERE staff_request_id = $1", [id])).rows[0].n).toBe(0);

    // The limit is reserved: a second request cannot start.
    await expect(createStaffDraft(ctx)).rejects.toMatchObject({ code: "GATE", message: expect.stringContaining("fully used") });
    // The Product Manager's checks come from the register.
    await pmForward(id);
    const review = (await db.query("SELECT checklist FROM staff_request_reviews WHERE request_id = $1", [id])).rows[0];
    expect(review.checklist.method).toContain("SALARY_REGISTER");
  });

  it("missing, outdated, held or non-active records are exceptions, not silent approvals", async () => {
    await registerMode();
    const ctx = await ctxFor(STAFF.applicant);
    await expect(createStaffDraft(ctx)).rejects.toMatchObject({ code: "GATE", message: expect.stringContaining("not in the salary register") });
    await registerApplicant("1900000", "2026-01-31");
    await expect(createStaffDraft(ctx)).rejects.toMatchObject({ message: expect.stringContaining("older than 45 days") });
    await registerApplicant("1900000", today());
    await holdRecord(await ctxFor(ADMIN), await sid(STAFF.applicant), true, "Disciplinary review");
    await expect(createStaffDraft(ctx)).rejects.toMatchObject({ message: expect.stringContaining("on hold") });
    await holdRecord(await ctxFor(ADMIN), await sid(STAFF.applicant), false, "Review closed");
    await saveRecord(await ctxFor(ADMIN), { staffId: await sid(STAFF.applicant), staffNumber: "ALT-04217", monthlySalary: "1900000", accountNumber: "0123456789", accountName: "ADAEZE OKORO", employmentStatus: "EXITED", salaryAsOf: today() }, "Employee exited the bank");
    await expect(createStaffDraft(ctx)).rejects.toMatchObject({ message: expect.stringContaining("Exited") });
  });

  it("the percentage is configurable", async () => {
    await registerMode("40");
    await registerApplicant();
    expect((await eligibilityFor(db, await sid(STAFF.applicant), new Date())).limitKobo).toBe(76_000_000);
  });

  it("the default (manual) mode keeps today's behaviour", async () => {
    const s = (await db.query("SELECT eligibility_mode FROM staff_financing_settings ORDER BY version DESC LIMIT 1")).rows[0];
    expect(s.eligibility_mode).toBe("MANUAL");
    const { id } = await createStaffDraft(await ctxFor(STAFF.applicant));
    expect((await reqRow(id)).salary_account_number).toBeNull();
  });
});

describe("Salary register: CSV import with preview", () => {
  it("validates, reports errors and duplicates, previews, then applies only the valid rows", async () => {
    const admin = await ctxFor(ADMIN);
    const csv = [
      "staff_id,ad_identity,employee_name,monthly_salary,salary_account_number,salary_account_name,employment_status,salary_as_of",
      `ALT-04217,${STAFF.applicant},Adaeze Okoro,"1,900,000.00",0123456789,ADAEZE OKORO,ACTIVE,${today()}`,
      `ALT-04218,${STAFF.pm},Wrong Name,1500000,0123456780,X Y Z,ACTIVE,${today()}`,
      `ALT-04219,nobody@altbank.ng,Nobody,1500000,0123456781,No Body,ACTIVE,${today()}`,
      `ALT-04217,${STAFF.unitHead},,1500000,12345,Short,RETIRED,2099-01-01`,
    ].join("\n");
    const id = await previewImport(admin, "november.csv", Buffer.from(csv));
    const v = (await importView(db, id))!;
    expect([v.valid_rows, v.error_rows, v.creates]).toEqual([1, 3, 1]);
    expect(v.errors.map((e) => e.line)).toEqual([3, 4, 5]);
    expect(v.errors[0].message).toMatch(/does not match the staff profile/);
    expect(v.errors[1].message).toMatch(/No ARAF staff profile/);
    expect(v.errors[2].message).toMatch(/Duplicate staff ID.*|10 digits/);
    // Nothing changes until applied.
    expect((await db.query("SELECT count(*)::int AS n FROM salary_register")).rows[0].n).toBe(0);
    expect(await applyImport(admin, id, "APPLY")).toEqual({ created: 1, updated: 0 });
    expect((await db.query("SELECT staff_number, monthly_salary_kobo::text, account_last4 FROM salary_register")).rows).toEqual([{ staff_number: "ALT-04217", monthly_salary_kobo: "190000000", account_last4: "6789" }]);
    expect((await importView(db, id))!.preview).toBeNull(); // preview rows cleared
    await expect(applyImport(admin, id, "APPLY")).rejects.toMatchObject({ code: "CONFLICT" });
    // The audit trail names changed fields, never salary values or account numbers.
    const a = (await db.query("SELECT details::text AS d FROM audit_events WHERE action LIKE 'SALARY_%'")).rows.map((r) => r.d).join(" ");
    expect(a).not.toContain("190000000");
    expect(a).not.toContain("0123456789");
  });

  it("only register administrators (or Super Admins) can import or edit", async () => {
    const pm = await ctxFor(STAFF.pm);
    await expect(previewImport(pm, "x.csv", Buffer.from("staff_id\n"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await grantRole(await ctxFor(ADMIN), { staffId: await sid(STAFF.pm), role: "SALARY_REGISTER_ADMIN" });
    await saveRecord(await ctxFor(STAFF.pm), { staffId: await sid(STAFF.applicant), staffNumber: "ALT-04217", monthlySalary: "1900000", accountNumber: "0123456789", accountName: "ADAEZE OKORO", employmentStatus: "ACTIVE", salaryAsOf: today() }, "November payroll");
    expect((await db.query("SELECT count(*)::int AS n FROM salary_register_history")).rows[0].n).toBe(1);
  });
});

describe("Salary advance: confirmed repayments drive the outstanding balance", () => {
  it("outstanding falls only with recorded repayments; when settled the limit is available again", async () => {
    await registerMode();
    await registerApplicant();
    await approveStaffTemplate();
    const { ctx, id, net } = await apply("950,000");
    await uploadStaffDocument(ctx, { requestId: id, category: "PAYSLIP", filename: "p.pdf", data: makePdf("payslip") });
    await submitStaffRequest(ctx, id, { lockVersion: await lv(id), acknowledgedNetKobo: net });
    await pmForward(id);
    await unitHeadApprove(id);
    await divisionalApprove(id);
    await returnSignedOffer(id);
    await disburse(id);
    expect((await reqRow(id)).status).toBe("COMPLETED");
    const me = await sid(STAFF.applicant);
    let e = await eligibilityFor(db, me, new Date());
    expect([e.outstandingKobo, e.availableKobo, e.state]).toEqual([95_000_000, 0, "FULLY_USED"]);

    const admin = await ctxFor(ADMIN);
    await expect(recordRepayment(await ctxFor(STAFF.applicant), id, { amount: "1000", valueDate: today(), reference: "PAY-NOV-1", source: "PAYROLL_DEDUCTION" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(recordRepayment(admin, id, { amount: "950,000.01", valueDate: today(), reference: "PAY-NOV-1", source: "PAYROLL_DEDUCTION" })).rejects.toMatchObject({ code: "VALIDATION" });
    await recordRepayment(admin, id, { amount: "450,000", valueDate: today(), reference: "PAY-NOV-1", source: "PAYROLL_DEDUCTION" });
    await expect(recordRepayment(admin, id, { amount: "1,000", valueDate: today(), reference: "PAY-NOV-1", source: "PAYROLL_DEDUCTION" })).rejects.toMatchObject({ code: "CONFLICT" });
    e = await eligibilityFor(db, me, new Date());
    expect([e.outstandingKobo, e.availableKobo]).toEqual([50_000_000, 45_000_000]);
    const r = await recordRepayment(admin, id, { amount: "500,000", valueDate: today(), reference: "PAY-DEC-1", source: "PAYROLL_DEDUCTION" });
    expect(r).toEqual({ outstanding: 0, settled: true });
    e = await eligibilityFor(db, me, new Date());
    expect([e.outstandingKobo, e.availableKobo, e.state]).toEqual([0, 95_000_000, "ELIGIBLE"]);
  });
});
