import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { assignUser, classify, listIncidents, normaliseRoute, recordFailure, sanitiseMessage, transitionIncident, viewForDigest } from "@/server/incidents";
import { INCIDENT_MESSAGES, messageByNo } from "@/lib/incident-messages";

const ADMIN = "superadmin@altbank.ng";

beforeEach(async () => {
  await resetDb();
  delete process.env.INCIDENT_ALERT_EMAILS;
});

const boom = (msg = "relation \"x\" does not exist") => Object.assign(new Error(msg), { code: "42P01" });

/** Open an incident (no user yet) and return its id. */
async function newIncident(route = "/queue", err: unknown = boom()) {
  return (await recordFailure({ source: "render", route, error: err })).incident.id;
}

/** Assign `n` distinct users, `parallel` at a time; returns the per-message counts from the database. */
async function assignMany(id: string, n: number, parallel = 10, prefix = "staff:u") {
  for (let i = 0; i < n; i += parallel) {
    await Promise.all(Array.from({ length: Math.min(parallel, n - i) }, (_, k) => assignUser(id, `${prefix}${i + k}`)));
  }
  const r = (await db.query("SELECT message_counts, affected_users FROM incidents WHERE id = $1", [id])).rows[0];
  const fromRows = (await db.query("SELECT message_no, count(*)::int AS n FROM incident_assignments WHERE incident_id = $1 GROUP BY 1", [id])).rows;
  const counts: number[] = r.message_counts;
  for (const row of fromRows) expect(counts[row.message_no - 1]).toBe(row.n); // counters match the rows
  expect(r.affected_users).toBe(n);
  return counts;
}
const sorted = (a: number[]) => [...a].sort((x, y) => y - x);

describe("approved messages", () => {
  it("has exactly the five approved messages, each with its own headline and description", () => {
    expect(INCIDENT_MESSAGES.map((m) => m.no)).toEqual([1, 2, 3, 4, 5]);
    expect(messageByNo(1).headline).toBe("An error? When you've got financial targets to smash? Unacceptable!");
    expect(messageByNo(3).headline).toBe("Not today, error. We've got a bank to run!");
    expect(messageByNo(5).description).toBe("We know you've got deals to close and targets to conquer. The Genius Digital Banking Team doesn't let a little technical hiccup stand between ambition and execution. 💼");
  });
});

describe("balanced message distribution", () => {
  it("1 user: exactly one assignment", async () => {
    const counts = await assignMany(await newIncident(), 1);
    expect(sorted(counts)).toEqual([1, 0, 0, 0, 0]);
  });

  it("5 users: five distinct messages", async () => {
    const id = await newIncident();
    await assignMany(id, 5, 1);
    const nos = (await db.query("SELECT message_no FROM incident_assignments WHERE incident_id = $1 ORDER BY seq", [id])).rows.map((r) => r.message_no);
    expect(new Set(nos).size).toBe(5);
  });

  it("10 users: two per message", async () => {
    expect(await assignMany(await newIncident(), 10)).toEqual([2, 2, 2, 2, 2]);
  });

  it("63 users: 13, 13, 13, 12, 12", async () => {
    expect(sorted(await assignMany(await newIncident(), 63))).toEqual([13, 13, 13, 12, 12]);
  });

  it("2,000 users: exactly 400 each; 2,003 users: 401, 401, 401, 400, 400", async () => {
    const id = await newIncident();
    expect(await assignMany(id, 2000, 20)).toEqual([400, 400, 400, 400, 400]);
    expect(sorted(await assignMany(id, 2003, 20))).toEqual([401, 401, 401, 400, 400]); // users 0–1999 keep theirs; 3 new
  }, 120_000);

  it("concurrent requests never unbalance the allocation", async () => {
    const id = await newIncident();
    const counts = await assignMany(id, 97, 40); // 40 users at once, through the connection pool
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(97);
  });

  it("the same user always gets the same message, and repeats do not count again", async () => {
    const id = await newIncident();
    const first = await assignUser(id, "staff:same");
    const again = await Promise.all([assignUser(id, "staff:same"), assignUser(id, "staff:same"), assignUser(id, "staff:same")]);
    expect(again.every((v) => v!.messageNo === first!.messageNo && v!.ref === first!.ref)).toBe(true);
    expect((await db.query("SELECT affected_users FROM incidents WHERE id = $1", [id])).rows[0].affected_users).toBe(1);
  });

  it("each new incident gets its own fresh, shuffled sequence", async () => {
    const orders = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const id = await newIncident(`/route-${i}`);
      const o = (await db.query("SELECT message_order FROM incidents WHERE id = $1", [id])).rows[0].message_order;
      expect([...o].sort()).toEqual([1, 2, 3, 4, 5]);
      orders.add(o.join());
      expect((await assignUser(id, "staff:first"))!.messageNo).toBe(o[0]); // starts afresh at position 0
    }
    expect(orders.size).toBeGreaterThan(1); // 12 shuffles of 120 possibilities are not all identical
  });
});

