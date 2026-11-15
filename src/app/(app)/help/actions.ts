"use server";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { recordOnboarding, type OnboardingEvent } from "@/server/domain/onboarding";

/** Records the signed-in user's own onboarding progress (never another user's). */
export async function onboardingEventAction(role: string, event: OnboardingEvent, step?: number | null) {
  const { session, ctx } = await requireUser({ touch: false });
  if (!["SEEN", "START", "STEP", "COMPLETE", "SKIP"].includes(event) || typeof role !== "string" || role.length > 60) return;
  await recordOnboarding(db, session.staffId, role, event, ctx.now, step ?? null);
}
