/**
 * First-time onboarding state, one row per user and role (workspace). The welcome guide appears automatically
 * only when the user has no row for the role they are working in: the first time they sign in, or the first
 * time they open a newly assigned role's workspace. A normal sign-in never shows it again, on any device, and a
 * new guide version is offered under Help & Guides rather than forced. Only the user's own rows are read or written.
 */
import type { Db } from "../db";
import { GUIDE_VERSION } from "@/lib/onboarding/tours";
import { holdsRole } from "./access";

export interface OnboardingState {
  role: string;
  guide_version: number;
  first_seen_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  skipped_at: Date | null;
  last_step: number | null;
}

export async function onboardingDue(q: Db, staffId: string, role: string | null): Promise<boolean> {
  if (!role) return false;
  return !(await q.query("SELECT 1 FROM onboarding_states WHERE staff_id = $1 AND role = $2", [staffId, role])).rowCount;
}

export async function onboardingStates(q: Db, staffId: string): Promise<OnboardingState[]> {
  return (await q.query<OnboardingState>("SELECT role, guide_version, first_seen_at, started_at, completed_at, skipped_at, last_step FROM onboarding_states WHERE staff_id = $1 ORDER BY role", [staffId])).rows;
}

export type OnboardingEvent = "SEEN" | "START" | "STEP" | "COMPLETE" | "SKIP";

/** Record progress for the signed-in user's own role. Unknown roles (not held) are ignored. */
export async function recordOnboarding(q: Db, staffId: string, role: string, event: OnboardingEvent, now: Date, step?: number | null) {
  if (!(await holdsRole(q, staffId, role))) return;
  await q.query(
    `INSERT INTO onboarding_states (staff_id, role, guide_version, first_seen_at, updated_at) VALUES ($1,$2,$3,$4,$4)
     ON CONFLICT (staff_id, role) DO NOTHING`,
    [staffId, role, GUIDE_VERSION, now],
  );
  const s = Number.isInteger(step) && (step as number) >= 0 && (step as number) < 100 ? step : null;
  if (event === "START") await q.query("UPDATE onboarding_states SET started_at = $3, guide_version = $4, completed_at = NULL, skipped_at = NULL, last_step = 0, updated_at = $3 WHERE staff_id = $1 AND role = $2", [staffId, role, now, GUIDE_VERSION]);
  else if (event === "STEP") await q.query("UPDATE onboarding_states SET last_step = greatest(coalesce(last_step, 0), $3), updated_at = $4 WHERE staff_id = $1 AND role = $2", [staffId, role, s ?? 0, now]);
  else if (event === "COMPLETE") await q.query("UPDATE onboarding_states SET completed_at = $3, last_step = coalesce($4, last_step), updated_at = $3 WHERE staff_id = $1 AND role = $2", [staffId, role, now, s]);
  else if (event === "SKIP") await q.query("UPDATE onboarding_states SET skipped_at = $3, last_step = coalesce($4, last_step), updated_at = $3 WHERE staff_id = $1 AND role = $2", [staffId, role, now, s]);
}
