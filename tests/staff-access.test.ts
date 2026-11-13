import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor, makePdf } from "@/server/demo/scenario";
import { systemCtx } from "@/server/context";
import { PROFILE, reqRow, sid, submittedStaffRequest } from "@/server/demo/staff-scenario";
import { STAFF_FINANCING_RESTRICTED_MESSAGE, requireStaffFinancing, staffFinancingAccess } from "@/server/staff/permission";
import { createStaffDraft, saveStaffDraft, submitStaffRequest, claimPmReview, pmDecision } from "@/server/staff/requests";
import { runStaffCreditCheck } from "@/server/staff/credit";
import { uploadStaffDocument, readStaffDocument, rescanStaffDocuments } from "@/server/staff/documents";
import { viewableRequest } from "@/server/staff/core";
import { grantRole } from "@/server/domain/admin";
import { setupAltphones, ALT } from "@/server/demo/altphones-scenario";
import { startSale } from "@/server/altphones/origination";

const SA = "sa.tobi@altbank.ng";
const APPLICANT = "staff.okoro@altbank.ng";
const denied = { code: "FORBIDDEN", message: STAFF_FINANCING_RESTRICTED_MESSAGE };

beforeEach(async () => {
  await resetDb();
});

const count = async (sql: string, p: unknown[] = []) => Number((await db.query(sql, p)).rows[0].n);
const denials = () => db.query("SELECT actor_id, actor_role, reason, details, occurred_at FROM audit_events WHERE action = 'STAFF_FINANCING_ACCESS_DENIED' ORDER BY id").then((r) => r.rows);

