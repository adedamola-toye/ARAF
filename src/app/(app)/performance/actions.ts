"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { decideTarget, markSummarySeen, proposeTarget, type TargetMetric } from "@/server/domain/performance";
import { parseNairaToKobo } from "@/server/money";
import { toActionError, type ActionState as FormState } from "../../_lib/action";

export async function markSummarySeenAction() {
  const { session, ctx } = await requireUser({ touch: false });
  await markSummarySeen(db, session.staffId, ctx.now);
}

export async function proposeTargetAction(_: FormState, fd: FormData): Promise<FormState> {
  const { ctx } = await requireUser();
  const metric = String(fd.get("metric") ?? "") as TargetMetric;
  const raw = String(fd.get("value") ?? "");
  const value = metric === "DISBURSED_VALUE" ? parseNairaToKobo(raw) : Number(raw.replace(/,/g, ""));
  try {
    await proposeTarget(ctx, {
      scopeType: String(fd.get("scopeType") ?? "") as "STAFF" | "TEAM",
      staffId: String(fd.get("staffId") ?? "") || null,
      team: String(fd.get("team") ?? "") || null,
      metric,
      month: String(fd.get("month") ?? ""),
      value: value ?? NaN,
      reason: String(fd.get("reason") ?? ""),
    });
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/performance/targets");
  return { ok: true, message: "Target proposed. A different approver must approve it before it applies." };
}

export async function decideTargetAction(_: FormState, fd: FormData): Promise<FormState> {
  const { ctx } = await requireUser();
  const decision = String(fd.get("decision") ?? "") as "APPROVE" | "REJECT" | "WITHDRAW";
  try {
    const r = await decideTarget(ctx, String(fd.get("id") ?? ""), decision, String(fd.get("note") ?? ""));
    revalidatePath("/performance/targets");
    return { ok: true, message: r.status === "APPROVED" ? `Target approved${r.superseded ? "; it replaces the previous target" : ""}.` : r.status === "REJECTED" ? "Proposal rejected." : "Proposal withdrawn." };
  } catch (e) {
    return toActionError(e);
  }
}
