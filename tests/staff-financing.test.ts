import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor, makePdf } from "@/server/demo/scenario";
import { computeStaffFinancing, bpsLabel, formatNairaKobo } from "@/lib/staff-financing";
import {
  STAFF,
  sid,
  reqRow,
  PROFILE,
  ALL_CHECKS,
  approveStaffTemplate,
  submittedStaffRequest,
  pmForward,
  unitHeadApprove,
  divisionalApprove,
  returnSignedOffer,
  officerEmail,
  disburse,
  MemoryLibrary,
} from "@/server/demo/staff-scenario";
import { createStaffDraft, saveStaffDraft, submitStaffRequest, claimPmReview, pmDecision, unitHeadDecision, divisionalHeadDecision, amendApproval } from "@/server/staff/requests";
import { uploadStaffDocument, readStaffDocument } from "@/server/staff/documents";
import { expireStaffOffers, remindStaffOffers, retryBlockedOffers, submitSignedOffer } from "@/server/staff/offer";
import { startDisbursement, completeDisbursement, reassignDisbursementOfficer } from "@/server/staff/disbursement";
import { advanceDocumentation, processStaffDocumentation, readArchive, confirmHandoverReceipt, completeHandoverReview } from "@/server/staff/pipeline";
import { setDocumentLibraryForTests } from "@/server/staff/sharepoint";
import { viewableRequest } from "@/server/staff/core";
import { grantRole } from "@/server/domain/admin";

const lv = async (id: string) => (await reqRow(id)).lock_version;
const HOUR = 3600_000;

beforeEach(async () => {
  await resetDb();
  setDocumentLibraryForTests(null);
});
afterEach(() => setDocumentLibraryForTests(null));

async function events(id: string) {
  return (await db.query("SELECT action, from_status, to_status FROM staff_request_events WHERE request_id = $1 ORDER BY id", [id])).rows;
}
async function outboxFor(id: string) {
  return (await db.query("SELECT kind, to_addresses, subject, body_text FROM notification_outbox WHERE staff_request_id = $1 ORDER BY created_at", [id])).rows;
}

describe("calculator", () => {
  it("deducts 2% of the gross amount with exact kobo arithmetic, rounding half-up", () => {
    expect(computeStaffFinancing(1_000_000_00, 200)).toEqual({ grossKobo: 1_000_000_00, deductionRateBps: 200, deductionKobo: 20_000_00, netKobo: 980_000_00 });
    // ₦123,456.78 × 2% = ₦2,469.1356 → ₦2,469.14; net ₦120,987.64
    const f = computeStaffFinancing(123_456_78, 200);
    expect(f.deductionKobo).toBe(246_914);
    expect(f.netKobo).toBe(12_098_764);
    expect(f.deductionKobo + f.netKobo).toBe(123_456_78);
    expect(computeStaffFinancing(25, 200).deductionKobo).toBe(1); // 0.5 kobo rounds up
    expect(formatNairaKobo(98_000_000)).toBe("₦980,000.00");
    expect(bpsLabel(200)).toBe("2%");
    expect(() => computeStaffFinancing(0, 200)).toThrow();
  });

  it("the server recalculates on save and only records an acknowledgement of the exact net figure", async () => {
    const ctx = await ctxFor(STAFF.applicant);
    const { id } = await createStaffDraft(ctx);
    const r1 = await saveStaffDraft(ctx, id, { ...PROFILE, amount: "1,500,000.00", acknowledgedNetKobo: "999", acceptDeclaration: true, lockVersion: await lv(id) });
    expect(r1.figures).toEqual({ grossKobo: "150000000", deductionKobo: "3000000", netKobo: "147000000" });
    expect((await reqRow(id)).deduction_acknowledged_at).toBeNull(); // a forged/stale figure is not an acknowledgement
    await expect(submitStaffRequest(ctx, id, { lockVersion: await lv(id) })).rejects.toMatchObject({ code: "VALIDATION", fields: { acknowledgement: expect.any(String) } });
    await saveStaffDraft(ctx, id, { ...PROFILE, amount: "1,500,000.00", acknowledgedNetKobo: "147000000", acceptDeclaration: true, lockVersion: await lv(id) });
    expect((await reqRow(id)).deduction_acknowledged_at).not.toBeNull();
    await submitStaffRequest(ctx, id, { lockVersion: await lv(id), acknowledgedNetKobo: "147000000" });
    const r = await reqRow(id);
    expect([r.status, r.gross_kobo, r.deduction_kobo, r.net_kobo, r.deduction_rate_bps]).toEqual(["SUBMITTED", "150000000", "3000000", "147000000", 200]);
  });

  it("prefills name, email and unit from the staff record and does not invent the rest", async () => {
    const ctx = await ctxFor(STAFF.applicant);
    const { id } = await createStaffDraft(ctx);
    const r = await reqRow(id);
    expect([r.full_name, r.email, r.unit]).toEqual(["Adaeze Okoro", STAFF.applicant, "Finance"]);
    expect([r.staff_number, r.phone, r.salary_account_number]).toEqual([null, null, null]);
    expect(r.ref).toMatch(/^SPR-\d{4}-\d{6}$/);
  });

  it("duplicate submissions are harmless", async () => {
    const id = await submittedStaffRequest();
    const ctx = await ctxFor(STAFF.applicant);
    const again = await submitStaffRequest(ctx, id, {});
    expect(again.duplicate).toBe(true);
    expect((await reqRow(id)).submission_count).toBe(1);
    expect((await events(id)).filter((e) => e.action === "SUBMITTED")).toHaveLength(1);
  });
});