describe("incident correlation and lifecycle", () => {
  it("the same failure on different records shares one reference; unrelated failures do not", async () => {
    const a = await recordFailure({ source: "render", route: "/requests/0f8fad5b-d9cb-469f-a165-70867728950e/edit", error: boom(), subject: "staff:a" });
    const b = await recordFailure({ source: "render", route: "/requests/7c9e6679-7425-40de-944b-e07fc1f90ae7/edit", error: boom(), subject: "staff:b" });
    expect(b.view!.ref).toBe(a.view!.ref);
    expect(a.view!.ref).toMatch(/^ARAF-\d{4}-\d{4}$/);
    expect(b.view!.messageNo).not.toBe(a.view!.messageNo); // two users, two different messages
    // Same status code, different failure / different place: separate incidents.
    const c = await recordFailure({ source: "render", route: "/requests/0f8fad5b-d9cb-469f-a165-70867728950e/edit", error: new TypeError("Cannot read properties of undefined (reading 'amount')"), subject: "staff:a" });
    const d = await recordFailure({ source: "render", route: "/reports", error: boom(), subject: "staff:a" });
    expect(new Set([a.view!.ref, c.view!.ref, d.view!.ref]).size).toBe(3);
    // A database outage is one incident wherever it surfaces.
    const down = (route: string) => recordFailure({ source: "render", route, error: Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" }), subject: `staff:${route}` });
    const [x, y] = [await down("/queue"), await down("/altphones")];
    expect(x.view!.ref).toBe(y.view!.ref);
    expect(x.incident.category).toBe("DATABASE");
  });

  it("a recurrence after the correlation window opens a new incident; within it, the same one", async () => {
    const t0 = new Date("2026-11-13T09:00:00Z");
    const a = await recordFailure({ source: "action", route: "/queue", error: boom(), subject: "staff:a", now: t0 });
    const b = await recordFailure({ source: "action", route: "/queue", error: boom(), subject: "staff:b", now: new Date(t0.getTime() + 29 * 60_000) });
    const c = await recordFailure({ source: "action", route: "/queue", error: boom(), subject: "staff:c", now: new Date(t0.getTime() + 61 * 60_000) });
    expect(b.view!.ref).toBe(a.view!.ref);
    expect(c.view!.ref).not.toBe(a.view!.ref);
    const old = (await db.query("SELECT status, resolution_note FROM incidents WHERE ref = $1", [a.view!.ref])).rows[0];
    expect(old.status).toBe("RESOLVED");
    expect(old.resolution_note).toMatch(/No recurrence/);
  });

  it("status moves Detected → Investigating → Resolved → Closed only, by a Super Admin, and is told to users truthfully", async () => {
    const { incident, view } = await recordFailure({ source: "render", route: "/queue", error: boom(), subject: "staff:a" });
    expect(view!.statusLabel).toBe("Issue detected."); // not routed, nobody acknowledged
    const admin = await ctxFor(ADMIN);
    await expect(transitionIncident(await ctxFor("rm.ade@altbank.ng"), incident.id, "INVESTIGATING", "")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(transitionIncident(admin, incident.id, "CLOSED", "")).rejects.toMatchObject({ code: "CONFLICT" });
    await transitionIncident(admin, incident.id, "INVESTIGATING", "");
    expect((await assignUser(incident.id, "staff:a"))!.statusLabel).toMatch(/acknowledged this issue and is investigating/);
    await expect(transitionIncident(admin, incident.id, "RESOLVED", "")).rejects.toMatchObject({ code: "VALIDATION" });
    await transitionIncident(admin, incident.id, "RESOLVED", "Missing table restored");
    // Resolved incidents take no new assignments; existing users keep theirs.
    const before = (await db.query("SELECT affected_users FROM incidents WHERE id = $1", [incident.id])).rows[0].affected_users;
    const late = await assignUser(incident.id, "staff:late");
    expect(late!.status).toBe("RESOLVED");
    expect((await db.query("SELECT affected_users FROM incidents WHERE id = $1", [incident.id])).rows[0].affected_users).toBe(before);
    expect((await assignUser(incident.id, "staff:a"))!.messageNo).toBe(view!.messageNo);
    await transitionIncident(admin, incident.id, "CLOSED", "");
    await expect(transitionIncident(admin, incident.id, "INVESTIGATING", "")).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'INCIDENT_%'")).rows[0].n).toBe(3);
    // The same failure now starts a fresh incident.
    const again = await recordFailure({ source: "render", route: "/queue", error: boom(), subject: "staff:a" });
    expect(again.view!.ref).not.toBe(view!.ref);
    expect((await listIncidents(db, "resolved")).map((i) => i.ref)).toContain(view!.ref);
  });

  it("maps an error digest to its incident so the browser can show the shared reference", async () => {
    const { incident } = await recordFailure({ source: "render", route: "/booked", error: boom(), digest: "123456789" });
    const v = await viewForDigest("123456789", "staff:x");
    expect(v!.ref).toBe(incident.ref);
    expect(await viewForDigest("unknown", "staff:x")).toBeNull();
  });

  it("routes alerts once per severity level, throttled, and only then says it was reported", async () => {
    process.env.INCIDENT_ALERT_EMAILS = "digital.banking@altbank.ng";
    const id = (await recordFailure({ source: "render", route: "/reports", error: boom() })).incident.id;
    for (let i = 0; i < 12; i++) await recordFailure({ source: "render", route: "/reports", error: boom(), subject: `staff:${i}` }); // 12 users → severity rises
    const alerts = (await db.query("SELECT subject, dedupe_key FROM notification_outbox WHERE kind = 'INCIDENT_ALERT' ORDER BY created_at")).rows;
    expect(alerts.map((a) => a.subject.split("]")[0])).toEqual(["[MEDIUM", "[HIGH"]);
    expect((await assignUser(id, "staff:0"))!.statusLabel).toBe("Issue detected and reported to the Digital Banking Team.");
    // Global throttle: no more than the hourly cap, however many incidents open.
    process.env.INCIDENT_ALERTS_PER_HOUR = "3";
    for (let i = 0; i < 6; i++) await recordFailure({ source: "render", route: `/other-${i}`, error: boom() });
    expect((await db.query("SELECT count(*)::int AS n FROM notification_outbox WHERE kind = 'INCIDENT_ALERT'")).rows[0].n).toBe(3);
    delete process.env.INCIDENT_ALERTS_PER_HOUR;
  });

  it("never stores or logs customer data, secrets or server paths", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const nasty = Object.assign(
      new Error('duplicate key value violates unique constraint "c" Key (bvn, email)=(22345678901, amaka.okafor@example.com) account 0123456789 token=sk_live_abc123 at /home/user/ARAF/src/server/x.ts'),
      { code: "23505", stack: "Error: x\n    at save (/home/user/ARAF/src/server/altphones/origination.ts:120:5)\n    at g (/home/user/ARAF/.next/server/app/(app)/zz/page.js:1:234)\n    at file:///C:/srv/app/(app)/x.js:9:1" },
    );
    const { incident } = await recordFailure({ source: "action", route: "/altphones/applications/0f8fad5b-d9cb-469f-a165-70867728950e", error: nasty, subject: "staff:a" });
    const stored = JSON.stringify((await db.query("SELECT * FROM incidents WHERE id = $1", [incident.id])).rows[0]);
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    for (const secret of ["22345678901", "amaka", "0123456789", "sk_live_abc123", "/home/user", ".next/server", "C:/srv", "0f8fad5b"]) {
      expect(stored).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
    expect(logged).toContain(incident.ref);
    expect((incident.diagnostics as { frames: string[] }).frames).toEqual(["at save (origination.ts:120)", "at g (page.js:1)", "at x.js:9"]);
    spy.mockRestore();
    expect(sanitiseMessage("Bearer abc.def password: hunter2")).not.toMatch(/abc\.def|hunter2/);
    expect(normaliseRoute("/altphones/applications/ALP-2026-000058?x=1")).toBe("/altphones/applications/:ref");
    expect(classify({ source: "render", route: "/x", error: boom() }).fingerprint).toBe(classify({ source: "render", route: "/x", error: boom() }).fingerprint);
  });
});
