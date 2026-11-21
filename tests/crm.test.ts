import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor, createSubmittedCase } from "@/server/demo/scenario";
import type { Ctx } from "@/server/context";
import { crmCatalogue, crmProducts, crmSettings, FALLBACK_TEAM_ID } from "@/server/crm/core";
import { addUpdate, assignTicket, confirmResolution, createTicket, escalateTicket, listTickets, reopenTicket, requestInformation, resolveTicket, startWork, ticketDetail, transferTicket, DuplicateComplaint } from "@/server/crm/tickets";
import { saveCrmSettings, saveEscalationRule, saveRoutingRule, saveSlaPolicy, saveTeam, setTeamMember, saveSubcategory, saveCategory } from "@/server/crm/config";
import { runCrmAutoClose, runCrmEscalations } from "@/server/crm/jobs";
import { addBusinessMs, businessMsBetween } from "@/server/crm/calendar";
import { crmAnalytics, teamPerformance, officerPerformance } from "@/server/crm/analytics";
import { buildCxReport, reportCsv, reportPdf, runCrmReports } from "@/server/crm/reports";
import { addAttachment, readAttachment } from "@/server/crm/attachments";
import { fromLagos } from "@/server/time";

const ADMIN = "superadmin@altbank.ng";
const REASON = "Configured for the CRM rollout.";
const H = 3_600_000;

async function person(email: string, name: string, role?: string) {
  const id = (await db.query("INSERT INTO staff (email, full_name) VALUES ($1,$2) RETURNING id", [email, name])).rows[0].id as string;
  if (role) await db.query("INSERT INTO role_assignments (staff_id, role) VALUES ($1,$2)", [id, role]);
  return id;
}
/** A context at a fixed instant (server time is what the CRM records). */
async function at(email: string, when: Date): Promise<Ctx> {
  return { ...(await ctxFor(email)), now: when };
}
async function issue(category: string, name: string) {
  const { categories, subcategories } = await crmCatalogue(db);
  const c = categories.find((x) => x.code === category)!;
  return { categoryId: c.id, subcategoryId: subcategories.find((s) => s.category_id === c.id && s.name === name)!.id };
}
async function raise(email: string, when: Date, extra: Partial<Parameters<typeof createTicket>[1]> = {}) {
  const i = await issue("APPROVAL_WORKFLOW", "Request stuck with approver");
  return createTicket(await at(email, when), { idempotencyKey: randomUUID(), productCode: "VENDOR_FINANCING", ...i, subject: "Request stuck at Unit Head", description: "My Vendor Financing request has not moved for two days.", ...extra });
}

let T0: Date;
let ops: string;
let tech: string;
beforeEach(async () => {
  await resetDb();
  T0 = fromLagos(2026, 11, 16, 9, 0); // Monday 09:00 WAT
  const admin = await at(ADMIN, T0);
  ops = await saveTeam(admin, { name: "Product Operations", active: true, reason: REASON });
  tech = await saveTeam(admin, { name: "Technology Support", active: true, reason: REASON });
  await person("lead.ops@altbank.ng", "Lara Ops-Lead");
  await person("officer.a@altbank.ng", "Ade Officer-A");
  await person("lead.tech@altbank.ng", "Tobi Tech-Lead");
  await person("officer.b@altbank.ng", "Bisi Officer-B");
  await person("cx.head@altbank.ng", "Chika CX-Head", "CX_HEAD");
  await setTeamMember(admin, { teamId: ops, email: "lead.ops@altbank.ng", memberRole: "LEAD", reason: REASON });
  await setTeamMember(admin, { teamId: ops, email: "officer.a@altbank.ng", memberRole: "OFFICER", reason: REASON });
  await setTeamMember(admin, { teamId: tech, email: "lead.tech@altbank.ng", memberRole: "LEAD", reason: REASON });
  await setTeamMember(admin, { teamId: tech, email: "officer.b@altbank.ng", memberRole: "OFFICER", reason: REASON });
  const i = await issue("APPROVAL_WORKFLOW", "Request stuck with approver");
  await saveRoutingRule(admin, { categoryId: i.categoryId, teamId: ops, active: true, reason: REASON });
});