describe("Scenario A: successful application end to end", () => {
  it("submit → PM → Unit Head → Divisional Head → offer → signed within 24h → random officer → disbursed → ZIP → SharePoint verified → Legal and Shariah", async () => {
    const lib = new MemoryLibrary();
    setDocumentLibraryForTests(lib);
    await approveStaffTemplate();
    const t0 = new Date();
    const id = await submittedStaffRequest({ amount: "2,500,000", now: t0 });
    expect((await reqRow(id)).status).toBe("SUBMITTED");
    await pmForward(id);
    let r = await reqRow(id);
    expect([r.status, r.unit_head_id]).toEqual(["UNDER_UNIT_HEAD_REVIEW", await sid(STAFF.unitHead)]);
    const pmReview = (await db.query("SELECT * FROM staff_request_reviews WHERE request_id = $1 AND stage = 'PRODUCT_MANAGER'", [id])).rows[0];
    expect(pmReview.checklist).toMatchObject({ ...ALL_CHECKS, method: expect.stringContaining("MANUAL") });
    await unitHeadApprove(id);
    expect((await reqRow(id)).status).toBe("UNDER_DIVISIONAL_HEAD_REVIEW");
    const approvedAt = new Date();
    await divisionalApprove(id, approvedAt);
    r = await reqRow(id);
    expect(r.status).toBe("AWAITING_SIGNED_OFFER");
    expect(r.approved_terms).toMatchObject({ grossKobo: 250_000_000, deductionKobo: 5_000_000, netKobo: 245_000_000, deductionRateBps: 200 });
    expect(new Date(r.offer_deadline_at).getTime() - new Date(r.offer_issued_at).getTime()).toBe(24 * HOUR);
    // The generated offer carries the approved figures.
    const offer = await readStaffDocument(await ctxFor(STAFF.applicant), r.offer_document_id, "view");
    const html = offer.data.toString("utf8");
    expect(html).toContain("₦2,500,000.00");
    expect(html).toContain("₦50,000.00");
    expect(html).toContain("₦2,450,000.00");
    expect(html).toContain("ALT-04217");
    expect(html).not.toMatch(/\{\{[a-z_]+\}\}/);

    await returnSignedOffer(id, new Date(approvedAt.getTime() + 2 * HOUR));
    r = await reqRow(id);
    expect(r.status).toBe("ASSIGNED_FOR_DISBURSEMENT");
    expect([await sid("do1@altbank.ng"), await sid("do2@altbank.ng")]).toContain(r.disbursement_officer_id);
    const assign = (await db.query("SELECT * FROM staff_request_assignments WHERE request_id = $1", [id])).rows;
    expect(assign).toHaveLength(1);
    expect(assign[0]).toMatchObject({ method: "RANDOM", eligible_count: 2 });

    const txn = await disburse(id);
    r = await reqRow(id);
    expect([r.status, r.disbursement_txn_ref, r.disbursed_amount_kobo]).toEqual(["COMPLETED", txn.toUpperCase(), "245000000"]);
    // Documentation pipeline ran immediately on completion.
    expect(r.documentation_status).toBe("SENT_TO_LEGAL_SHARIAH");
    const archive = (await db.query("SELECT * FROM staff_request_archives WHERE request_id = $1", [id])).rows[0];
    expect(archive.filename).toBe(`ARAF-STAFF-${r.ref}.zip`);
    const sp = (await db.query("SELECT * FROM staff_request_sharepoint WHERE request_id = $1", [id])).rows[0];
    expect(sp.status).toBe("VERIFIED");
    expect(sp.folder_path).toBe("ARAF Staff Financing/STAFF-ALT-04217");
    expect([...lib.files.keys()]).toEqual([`ARAF Staff Financing/STAFF-ALT-04217/ARAF-STAFF-${r.ref}.zip`]);
    expect(sp.folder_path).not.toMatch(/Okoro|0123456789/i);

    // Archive structure and contents
    const { data } = await readArchive(await ctxFor(STAFF.admin), id);
    const zip = await JSZip.loadAsync(data);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).map((n) => n.replace(`ARAF-STAFF-${r.ref}/`, ""));
    expect(names).toEqual(
      expect.arrayContaining([
        "01-application/application-summary.html",
        "03-reviews/product-manager-review.html",
        "03-reviews/unit-head-decision.html",
        "03-reviews/divisional-head-approval.html",
        "05-disbursement/facility-summary.html",
        "06-records/approval-history.html",
        "06-records/audit-report.csv",
        "06-records/manifest.json",
      ]),
    );
    expect(names.some((n) => n.startsWith("02-supporting-documents/") && n.includes("payslip"))).toBe(true);
    expect(names.some((n) => n.startsWith("04-offer/generated-offer-"))).toBe(true);
    expect(names.some((n) => n.startsWith("04-offer/signed-offer-"))).toBe(true);
    expect(names.some((n) => n.startsWith("05-disbursement/disbursement-evidence-"))).toBe(true);
    const manifest = JSON.parse(await zip.file(`ARAF-STAFF-${r.ref}/06-records/manifest.json`)!.async("string"));
    expect(manifest.omitted).toEqual([]);

    // Legal and Shariah handover: one record, two groups, tracked delivery
    const h = (await db.query("SELECT g.* FROM staff_request_handovers h JOIN staff_request_handover_groups g ON g.handover_id = h.id WHERE h.request_id = $1 ORDER BY g.group_code", [id])).rows;
    expect(h.map((g) => [g.group_code, g.status])).toEqual([["LEGAL", "SENT"], ["SHARIAH", "SENT"]]);
    await readArchive(await ctxFor(STAFF.legal), id); // download records Legal's receipt
    expect((await reqRow(id)).documentation_status).toBe("SENT_TO_LEGAL_SHARIAH");
    await confirmHandoverReceipt(await ctxFor(STAFF.shariah), id, "SHARIAH");
    expect((await reqRow(id)).documentation_status).toBe("RECEIVED_BY_LEGAL_SHARIAH");
    await completeHandoverReview(await ctxFor(STAFF.legal), id, "LEGAL", "Documentation complete.");
    await completeHandoverReview(await ctxFor(STAFF.shariah), id, "SHARIAH", "Compliant.");
    r = await reqRow(id);
    expect([r.status, r.documentation_status]).toEqual(["COMPLETED", "REVIEW_COMPLETED"]);

    // History, audit and notifications
    const ev = (await events(id)).map((e) => e.action);
    for (const a of ["SUBMITTED", "PM_REVIEW_STARTED", "PM_FORWARD", "UNIT_HEAD_APPROVE", "DIVISIONAL_HEAD_APPROVE", "OFFER_ISSUED", "SIGNED_OFFER_RECEIVED", "DISBURSEMENT_OFFICER_ASSIGNED", "DISBURSEMENT_STARTED", "DISBURSEMENT_COMPLETED", "ARCHIVE_CREATED", "SHAREPOINT_UPLOAD_VERIFIED", "SENT_TO_LEGAL_SHARIAH"]) {
      expect(ev).toContain(a);
    }
    const audit = (await db.query("SELECT count(*)::int AS n FROM audit_events WHERE staff_request_id = $1", [id])).rows[0].n;
    expect(audit).toBeGreaterThanOrEqual(ev.length);
    const mail = await outboxFor(id);
    const kinds = mail.map((m) => m.kind);
    for (const k of ["STAFF_FIN_SUBMITTED", "STAFF_FIN_QUEUE_PM", "STAFF_FIN_QUEUE_UNIT_HEAD", "STAFF_FIN_QUEUE_DIVISIONAL_HEAD", "STAFF_FIN_APPROVED", "STAFF_FIN_OFFER_ISSUED", "STAFF_FIN_SIGNED_OFFER_RECEIVED", "STAFF_FIN_QUEUE_DISBURSEMENT", "STAFF_FIN_DISBURSED", "STAFF_FIN_LEGAL_SHARIAH_LEGAL", "STAFF_FIN_LEGAL_SHARIAH_SHARIAH"]) {
      expect(kinds).toContain(k);
    }
    for (const m of mail) {
      expect(m.body_text).not.toMatch(/₦|0123456789/); // no amounts or account numbers in email
    }
  });

  it("an offer is not issued until the bank approves the staff template, then issues automatically", async () => {
    const id = await submittedStaffRequest();
    await pmForward(id);
    await unitHeadApprove(id);
    await divisionalApprove(id);
    let r = await reqRow(id);
    expect(r.status).toBe("APPROVED");
    expect(r.offer_blocked_reason).toMatch(/not been approved by the bank/);
    expect(r.offer_deadline_at).toBeNull();
    expect((await outboxFor(id)).map((m) => m.kind)).toContain("STAFF_FIN_EXCEPTION_OFFER_BLOCKED");
    await approveStaffTemplate();
    expect(await retryBlockedOffers()).toBe(1);
    r = await reqRow(id);
    expect(r.status).toBe("AWAITING_SIGNED_OFFER");
  });
});

