"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { withTx } from "@/server/db";
import { audit } from "@/server/audit";
import { forbidden } from "@/server/errors";
import { holdsRole } from "@/server/domain/access";
import { BRIEFING_CODE, sendBriefingTest } from "@/server/jobs/briefing";

export async function briefingSwitchAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const on = String(fd.get("enabled")) === "true";
  try {
    await withTx(async (tx) => {
      if (!ctx.actor || !(await holdsRole(tx, ctx.actor.staffId, "SUPER_ADMIN"))) throw forbidden();
      await tx.query("UPDATE schedule_settings SET enabled = $2, updated_by = $3, updated_at = $4 WHERE code = $1", [BRIEFING_CODE, on, ctx.actor.staffId, ctx.now]);
      await audit(tx, ctx, { action: "SCHEDULE_UPDATED", actorRole: "SUPER_ADMIN", details: { code: BRIEFING_CODE, enabled: on } });
    });
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/admin/schedules");
  return { ok: true, message: on ? "Personal briefings switched on. They go out with the Sunday reports." : "Personal briefings switched off.", nonce: Date.now() };
}

export async function briefingTestAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = await sendBriefingTest(ctx, String(fd.get("staffId") ?? ""));
    return { ok: true, message: `Test briefing queued to ${r.to}.`, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
