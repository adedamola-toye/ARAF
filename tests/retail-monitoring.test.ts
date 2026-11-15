import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor, makePdf } from "@/server/demo/scenario";
import { applyConfig, approveRetailTemplates, createRetailCase, driveBusinessReview, driveCredit, driveToBooking, payAndReconcile, syntheticConfig } from "@/server/demo/retail-scenario";
import { repaymentMonitor, retailBreakdown, retailScope } from "@/server/retail-reports";
import { cbsStatus, coreBankingAdapter } from "@/server/integrations/cbs";
import { recordRepayment } from "@/server/domain/retail-ops";
import { uploadDocument } from "@/server/domain/documents";
import { addDaysToDateString, lagosDate } from "@/server/time";

const N = (n: number) => n * 100;
const loc = async (name: string) => (await db.query("SELECT id FROM locations WHERE name = $1", [name])).rows[0].id as string;
const scopeOf = async (email: string) => (await retailScope(db, (await db.query("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id))!;
const vfCase = (location: string, amount = 10_000_000) =>
  loc(location).then((l) => createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(amount), tenorMonths: 12, incomeBasisKobo: N(10_000_000), proposedMonthlyKobo: N(1_000_000), data: { originationLocationId: l } }));

beforeEach(async () => {
  await resetDb();
  await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING"));
});

describe("executive breakdown", () => {
  it("groups submitted requests by origination location and state, with data freshness", async () => {
    await vfCase("Altbank Kano", 1_000_000);
    await vfCase("Altbank Kano", 2_000_000);
    await vfCase("AltLounge Tanke Ilorin", 3_000_000);
    const scope = await scopeOf("div.head@altbank.ng");
    expect(scope.kind).toBe("ALL");
    const byLoc = await retailBreakdown(db, scope, {}, "location");
    expect(byLoc.rows.find((r) => r.key === "Altbank Kano")).toMatchObject({ submitted: 2, requestedKobo: N(3_000_000), disbursedKobo: 0 });
    expect(byLoc.rows.find((r) => r.key === "AltLounge Tanke Ilorin")).toMatchObject({ submitted: 1 });
    expect(byLoc.freshness.lastApplicationChange).toBeTruthy();
    const byState = await retailBreakdown(db, scope, {}, "state");
    expect(byState.rows.map((r) => r.key).sort()).toEqual(["KANO", "KWARA"]);
    const byRm = await retailBreakdown(db, scope, {}, "rm");
    expect(byRm.rows).toEqual([expect.objectContaining({ key: "Bola Adisa", submitted: 3 })]);
  });

  it("CX Credit Reviewers see the organisation-wide view", async () => {
    const id = (await db.query("INSERT INTO staff (email, full_name, region, business_unit, status) VALUES ('cx.r@altbank.ng','CX Reviewer','LAGOS','Credit','ACTIVE') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO role_assignments (staff_id, role, active) VALUES ($1,'CX_CREDIT_REVIEWER',true)", [id]);
    expect((await retailScope(db, id))?.kind).toBe("ALL");
  });
});

describe("repayment monitoring", () => {
  it("uses only ARAF's own schedule and recorded repayments; PDO awaits a definition; CBS is not connected", async () => {
    await approveRetailTemplates();
    const id = await vfCase("Altbank Abuja");
    await driveBusinessReview(id);
    await driveCredit(id);
    await driveToBooking(id);
    await payAndReconcile(id);
    const fac = (await db.query("SELECT id, total_payable_kobo FROM facilities WHERE application_id = $1", [id])).rows[0];
    const first = (await db.query("SELECT to_char(due_date,'YYYY-MM-DD') AS d, amount_kobo FROM repayment_instalments WHERE facility_id = $1 ORDER BY seq LIMIT 2", [fac.id])).rows;
    const scope = await scopeOf("div.head@altbank.ng");
    // Before the first due date: current, nothing overdue.
    const before = await repaymentMonitor(db, scope, {}, new Date());
    expect(before.totals).toMatchObject({ facilities: 1, overdueKobo: 0, outstandingKobo: Number(fac.total_payable_kobo) });
    expect(before.buckets[0]).toMatchObject({ label: "Current", count: 1 });
    // 40 days after the second instalment, with only the first paid: overdue in the 31–60 bucket.
    const col = await ctxFor("collections@altbank.ng");
    const ev = await uploadDocument(col, { applicationId: id, category: "REPAYMENT_EVIDENCE", filename: "r.pdf", data: makePdf("repayment") });
    await recordRepayment(col, fac.id, { eventType: "RECEIVED", amountKobo: Number(first[0].amount_kobo), valueDate: lagosDate(new Date()), reference: "REP-1", evidenceDocumentIds: [ev.id] });
    const later = new Date(`${addDaysToDateString(first[1].d, 40)}T12:00:00Z`);
    const m = await repaymentMonitor(db, scope, {}, later);
    expect(m.totals.paidKobo).toBe(Number(first[0].amount_kobo));
    expect(m.overdue[0]).toMatchObject({ dpd: 40, overdueKobo: Number(first[1].amount_kobo) + (m.totals.dueToDateKobo - Number(first[0].amount_kobo) - Number(first[1].amount_kobo)) });
    expect(m.buckets[2]).toMatchObject({ label: "31–60 days", count: 1 });
    expect(m.byLocation).toEqual([expect.objectContaining({ key: "Altbank Abuja", count: 1 })]);
    expect(m.sources).toEqual([expect.objectContaining({ source: "MANUAL_EVIDENCE", count: 1 })]);
    expect(m.pdo).toMatchObject({ status: "AWAITING_DEFINITION", definition: null });
    expect((await cbsStatus(db)).status).toBe("NOT_CONNECTED");
    expect(coreBankingAdapter()).toBeNull();
  });
});

describe("tracker switch", () => {
  it("is off by default; only a Super Admin can turn it on; changes are audited", async () => {
    const { isEnabled, setSwitch } = await import("@/server/domain/switches");
    expect(await isEnabled(db, "REPAYMENT_TRACKER")).toBe(false);
    await expect(setSwitch(await ctxFor("div.head@altbank.ng"), "REPAYMENT_TRACKER", true, "Testing access")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setSwitch(await ctxFor("superadmin@altbank.ng"), "REPAYMENT_TRACKER", true, "")).rejects.toMatchObject({ code: "VALIDATION" });
    await setSwitch(await ctxFor("superadmin@altbank.ng"), "REPAYMENT_TRACKER", true, "Manual entries accepted for now");
    expect(await isEnabled(db, "REPAYMENT_TRACKER")).toBe(true);
    expect((await db.query("SELECT details FROM audit_events WHERE action = 'FEATURE_SWITCH_CHANGED'")).rows[0].details).toMatchObject({ key: "REPAYMENT_TRACKER", before: false, after: true });
  });
});