describe("Scenario B: incomplete Product Manager checklist", () => {
  it("forwarding is blocked until all three manual checks are confirmed", async () => {
    const id = await submittedStaffRequest();
    const ctx = await ctxFor(STAFF.pm);
    await claimPmReview(ctx, id);
    const uh = await sid(STAFF.unitHead);
    const base = { action: "FORWARD" as const, recommendation: "ok", unitHeadId: uh, confirmed: true };
    await expect(pmDecision(ctx, id, { ...base, checklist: { accountVerified: false, salaryHistoryReviewed: false, repaymentWithinLimit: false }, lockVersion: await lv(id) })).rejects.toMatchObject({ code: "GATE" });
    await expect(pmDecision(ctx, id, { ...base, checklist: { accountVerified: true, salaryHistoryReviewed: true, repaymentWithinLimit: false }, lockVersion: await lv(id) })).rejects.toThrow(/50% of take-home pay/);
    await expect(pmDecision(ctx, id, { ...base, confirmed: false, checklist: ALL_CHECKS, lockVersion: await lv(id) })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await reqRow(id)).status).toBe("UNDER_PM_REVIEW");
    expect((await db.query("SELECT count(*)::int AS n FROM staff_request_reviews WHERE request_id = $1", [id])).rows[0].n).toBe(0);
    await pmDecision(ctx, id, { ...base, checklist: ALL_CHECKS, lockVersion: await lv(id) });
    expect((await reqRow(id)).status).toBe("UNDER_UNIT_HEAD_REVIEW");
  });
});

