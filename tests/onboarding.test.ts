import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { onboardingDue, onboardingStates, recordOnboarding } from "@/server/domain/onboarding";
import { tourFor, GUIDE_VERSION } from "@/lib/onboarding/tours";
import { ROLES } from "@/server/domain/roles";

const id = async (email: string) => (await db.query("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id as string;
beforeEach(async () => {
  await resetDb();
});

describe("first-time onboarding", () => {
  it("appears once per user and role; skipping or completing never brings it back; role changes offer the new role", async () => {
    const rm = await id("rm.bola@altbank.ng");
    const t = new Date();
    expect(await onboardingDue(db, rm, "RM")).toBe(true);
    await recordOnboarding(db, rm, "RM", "SEEN", t);
    await recordOnboarding(db, rm, "RM", "SKIP", t);
    expect(await onboardingDue(db, rm, "RM")).toBe(false); // next sign-in, any device
    // A newly assigned role is offered its own guide.
    await db.query("INSERT INTO role_assignments (staff_id, role, active) VALUES ($1,'TEAM_LEAD',true)", [rm]);
    expect(await onboardingDue(db, rm, "TEAM_LEAD")).toBe(true);
    await recordOnboarding(db, rm, "TEAM_LEAD", "START", t);
    await recordOnboarding(db, rm, "TEAM_LEAD", "STEP", t, 3);
    await recordOnboarding(db, rm, "TEAM_LEAD", "COMPLETE", t, 8);
    const st = (await onboardingStates(db, rm)).find((s) => s.role === "TEAM_LEAD")!;
    expect(st).toMatchObject({ guide_version: GUIDE_VERSION, last_step: 8 });
    expect(st.started_at).toBeTruthy();
    expect(st.completed_at).toBeTruthy();
    // Replaying restarts progress but never re-triggers the automatic welcome.
    await recordOnboarding(db, rm, "TEAM_LEAD", "START", t);
    expect(await onboardingDue(db, rm, "TEAM_LEAD")).toBe(false);
  });

  it("records only the user's own roles", async () => {
    const rm = await id("rm.bola@altbank.ng");
    await recordOnboarding(db, rm, "DIVISIONAL_HEAD", "SEEN", new Date()); // not held: ignored
    expect((await onboardingStates(db, rm)).map((s) => s.role)).not.toContain("DIVISIONAL_HEAD");
  });

  it("every role in ARAF has a guide, and tours never point at actions that change data", () => {
    for (const r of ROLES) {
      const steps = tourFor(r);
      expect(steps.length).toBeGreaterThan(0);
      for (const s of steps) {
        expect(s.title.length).toBeGreaterThan(2);
        expect(s.target === null || /^(nav:\/[a-z/-]*|[a-z-]+)$/.test(s.target)).toBe(true);
        expect(s.href ?? "/").not.toMatch(/approve|submit|decide/);
      }
    }
  });
});
