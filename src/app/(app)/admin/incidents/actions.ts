"use server";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { transitionIncident } from "@/server/incidents";
import type { IncidentStatus } from "@/lib/incident-messages";

const NEXT: Record<string, { to: IncidentStatus; ok: string }> = {
  acknowledge: { to: "INVESTIGATING", ok: "Acknowledged. Affected users now see that the team is investigating." },
  resolve: { to: "RESOLVED", ok: "Resolved. Users are told they can try again." },
  close: { to: "CLOSED", ok: "Closed." },
  reopen: { to: "INVESTIGATING", ok: "Reopened and marked as investigating." },
};

export async function incidentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const step = NEXT[String(fd.get("step") ?? "")];
    if (!step) return { ok: false, error: "Choose an action.", nonce: Date.now() };
    await transitionIncident(ctx, String(fd.get("id") ?? ""), step.to, String(fd.get("note") ?? ""));
    return { ok: true, message: step.ok, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