describe("CRM registration, routing and lifecycle", () => {
  it("every authorised user can raise a complaint; a unique reference is returned once even on retries", async () => {
    const key = randomUUID();
    const i = await issue("LOGIN_ACCESS", "Access denied");
    const emails = ["rm.ade@altbank.ng", "do1@altbank.ng", "unit.head@altbank.ng", ADMIN];
    const refs: string[] = [];
    for (const e of emails) refs.push((await createTicket(await at(e, T0), { idempotencyKey: randomUUID(), productCode: "PLATFORM", ...i, subject: "Cannot open request", description: "Access denied when opening a request." })).ref);
    expect(new Set(refs).size).toBe(4);
    expect(refs.every((r) => /^ARAF-CRM-\d{6}$/.test(r))).toBe(true);
    const a = await createTicket(await at("rm.ade@altbank.ng", T0), { idempotencyKey: key, productCode: "ALTPHONES", ...(await issue("ORIGINATION", "Phone model availability")), subject: "Model missing", description: "The phone model is not listed." });
    const b = await createTicket(await at("rm.ade@altbank.ng", T0), { idempotencyKey: key, productCode: "ALTPHONES", ...(await issue("ORIGINATION", "Phone model availability")), subject: "Model missing", description: "The phone model is not listed." });
    expect(b).toEqual({ ...a, created: false });
    // Concurrent submissions get distinct references.
    const bola = await at("rm.bola@altbank.ng", T0);
    const many = await Promise.all(Array.from({ length: 6 }, (_, n) => createTicket(bola, { idempotencyKey: randomUUID(), productCode: "PLATFORM", ...i, subject: `Parallel ${n} complaint`, description: `Raised at the same time, number ${n}.` }, ).catch((e) => e)));
    expect(new Set(many.map((m) => m.ref)).size).toBe(6);
  });

  it("product-specific issues only appear for their product; unmatched complaints go to the fallback queue", async () => {
    const { subcategories } = await crmCatalogue(db);
    const phone = subcategories.find((s) => s.name === "Phone model availability")!;
    expect(phone.product_code).toBe("ALTPHONES");
    await expect(createTicket(await at("rm.ade@altbank.ng", T0), { idempotencyKey: randomUUID(), productCode: "WAKEELBOOST", categoryId: phone.category_id, subcategoryId: phone.id, subject: "Wrong product issue", description: "Testing product filter." })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await crmProducts(db)).map((p) => p.code)).toEqual(expect.arrayContaining(["WAKEELBOOST", "VENDOR_FINANCING", "ALT_DRIVE", "ALT_POWER", "ALTPHONES", "STAFF_SALARY_ADVANCE", "PLATFORM"]));
    const t = await createTicket(await at("rm.ade@altbank.ng", T0), { idempotencyKey: randomUUID(), productCode: "ALTPHONES", categoryId: phone.category_id, subcategoryId: phone.id, subject: "Model missing", description: "The phone model is not listed." });
    const row = (await db.query("SELECT team_id, status, routing FROM crm_tickets WHERE id = $1", [t.id])).rows[0];
    expect(row.team_id).toBe(FALLBACK_TEAM_ID);
    expect(row.status).toBe("UNASSIGNED");
    expect(row.routing.fallback).toBe(true);
    // Nobody leads the fallback queue yet, so the CX Head and Super Admin are told.
    const n = (await db.query("SELECT s.email FROM notifications n JOIN staff s ON s.id = n.recipient_id WHERE n.kind = 'CRM_TICKET_QUEUED'")).rows.map((r) => r.email);
    expect(n).toEqual(expect.arrayContaining(["cx.head@altbank.ng", ADMIN]));
  });

  it("routes by rule, Team Lead assigns, officer works, transfers keep history, resolution and confirmation close it", async () => {
    const t = await raise("rm.ade@altbank.ng", T0);
    let d = (await ticketDetail(db, (await db.query("SELECT id FROM staff WHERE email='lead.ops@altbank.ng'")).rows[0].id, t.id))!;
    expect(d.ticket.team_id).toBe(ops);
    const officerA = (await db.query("SELECT id FROM staff WHERE email='officer.a@altbank.ng'")).rows[0].id;
    const officerB = (await db.query("SELECT id FROM staff WHERE email='officer.b@altbank.ng'")).rows[0].id;
    // Only the lead assigns; only team members can be assigned.
    await expect(assignTicket(await at("officer.a@altbank.ng", T0), t.id, officerA)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(assignTicket(await at("lead.ops@altbank.ng", T0), t.id, officerB)).rejects.toMatchObject({ code: "VALIDATION" });
    await assignTicket(await at("lead.ops@altbank.ng", new Date(T0.getTime() + 15 * 60_000)), t.id, officerA);
    await startWork(await at("officer.a@altbank.ng", new Date(T0.getTime() + 25 * 60_000)), t.id);
    await expect(transferTicket(await at("officer.a@altbank.ng", new Date(T0.getTime() + H)), t.id, tech, "short")).rejects.toMatchObject({ code: "VALIDATION" });
    await transferTicket(await at("officer.a@altbank.ng", new Date(T0.getTime() + 100 * 60_000)), t.id, tech, "Approval queue defect: needs Technology Support.");
    await assignTicket(await at("lead.tech@altbank.ng", new Date(T0.getTime() + 105 * 60_000)), t.id, officerB);
    await startWork(await at("officer.b@altbank.ng", new Date(T0.getTime() + 110 * 60_000)), t.id);
    await addUpdate(await at("officer.b@altbank.ng", new Date(T0.getTime() + 120 * 60_000)), t.id, "Queue index rebuilt; checking.", { internal: true });
    await expect(resolveTicket(await at("officer.b@altbank.ng", new Date(T0.getTime() + 190 * 60_000)), t.id, "fixed")).rejects.toMatchObject({ code: "VALIDATION" });
    await resolveTicket(await at("officer.b@altbank.ng", new Date(T0.getTime() + 190 * 60_000)), t.id, "Rebuilt the approval queue; the request is now with the Unit Head.");
    // The complainant sees the public timeline only.
    const rm = (await db.query("SELECT id FROM staff WHERE email='rm.ade@altbank.ng'")).rows[0].id;
    d = (await ticketDetail(db, rm, t.id))!;
    expect(d.view).toBe("PUBLIC");
    expect(d.events.some((e) => e.visibility === "INTERNAL")).toBe(false);
    expect(d.events.map((e) => e.kind)).toEqual(["CREATED", "ROUTED", "ASSIGNED", "STARTED", "TRANSFERRED", "ASSIGNED", "STARTED", "RESOLVED"]);
    // Officer A keeps read access after the transfer.
    expect((await ticketDetail(db, officerA, t.id))!.view).toBe("FULL");
    // A stranger sees nothing.
    expect(await ticketDetail(db, (await db.query("SELECT id FROM staff WHERE email='rm.bola@altbank.ng'")).rows[0].id, t.id)).toBeNull();
    await confirmResolution(await at("rm.ade@altbank.ng", new Date(T0.getTime() + 200 * 60_000)), t.id, { score: 4 });
    const segs = (await db.query("SELECT team_id, officer_id, started_at, ended_at, end_reason FROM crm_assignments WHERE ticket_id = $1 ORDER BY started_at, id", [t.id])).rows;
    expect(segs.map((s) => [s.team_id === ops ? "ops" : "tech", s.officer_id === officerA ? "A" : s.officer_id === officerB ? "B" : null, s.end_reason])).toEqual([
      ["ops", null, "ASSIGNED"],
      ["ops", "A", "TRANSFERRED"],
      ["tech", null, "ASSIGNED"],
      ["tech", "B", "RESOLVED"],
    ]);
    const row = (await db.query("SELECT status, closed_how, satisfaction, reassign_count, resolved_at FROM crm_tickets WHERE id = $1", [t.id])).rows[0];
    expect(row).toMatchObject({ status: "CLOSED", closed_how: "CONFIRMED", satisfaction: 4, reassign_count: 1 });
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'CRM_TICKET_%' AND details->>'ticketId' = $1", [t.id])).rows[0].n).toBeGreaterThanOrEqual(8);
  });

  it("the complainant can supply information, dispute a resolution and reopen with history kept", async () => {
    const t = await raise("rm.ade@altbank.ng", T0);
    const officerA = (await db.query("SELECT id FROM staff WHERE email='officer.a@altbank.ng'")).rows[0].id;
    await assignTicket(await at("lead.ops@altbank.ng", T0), t.id, officerA);
    await requestInformation(await at("officer.a@altbank.ng", new Date(T0.getTime() + H)), t.id, "Which Unit Head is the request with?");
    expect((await db.query("SELECT status FROM crm_tickets WHERE id = $1", [t.id])).rows[0].status).toBe("PENDING_INFO");
    await addUpdate(await at("rm.ade@altbank.ng", new Date(T0.getTime() + 2 * H)), t.id, "It is with the Lagos Unit Head.");
    expect((await db.query("SELECT status FROM crm_tickets WHERE id = $1", [t.id])).rows[0].status).toBe("ASSIGNED");
    await resolveTicket(await at("officer.a@altbank.ng", new Date(T0.getTime() + 3 * H)), t.id, "Reminded the Unit Head; the request has been approved.");
    await expect(confirmResolution(await at("officer.a@altbank.ng", new Date(T0.getTime() + 3 * H)), t.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await reopenTicket(await at("rm.ade@altbank.ng", new Date(T0.getTime() + 4 * H)), t.id, "Still showing at Unit Head on my dashboard.");
    const row = (await db.query("SELECT status, assignee_id, reopen_count FROM crm_tickets WHERE id = $1", [t.id])).rows[0];
    expect(row).toMatchObject({ status: "REOPENED", assignee_id: officerA, reopen_count: 1 });
    expect((await db.query("SELECT count(*)::int AS n FROM crm_events WHERE ticket_id = $1 AND kind = 'RESOLVED'", [t.id])).rows[0].n).toBe(1);
  });

  it("warns about a similar open complaint before creating a duplicate", async () => {
    await raise("rm.ade@altbank.ng", T0);
    await expect(raise("rm.ade@altbank.ng", T0)).rejects.toBeInstanceOf(DuplicateComplaint);
    await expect(raise("rm.ade@altbank.ng", T0, { confirmDuplicate: true })).resolves.toMatchObject({ created: true });
  });

  it("links a financing request only when the user can already open it, and routes by its stage", async () => {
    const appId = await createSubmittedCase({ initiator: "RM", amountKobo: 100_000_000 });
    const app = (await db.query("SELECT ref, stage FROM applications WHERE id = $1", [appId])).rows[0];
    const i = await issue("APPROVAL_WORKFLOW", "Request stuck with approver");
    await saveRoutingRule(await at(ADMIN, T0), { productCode: "WAKEELBOOST", categoryId: i.categoryId, subcategoryId: i.subcategoryId, stage: app.stage, teamId: tech, active: true, reason: REASON });
    const own = await createTicket(await at("rm.ade@altbank.ng", T0), { idempotencyKey: randomUUID(), productCode: "WAKEELBOOST", ...i, requestRef: app.ref, subject: "Stuck request", description: "Not moving at this stage." });
    expect((await db.query("SELECT application_id, team_id, application_stage FROM crm_tickets WHERE id = $1", [own.id])).rows[0]).toMatchObject({ application_id: appId, team_id: tech, application_stage: app.stage });
    // Someone without access to the request: it is recorded as text, never linked.
    const other = await createTicket(await at("rm.bola@altbank.ng", T0), { idempotencyKey: randomUUID(), productCode: "WAKEELBOOST", ...i, requestRef: app.ref, subject: "Stuck request", description: "Not moving at this stage." });
    expect((await db.query("SELECT application_id, related_ref FROM crm_tickets WHERE id = $1", [other.id])).rows[0]).toMatchObject({ application_id: null, related_ref: app.ref });
    await expect(createTicket(await at("rm.bola@altbank.ng", T0), { idempotencyKey: randomUUID(), productCode: "WAKEELBOOST", ...i, applicationId: appId, subject: "Stuck request", description: "Not moving at this stage." })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("SLA, escalation and analytics", () => {
  it("business-hours arithmetic skips nights, weekends and holidays", () => {
    const cal = { working_start: 8, working_end: 17, working_days: [1, 2, 3, 4, 5], holidays: ["2026-11-18"] };
    const fri16 = fromLagos(2026, 11, 20, 16, 0);
    expect(addBusinessMs(fri16, 2 * H, cal).getTime()).toBe(fromLagos(2026, 11, 23, 9, 0).getTime()); // Fri 16:00 + 2h → Mon 09:00
    expect(businessMsBetween(fromLagos(2026, 11, 17, 16, 0), fromLagos(2026, 11, 19, 10, 0), cal)).toBe(3 * H); // Tue 1h + Wed holiday + Thu 2h
    expect(businessMsBetween(fromLagos(2026, 11, 21, 9, 0), fromLagos(2026, 11, 22, 18, 0), cal)).toBe(0); // weekend
  });

  it("applies the SLA policy, pauses for information when configured, and attributes handling time to each team and officer", async () => {
    const admin = await at(ADMIN, T0);
    const s = await crmSettings(db);
    await saveCrmSettings(admin, { fallbackTeamId: s.fallback_team_id, closurePolicy: "CONFIRMATION", closureTimeoutHours: null, workingStart: 8, workingEnd: 17, workingDays: [1, 2, 3, 4, 5], holidays: [], pauseOnPendingInfo: true, reason: REASON });
    await saveSlaPolicy(admin, { name: "Approval issues", categoryId: (await issue("APPROVAL_WORKFLOW", "Request stuck with approver")).categoryId, assignmentMinutes: 30, firstResponseMinutes: 60, resolutionMinutes: 8 * 60, businessHours: true, active: true, reason: REASON });
    const t = await raise("rm.ade@altbank.ng", T0); // Mon 09:00
    let row = (await db.query("SELECT * FROM crm_tickets WHERE id = $1", [t.id])).rows[0];
    expect(new Date(row.resolution_due).getTime()).toBe(fromLagos(2026, 11, 16, 17, 0).getTime()); // 8 working hours from 09:00 → 17:00
    const A = (await db.query("SELECT id FROM staff WHERE email='officer.a@altbank.ng'")).rows[0].id;
    const B = (await db.query("SELECT id FROM staff WHERE email='officer.b@altbank.ng'")).rows[0].id;
    await assignTicket(await at("lead.ops@altbank.ng", fromLagos(2026, 11, 16, 9, 15)), t.id, A); // ops unassigned 15m
    await startWork(await at("officer.a@altbank.ng", fromLagos(2026, 11, 16, 9, 25)), t.id);
    await requestInformation(await at("officer.a@altbank.ng", fromLagos(2026, 11, 16, 10, 0)), t.id, "Please share a screenshot of the queue.");
    await addUpdate(await at("rm.ade@altbank.ng", fromLagos(2026, 11, 16, 11, 0)), t.id, "Screenshot attached."); // 1h paused
    row = (await db.query("SELECT * FROM crm_tickets WHERE id = $1", [t.id])).rows[0];
    expect(Number(row.sla_paused_ms)).toBe(H);
    expect(new Date(row.resolution_due).getTime()).toBe(fromLagos(2026, 11, 17, 9, 0).getTime()); // +1h paused rolls past close → Tue 09:00
    await transferTicket(await at("officer.a@altbank.ng", fromLagos(2026, 11, 16, 12, 0)), t.id, tech, "Needs Technology Support to fix the queue.");
    await assignTicket(await at("lead.tech@altbank.ng", fromLagos(2026, 11, 16, 12, 30)), t.id, B);
    await startWork(await at("officer.b@altbank.ng", fromLagos(2026, 11, 16, 13, 0)), t.id);
    await resolveTicket(await at("officer.b@altbank.ng", fromLagos(2026, 11, 16, 16, 0)), t.id, "Queue repaired and the request moved to the Unit Head.");
    const now = fromLagos(2026, 11, 16, 17, 0);
    const teams = await teamPerformance(db, { from: "2026-11-01", to: "2026-11-30" }, now);
    const opsRow = teams.find((x) => x.team_id === ops)!;
    const techRow = teams.find((x) => x.team_id === tech)!;
    expect(opsRow.handling_ms_total).toBe(3 * H); // 09:00 → 12:00
    expect(techRow.handling_ms_total).toBe(4 * H); // 12:00 → 16:00
    expect(opsRow).toMatchObject({ received: 1, transferred_out: 1, resolved: 0 });
    expect(techRow).toMatchObject({ received: 1, resolved: 1, sla_met: 1, sla_breached: 0 });
    const officers = await officerPerformance(db, { from: "2026-11-01", to: "2026-11-30" }, now);
    expect(officers.find((o) => o.officer_id === A)!.handling_ms_total).toBe(2 * H + 45 * 60_000); // 09:15 → 12:00
    expect(officers.find((o) => o.officer_id === B)!.handling_ms_total).toBe(3.5 * H); // 12:30 → 16:00
    const m = await crmAnalytics(db, { from: "2026-11-01", to: "2026-11-30" }, now);
    expect(m.totals.received).toBe(1);
    expect(m.performance.avg_resolution_ms).toBe(7 * H); // gross
    expect(m.performance.avg_sla_resolution_ms).toBe(6 * H); // business time minus the 1h pause
    expect(m.performance.first_response_avg_ms).toBe(25 * 60_000);
    expect(m.performance.sla_compliance_pct).toBe(100);
  });

  it("escalates once per rule, with SLA warnings and breach alerts to the Team Lead and CX Head", async () => {
    const admin = await at(ADMIN, T0);
    await saveSlaPolicy(admin, { name: "All", resolutionMinutes: 120, businessHours: false, active: true, reason: REASON });
    await saveEscalationRule(admin, { trigger: "UNASSIGNED_OVER", threshold: 30, notifyTeamLead: true, notifyCxHead: false, markEscalated: false, active: true, reason: REASON });
    await saveEscalationRule(admin, { trigger: "APPROACHING_BREACH", threshold: 75, notifyTeamLead: true, notifyCxHead: true, markEscalated: false, active: true, reason: REASON });
    await saveEscalationRule(admin, { trigger: "RESOLUTION_BREACHED", threshold: 1, notifyTeamLead: true, notifyCxHead: true, markEscalated: true, active: true, reason: REASON });
    const t = await raise("rm.ade@altbank.ng", T0);
    expect(await runCrmEscalations(new Date(T0.getTime() + 20 * 60_000))).toBe(0);
    expect(await runCrmEscalations(new Date(T0.getTime() + 40 * 60_000))).toBe(1);
    expect(await runCrmEscalations(new Date(T0.getTime() + 41 * 60_000))).toBe(0); // no duplicates
    expect(await runCrmEscalations(new Date(T0.getTime() + 95 * 60_000))).toBe(1); // 79% used
    expect((await db.query("SELECT escalated FROM crm_tickets WHERE id = $1", [t.id])).rows[0].escalated).toBe(false);
    expect(await runCrmEscalations(new Date(T0.getTime() + 125 * 60_000))).toBe(1);
    expect((await db.query("SELECT escalated FROM crm_tickets WHERE id = $1", [t.id])).rows[0].escalated).toBe(true);
    const to = (await db.query("SELECT s.email, count(*)::int AS n FROM notifications n JOIN staff s ON s.id = n.recipient_id WHERE n.kind = 'CRM_ESCALATION' GROUP BY s.email ORDER BY s.email")).rows;
    expect(to).toEqual([{ email: "cx.head@altbank.ng", n: 2 }, { email: "lead.ops@altbank.ng", n: 3 }]);
    expect((await db.query("SELECT count(*)::int AS n FROM crm_events WHERE ticket_id = $1 AND kind = 'AUTO_ESCALATED'", [t.id])).rows[0].n).toBe(3);
    // Manual escalation by the assigned officer.
    await assignTicket(await at("lead.ops@altbank.ng", T0), t.id, (await db.query("SELECT id FROM staff WHERE email='officer.a@altbank.ng'")).rows[0].id);
    await escalateTicket(await at("officer.a@altbank.ng", T0), t.id, "Customer threatening to cancel.");
  });

  it("closes automatically only when a closure timeout is explicitly configured", async () => {
    const t = await raise("rm.ade@altbank.ng", T0);
    await assignTicket(await at("lead.ops@altbank.ng", T0), t.id, (await db.query("SELECT id FROM staff WHERE email='officer.a@altbank.ng'")).rows[0].id);
    await resolveTicket(await at("officer.a@altbank.ng", T0), t.id, "Fixed the routing and informed the complainant.");
    expect(await runCrmAutoClose(new Date(T0.getTime() + 1000 * H))).toBe(0);
    const s = await crmSettings(db);
    await saveCrmSettings(await at(ADMIN, T0), { fallbackTeamId: s.fallback_team_id, closurePolicy: "TIMEOUT", closureTimeoutHours: 72, workingStart: 8, workingEnd: 17, workingDays: [1, 2, 3, 4, 5], holidays: [], pauseOnPendingInfo: false, reason: REASON });
    expect(await runCrmAutoClose(new Date(T0.getTime() + 71 * H))).toBe(0);
    expect(await runCrmAutoClose(new Date(T0.getTime() + 73 * H))).toBe(1);
    expect((await db.query("SELECT closed_how FROM crm_tickets WHERE id = $1", [t.id])).rows[0].closed_how).toBe("TIMEOUT");
  });
});

describe("CX Head, configuration, reports and access", () => {
  it("the CX Head sees every ticket and can override routing; normal users cannot", async () => {
    const t = await raise("rm.ade@altbank.ng", T0);
    const cx = (await db.query("SELECT id FROM staff WHERE email='cx.head@altbank.ng'")).rows[0].id;
    expect((await ticketDetail(db, cx, t.id))!.view).toBe("FULL");
    await expect(transferTicket(await at("rm.bola@altbank.ng", T0), t.id, tech, "I think tech should do it.")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await transferTicket(await at("cx.head@altbank.ng", T0), t.id, tech, "Misrouted: this is a platform defect.");
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'CRM_ROUTING_OVERRIDDEN'")).rows[0].n).toBe(1);
    expect((await listTickets(db, { kind: "ALL" }, { teamId: tech })).map((r) => r.id)).toEqual([t.id]);
    // The CX Head holds no Super Admin power.
    await expect(saveTeam(await at("cx.head@altbank.ng", T0), { name: "Shadow team", active: true, reason: REASON })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("the Super Admin configures catalogue, teams, routing and SLAs without changing history; reasons are mandatory and audited", async () => {
    const admin = await at(ADMIN, T0);
    await expect(saveCategory(admin, { name: "Collections", active: true, reason: "" })).rejects.toMatchObject({ code: "VALIDATION" });
    const cat = await saveCategory(admin, { name: "Collections", active: true, reason: REASON });
    await saveSubcategory(admin, { categoryId: cat, name: "Wrong collection call", defaultPriority: "HIGH", active: true, reason: REASON });
    const t = await raise("rm.ade@altbank.ng", T0);
    const before = (await db.query("SELECT category_name, subcategory_name, team_id FROM crm_tickets WHERE id = $1", [t.id])).rows[0];
    const { categories } = await crmCatalogue(db);
    const aw = categories.find((c) => c.code === "APPROVAL_WORKFLOW")!;
    await saveCategory(admin, { id: aw.id, name: "Approvals", active: true, sortOrder: 50, reason: REASON });
    expect((await db.query("SELECT category_name, subcategory_name, team_id FROM crm_tickets WHERE id = $1", [t.id])).rows[0]).toEqual(before);
    await expect(saveTeam(admin, { id: ops, name: "Product Operations", active: false, reason: REASON })).rejects.toMatchObject({ code: "VALIDATION" }); // holds an open ticket
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'CRM_CONFIG_%' AND reason IS NOT NULL")).rows[0].n).toBeGreaterThan(5);
  });

  it("attachments are private: the complainant cannot read internal files, strangers cannot read any", async () => {
    const t = await raise("rm.ade@altbank.ng", T0);
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
    const pub = await addAttachment(await at("rm.ade@altbank.ng", T0), t.id, { filename: "screenshot.pdf", data: pdf });
    await assignTicket(await at("lead.ops@altbank.ng", T0), t.id, (await db.query("SELECT id FROM staff WHERE email='officer.a@altbank.ng'")).rows[0].id);
    const internal = await addAttachment(await at("officer.a@altbank.ng", T0), t.id, { filename: "log.pdf", data: pdf, internal: true });
    await expect(readAttachment(await at("officer.a@altbank.ng", T0), pub.id, "view")).resolves.toBeTruthy();
    await expect(readAttachment(await at("rm.ade@altbank.ng", T0), internal.id, "view")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readAttachment(await at("rm.bola@altbank.ng", T0), pub.id, "view")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(addAttachment(await at("rm.ade@altbank.ng", T0), t.id, { filename: "evil.pdf", data: Buffer.from("MZ not a pdf") })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("builds the CX report with team performance and exports CSV and PDF; scheduled reports go only to authorised recipients, once per period", async () => {
    const t = await raise("rm.ade@altbank.ng", T0);
    await assignTicket(await at("lead.ops@altbank.ng", T0), t.id, (await db.query("SELECT id FROM staff WHERE email='officer.a@altbank.ng'")).rows[0].id);
    const r = await buildCxReport(db, "WEEKLY", fromLagos(2026, 11, 23, 8, 0));
    expect(r.analytics.totals.received).toBe(1);
    expect(r.teams.some((x) => x.team_name === "Product Operations")).toBe(true);
    expect(reportCsv(r)).toContain("Product Operations");
    expect((await reportPdf(r)).subarray(0, 5).toString()).toBe("%PDF-");
    await db.query("UPDATE crm_report_schedules SET enabled = true, send_hour = 7 WHERE frequency = 'DAILY'");
    const at8 = fromLagos(2026, 11, 17, 8, 0);
    expect(await runCrmReports(at8)).toBe(1);
    expect(await runCrmReports(new Date(at8.getTime() + 60_000))).toBe(0);
    const mail = (await db.query("SELECT to_addresses FROM notification_outbox WHERE kind = 'CRM_REPORT'")).rows;
    expect(mail.flatMap((m) => m.to_addresses)).toEqual(["cx.head@altbank.ng"]);
  });
});