describe("Scenario C: returned request", () => {
  it("the applicant sees the reason, corrects, re-acknowledges and resubmits through the full route", async () => {
    const id = await submittedStaffRequest();
    const pm = await ctxFor(STAFF.pm);
    await claimPmReview(pm, id);
    await pmDecision(pm, id, { action: "RETURN", checklist: { accountVerified: true, salaryHistoryReviewed: false, repaymentWithinLimit: false }, comments: "Upload your last three payslips.", lockVersion: await lv(id) });
    let r = await reqRow(id);
    expect([r.status, r.return_reason, r.returned_from_status]).toEqual(["RETURNED_FOR_CORRECTION", "Upload your last three payslips.", "UNDER_PM_REVIEW"]);
    expect((await outboxFor(id)).map((m) => m.kind)).toContain("STAFF_FIN_RETURNED");
    const me = await ctxFor(STAFF.applicant);
    // Changing the amount clears the acknowledgement: it must be given again for the new figures.
    await saveStaffDraft(me, id, { ...PROFILE, amount: "800,000", acknowledgedNetKobo: String(98_000_000), acceptDeclaration: true, lockVersion: await lv(id) });
    await expect(submitStaffRequest(me, id, { lockVersion: await lv(id) })).rejects.toMatchObject({ fields: { acknowledgement: expect.any(String) } });
    await saveStaffDraft(me, id, { ...PROFILE, amount: "800,000", acknowledgedNetKobo: String(78_400_000), acceptDeclaration: true, lockVersion: await lv(id) });
    await uploadStaffDocument(me, { requestId: id, category: "PAYSLIP", filename: "payslip-aug.pdf", data: makePdf("Payslip August") });
    await submitStaffRequest(me, id, { lockVersion: await lv(id) });
    r = await reqRow(id);
    expect([r.status, r.submission_count, r.pm_reviewer_id, r.net_kobo]).toEqual(["SUBMITTED", 2, null, "78400000"]);
    expect((await events(id)).map((e) => e.action)).toContain("RESUBMITTED");
    // A Unit Head return also goes back to the applicant, and resubmission restarts at the Product Manager.
    await pmForward(id);
    await unitHeadDecision(await ctxFor(STAFF.unitHead), id, { action: "RETURN", comments: "Clarify the purpose.", lockVersion: await lv(id) });
    expect((await reqRow(id)).status).toBe("RETURNED_FOR_CORRECTION");
    await submitStaffRequest(me, id, { lockVersion: await lv(id) });
    expect((await reqRow(id)).status).toBe("SUBMITTED");
    // Returns and declines require a reason.
    await claimPmReview(pm, id);
    await expect(pmDecision(pm, id, { action: "DECLINE", checklist: ALL_CHECKS, comments: "", lockVersion: await lv(id) })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("Scenario D: expired offer", () => {
  it("expires after 24 hours on the server and blocks disbursement", async () => {
    await approveStaffTemplate();
    const id = await submittedStaffRequest();
    await pmForward(id);
    await unitHeadApprove(id);
    const t = new Date();
    await divisionalApprove(id, t);
    expect(await remindStaffOffers(new Date(t.getTime() + 19 * HOUR))).toBe(0);
    expect(await remindStaffOffers(new Date(t.getTime() + 21 * HOUR))).toBe(1);
    expect(await remindStaffOffers(new Date(t.getTime() + 22 * HOUR))).toBe(0); // one reminder only
    expect(await expireStaffOffers(new Date(t.getTime() + 23 * HOUR))).toBe(0);
    expect(await expireStaffOffers(new Date(t.getTime() + 24 * HOUR + 1000))).toBe(1);
    const r = await reqRow(id);
    expect([r.status, r.disbursement_officer_id]).toEqual(["OFFER_EXPIRED", null]);
    expect((await outboxFor(id)).map((m) => m.kind)).toEqual(expect.arrayContaining(["STAFF_FIN_OFFER_REMINDER", "STAFF_FIN_OFFER_EXPIRED"]));
    // No upload, no acceptance, no disbursement after expiry; history is kept.
    const me = await ctxFor(STAFF.applicant, new Date(t.getTime() + 25 * HOUR));
    await expect(uploadStaffDocument(me, { requestId: id, category: "SIGNED_OFFER", filename: "late.pdf", data: makePdf("late") })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(startDisbursement(await ctxFor("do1@altbank.ng"), id, {})).rejects.toBeTruthy();
    expect((await events(id)).length).toBeGreaterThan(8);
  });

  it("is enforced at submission even if the job has not run yet", async () => {
    await approveStaffTemplate();
    const id = await submittedStaffRequest();
    await pmForward(id);
    await unitHeadApprove(id);
    const t = new Date();
    await divisionalApprove(id, t);
    const before = await ctxFor(STAFF.applicant, new Date(t.getTime() + 23 * HOUR));
    const { id: doc } = await uploadStaffDocument(before, { requestId: id, category: "SIGNED_OFFER", filename: "signed.pdf", data: makePdf("signed") });
    const after = await ctxFor(STAFF.applicant, new Date(t.getTime() + 24 * HOUR + 60_000));
    await expect(submitSignedOffer(after, id, { documentId: doc, confirmed: true })).rejects.toThrow(/expired/);
    expect((await reqRow(id)).status).toBe("OFFER_EXPIRED");
  });
});

describe("Scenario E: duplicate disbursement", () => {
  it("an already disbursed facility cannot be processed again, and a transaction reference cannot be reused", async () => {
    setDocumentLibraryForTests(new MemoryLibrary());
    await approveStaffTemplate();
    const id = await submittedStaffRequest();
    await pmForward(id);
    await unitHeadApprove(id);
    await divisionalApprove(id);
    await returnSignedOffer(id);
    const txn = await disburse(id);
    const officer = await ctxFor(await officerEmail(id));
    await expect(startDisbursement(officer, id, {})).rejects.toThrow(/already been disbursed/);
    await expect(completeDisbursement(officer, id, { transactionRef: "FT-OTHER-123", valueDate: "2026-11-12", amount: "980000", evidenceDocumentId: "x", confirmed: true })).rejects.toThrow(/already been disbursed/);
    // the same confirmation replayed (double click) changes nothing
    const replay = await completeDisbursement(officer, id, { transactionRef: txn, valueDate: "2026-11-12", amount: "980000", evidenceDocumentId: "x", confirmed: true });
    expect(replay.disbursement_txn_ref).toBe(txn.toUpperCase());
    expect((await events(id)).filter((e) => e.action === "DISBURSEMENT_COMPLETED")).toHaveLength(1);
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE staff_request_id = $1 AND outcome = 'DENIED' AND action LIKE 'STAFF_FIN_DISBURSEMENT%'", [id])).rows[0].n).toBeGreaterThanOrEqual(2);
    // a second facility cannot reuse the reference
    const other = await submittedStaffRequest({ email: "rm.bola@altbank.ng" });
    await pmForward(other);
    await unitHeadApprove(other);
    await divisionalApprove(other);
    const me = await ctxFor("rm.bola@altbank.ng");
    const { id: doc } = await uploadStaffDocument(me, { requestId: other, category: "SIGNED_OFFER", filename: "s.pdf", data: makePdf("s") });
    await submitSignedOffer(me, other, { documentId: doc, confirmed: true, lockVersion: await lv(other) });
    await expect(disburse(other, new Date(), txn)).rejects.toThrow(/already recorded against another facility/);
  });

  it("the amount must equal the approved net amount", async () => {
    await approveStaffTemplate();
    const id = await submittedStaffRequest();
    await pmForward(id);
    await unitHeadApprove(id);
    await divisionalApprove(id);
    await returnSignedOffer(id);
    const officer = await ctxFor(await officerEmail(id));
    const { reviewDisbursementDocumentation } = await import("@/server/staff/disbursement");
    await reviewDisbursementDocumentation(officer, id, { lockVersion: await lv(id) });
    await startDisbursement(officer, id, { lockVersion: await lv(id) });
    const { id: ev } = await uploadStaffDocument(officer, { requestId: id, category: "DISBURSEMENT_EVIDENCE", filename: "r.pdf", data: makePdf("r") });
    await expect(completeDisbursement(officer, id, { transactionRef: "FT-000111", valueDate: "2026-11-11", amount: "1000000", evidenceDocumentId: ev, confirmed: true, lockVersion: await lv(id) })).rejects.toMatchObject({ fields: { amount: expect.stringContaining("₦980,000.00") } });
  });
});

describe("Scenario F: SharePoint failure", () => {
  it("records the failure, retries securely, never reports delivery or hands over early, and recovers", async () => {
    const lib = new MemoryLibrary();
    lib.failNext = 2;
    setDocumentLibraryForTests(lib);
    await approveStaffTemplate();
    const id = await submittedStaffRequest();
    await pmForward(id);
    await unitHeadApprove(id);
    await divisionalApprove(id);
    await returnSignedOffer(id);
    const t = new Date();
    await disburse(id, t);
    let r = await reqRow(id);
    expect([r.status, r.documentation_status]).toEqual(["COMPLETED", "AWAITING_SHAREPOINT"]);
    let sp = (await db.query("SELECT * FROM staff_request_sharepoint WHERE request_id = $1", [id])).rows[0];
    expect([sp.status, sp.attempts, sp.verified_at]).toEqual(["FAILED", 1, null]);
    expect(sp.last_error).toMatch(/503/);
    expect((await db.query("SELECT count(*)::int AS n FROM staff_request_handovers WHERE request_id = $1", [id])).rows[0].n).toBe(0);
    expect((await outboxFor(id)).map((m) => m.kind)).toContain("STAFF_FIN_EXCEPTION_SHAREPOINT");
    expect(new Date(r.doc_next_attempt_at).getTime()).toBeGreaterThan(t.getTime());
    // Not due yet: nothing happens. Due: retried (fails again), then succeeds.
    expect(await processStaffDocumentation(new Date(t.getTime() + 1000))).toEqual({});
    await processStaffDocumentation(new Date(t.getTime() + 2 * 60_000));
    sp = (await db.query("SELECT * FROM staff_request_sharepoint WHERE request_id = $1", [id])).rows[0];
    expect([sp.status, sp.attempts]).toEqual(["FAILED", 2]);
    await processStaffDocumentation(new Date(t.getTime() + 10 * 60_000));
    sp = (await db.query("SELECT * FROM staff_request_sharepoint WHERE request_id = $1", [id])).rows[0];
    expect(sp.status).toBe("VERIFIED");
    r = await reqRow(id);
    expect(r.documentation_status).toBe("SENT_TO_LEGAL_SHARIAH");
    expect((await db.query("SELECT count(*)::int AS n FROM staff_request_archives WHERE request_id = $1", [id])).rows[0].n).toBe(1);
    expect(lib.files.size).toBe(1);
    // Running again creates nothing new.
    expect(await advanceDocumentation(id)).toBe("SENT_TO_LEGAL_SHARIAH");
    expect((await db.query("SELECT count(*)::int AS n FROM staff_request_handovers WHERE request_id = $1", [id])).rows[0].n).toBe(1);
  });

  it("a checksum mismatch is not accepted as delivery", async () => {
    const lib = new MemoryLibrary();
    lib.corrupt = true;
    setDocumentLibraryForTests(lib);
    await approveStaffTemplate();
    const id = await submittedStaffRequest();
    await pmForward(id);
    await unitHeadApprove(id);
    await divisionalApprove(id);
    await returnSignedOffer(id);
    await disburse(id);
    const sp = (await db.query("SELECT * FROM staff_request_sharepoint WHERE request_id = $1", [id])).rows[0];
    expect(sp.status).toBe("FAILED");
    expect(sp.last_error).toMatch(/checksum mismatch/);
    expect((await reqRow(id)).documentation_status).toBe("AWAITING_SHAREPOINT");
  });

  it("without SharePoint configuration the archive stays in encrypted storage and the handover proceeds, recorded as such", async () => {
    await approveStaffTemplate();
    const id = await submittedStaffRequest();
    await pmForward(id);
    await unitHeadApprove(id);
    await divisionalApprove(id);
    await returnSignedOffer(id);
    await disburse(id);
    expect((await reqRow(id)).documentation_status).toBe("SENT_TO_LEGAL_SHARIAH");
    expect((await db.query("SELECT count(*)::int AS n FROM staff_request_sharepoint WHERE request_id = $1", [id])).rows[0].n).toBe(0);
    expect((await events(id)).map((e) => e.action)).toContain("SHAREPOINT_NOT_CONFIGURED");
  });
});

describe("Scenario H: unauthorised actions and separation of duties", () => {
  it("a staff member cannot approve their own request or open another staff member's request", async () => {
    // The applicant also holds every review role: still refused on their own request.
    const admin = await ctxFor(STAFF.admin);
    const me = await sid(STAFF.applicant);
    for (const role of ["PRODUCT_MANAGER", "UNIT_HEAD", "DIVISIONAL_HEAD", "DISBURSEMENT_OFFICER_1"]) await grantRole(admin, { staffId: me, role });
    const id = await submittedStaffRequest();
    const self = await ctxFor(STAFF.applicant);
    await expect(claimPmReview(self, id)).rejects.toThrow(/own financing request/);
    const denied = (await db.query("SELECT * FROM audit_events WHERE staff_request_id = $1 AND outcome = 'DENIED'", [id])).rows;
    expect(denied.length).toBeGreaterThan(0);
    // Another staff member cannot open it.
    const other = await ctxFor("rm.bola@altbank.ng");
    await expect(viewableRequest(other, id, db)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE staff_request_id = $1 AND action = 'STAFF_FIN_VIEW_DENIED'", [id])).rows[0].n).toBe(1);
    const doc = (await db.query("SELECT id FROM staff_request_documents WHERE request_id = $1", [id])).rows[0];
    await expect(readStaffDocument(other, doc.id, "view")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("only the designated Unit Head decides; one person cannot fill two positions; workflow steps cannot be skipped", async () => {
    const id = await submittedStaffRequest();
    // Unit Head cannot act before the PM has forwarded.
    await expect(unitHeadDecision(await ctxFor(STAFF.unitHead), id, { action: "APPROVE", confirmed: true })).rejects.toMatchObject({ code: "CONFLICT" });
    await pmForward(id);
    // A second Unit Head who was not designated is refused.
    const admin = await ctxFor(STAFF.admin);
    await grantRole(admin, { staffId: await sid("hou@altbank.ng"), role: "UNIT_HEAD" });
    await expect(unitHeadDecision(await ctxFor("hou@altbank.ng"), id, { action: "APPROVE", confirmed: true })).rejects.toThrow(/designated Unit Head/);
    // The PM cannot also be the Divisional Head on the same request.
    await grantRole(admin, { staffId: await sid(STAFF.pm), role: "DIVISIONAL_HEAD" });
    await unitHeadApprove(id);
    await expect(divisionalHeadDecision(await ctxFor(STAFF.pm), id, { action: "APPROVE", confirmed: true })).rejects.toThrow(/Separation of duties/);
    // Disbursement Officers who reviewed are excluded from random assignment.
    await grantRole(admin, { staffId: await sid(STAFF.divHead), role: "DISBURSEMENT_OFFICER_1" });
    await approveStaffTemplate();
    await divisionalApprove(id);
    await returnSignedOffer(id);
    const r = await reqRow(id);
    expect(r.disbursement_officer_id).not.toBe(await sid(STAFF.divHead));
    expect((await db.query("SELECT eligible_count FROM staff_request_assignments WHERE request_id = $1", [id])).rows[0].eligible_count).toBe(2);
    // Only Super Admins reassign, and only to eligible officers.
    await expect(reassignDisbursementOfficer(await ctxFor(STAFF.pm), id, { officerId: await sid("do1@altbank.ng"), reason: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(reassignDisbursementOfficer(admin, id, { officerId: await sid(STAFF.divHead), reason: "workload" })).rejects.toThrow(/not an eligible/);
    const other = r.disbursement_officer_id === (await sid("do1@altbank.ng")) ? "do2@altbank.ng" : "do1@altbank.ng";
    await reassignDisbursementOfficer(await ctxFor(STAFF.admin), id, { officerId: await sid(other), reason: "Leave cover" });
    const hist = (await db.query("SELECT method, ended_at FROM staff_request_assignments WHERE request_id = $1 ORDER BY assigned_at", [id])).rows;
    expect(hist.map((h) => [h.method, h.ended_at === null])).toEqual([["RANDOM", false], ["ADMIN_REASSIGNMENT", true]]);
  });

  it("archives are limited to Super Admins and Legal and Shariah reviewers", async () => {
    setDocumentLibraryForTests(new MemoryLibrary());
    await approveStaffTemplate();
    const id = await submittedStaffRequest();
    await pmForward(id);
    await unitHeadApprove(id);
    await divisionalApprove(id);
    await returnSignedOffer(id);
    await disburse(id);
    await expect(readArchive(await ctxFor(STAFF.applicant), id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(readArchive(await ctxFor(STAFF.pm), id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(confirmHandoverReceipt(await ctxFor(STAFF.legal), id, "SHARIAH")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("approved terms are locked; amendments need reapproval", () => {
  it("a direct change after approval is refused by the database; an amendment withdraws approval and restarts the route", async () => {
    await approveStaffTemplate();
    const id = await submittedStaffRequest();
    await pmForward(id);
    await unitHeadApprove(id);
    await divisionalApprove(id);
    await expect(db.query("UPDATE staff_requests SET gross_kobo = gross_kobo + 100, deduction_kobo = deduction_kobo + 2, net_kobo = net_kobo + 98 WHERE id = $1", [id])).rejects.toThrow(/locked/);
    await expect(amendApproval(await ctxFor(STAFF.pm), id, { reason: "Change amount" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await amendApproval(await ctxFor(STAFF.divHead), id, { reason: "Applicant asked to reduce the amount", lockVersion: await lv(id) });
    let r = await reqRow(id);
    expect([r.status, r.approved_at, r.offer_document_id]).toEqual(["RETURNED_FOR_CORRECTION", null, null]);
    const me = await ctxFor(STAFF.applicant);
    await saveStaffDraft(me, id, { ...PROFILE, amount: "600,000", acknowledgedNetKobo: String(58_800_000), acceptDeclaration: true, lockVersion: await lv(id) });
    await submitStaffRequest(me, id, { lockVersion: await lv(id) });
    r = await reqRow(id);
    expect([r.status, r.net_kobo]).toEqual(["SUBMITTED", "58800000"]);
    // The previous terms remain in the history
    const ev = (await db.query("SELECT details FROM staff_request_events WHERE request_id = $1 AND action = 'APPROVAL_WITHDRAWN_FOR_AMENDMENT'", [id])).rows[0];
    expect(ev.details.previousTerms.netKobo).toBe(98_000_000);
  });
});