describe("Staff Financing permission policy", () => {
  it("refuses Smile Associates, unprofiled and inactive staff; allows profiled employees", async () => {
    expect(await staffFinancingAccess(db, await sid(SA))).toMatchObject({ allowed: false, reason: "RESTRICTED_ROLE" });
    expect(await staffFinancingAccess(db, await sid(APPLICANT))).toMatchObject({ allowed: true });
    expect(await staffFinancingAccess(db, await sid("rm.ade@altbank.ng"))).toMatchObject({ allowed: true });
    expect(await staffFinancingAccess(db, null)).toMatchObject({ allowed: false, reason: "UNAUTHENTICATED" });
    // Unprofiled: an active staff record with no role assignment.
    const bare = (await db.query("INSERT INTO staff (email, full_name, status) VALUES ('no.role@altbank.ng','No Role','ACTIVE') RETURNING id")).rows[0].id;
    expect(await staffFinancingAccess(db, bare)).toMatchObject({ allowed: false, reason: "UNPROFILED" });
    await db.query("UPDATE staff SET status = 'SUSPENDED' WHERE email = $1", [APPLICANT]);
    expect(await staffFinancingAccess(db, await sid(APPLICANT))).toMatchObject({ allowed: false, reason: "INACTIVE" });
  });

  it("a Smile Associate cannot create a draft; the attempt is audited with user, role, action and time", async () => {
    const ctx = await ctxFor(SA, new Date(), {});
    ctx.actor!.activeRole = "SMILE_ASSOCIATE";
    await expect(createStaffDraft(ctx)).rejects.toMatchObject(denied);
    expect(await count("SELECT count(*) AS n FROM staff_requests")).toBe(0);
    const [d] = await denials();
    expect(d.actor_id).toBe(await sid(SA));
    expect(d.actor_role).toBe("SMILE_ASSOCIATE");
    expect(d.reason).toBe("RESTRICTED_ROLE");
    expect(d.details).toMatchObject({ attemptedAction: "CREATE_STAFF_DRAFT", roles: ["SMILE_ASSOCIATE"] });
    expect(d.occurred_at).toBeInstanceOf(Date);
  });

  it("the restriction holds when the Smile Associate also holds other roles, including approver roles", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    await grantRole(admin, { staffId: await sid(SA), role: "STAFF_APPLICANT" });
    await grantRole(admin, { staffId: await sid(SA), role: "PRODUCT_MANAGER" });
    await expect(createStaffDraft(await ctxFor(SA))).rejects.toMatchObject(denied);
    // A submitted request from a properly profiled employee: the SA (now also a PM) cannot touch it.
    const id = await submittedStaffRequest();
    const before = (await reqRow(id)).status;
    await expect(claimPmReview(await ctxFor(SA), id)).rejects.toMatchObject(denied);
    await expect(pmDecision(await ctxFor(SA), id, { decision: "APPROVE", comments: "x", checklist: {} } as never)).rejects.toMatchObject(denied);
    expect((await reqRow(id)).status).toBe(before);
  });

  it("a Smile Associate cannot read, edit, submit, run SeedFi on, or upload to someone else's request", async () => {
    const owner = await ctxFor(APPLICANT);
    const { id } = await createStaffDraft(owner);
    const sa = () => ctxFor(SA);
    const lv = (await reqRow(id)).lock_version;
    await expect(viewableRequest(await sa(), id, db)).rejects.toMatchObject(denied);
    await expect(saveStaffDraft(await sa(), id, { ...PROFILE, amount: "500,000", lockVersion: lv })).rejects.toMatchObject(denied);
    await expect(submitStaffRequest(await sa(), id, { lockVersion: lv } as never)).rejects.toMatchObject(denied);
    await expect(runStaffCreditCheck(await sa(), id, { bvn: "22222222222", firstName: "A", lastName: "B", dateOfBirth: "1990-01-01", gender: "male", phone: "08031234567", consent: true } as never)).rejects.toMatchObject(denied);
    await expect(uploadStaffDocument(await sa(), { requestId: id, category: "PAYSLIP", filename: "p.pdf", data: makePdf("x") } as never)).rejects.toMatchObject(denied);
    await expect(readStaffDocument(await sa(), "00000000-0000-0000-0000-000000000000", "view")).rejects.toMatchObject(denied);
    // Nothing changed: no draft edits, no status change, no SeedFi check, no document.
    const r = await reqRow(id);
    expect([r.status, r.lock_version, r.amount_kobo ?? null]).toEqual(["DRAFT", lv, null]);
    expect(await count("SELECT count(*) AS n FROM credit_checks WHERE staff_request_id = $1", [id])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM staff_request_documents WHERE request_id = $1", [id])).toBe(0);
    const actions = (await denials()).map((d) => d.details.attemptedAction);
    expect(actions).toEqual(["VIEWABLE_REQUEST", "SAVE_STAFF_DRAFT", "SUBMIT_STAFF_REQUEST", "RUN_STAFF_CREDIT_CHECK", "UPLOAD_STAFF_DOCUMENT", "READ_STAFF_DOCUMENT"]);
  });

  it("a Smile Associate keeps full Altphones access", async () => {
    const { models } = await setupAltphones();
    const { id } = await startSale(await ctxFor(ALT.sa), { kind: "CREDIT", modelId: models[0] });
    expect((await db.query("SELECT status FROM altphones_applications WHERE id = $1", [id])).rows[0].status).toBe("DRAFT");
  });

  it("properly profiled employees and reviewers are unaffected; background jobs are not blocked", async () => {
    const id = await submittedStaffRequest();
    expect((await reqRow(id)).status).not.toBe("DRAFT");
    await expect(requireStaffFinancing(await ctxFor(APPLICANT), "CHECK")).resolves.toBeUndefined();
    await expect(requireStaffFinancing(systemCtx(), "WORKER")).resolves.toBeUndefined();
    await expect(rescanStaffDocuments()).resolves.toBeUndefined();
    // A request context without a user is never treated as a background job.
    await expect(requireStaffFinancing({ ...systemCtx(), system: undefined }, "FORGED")).rejects.toMatchObject(denied);
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE action = 'STAFF_FINANCING_ACCESS_DENIED'")).toBe(1);
  });
});
