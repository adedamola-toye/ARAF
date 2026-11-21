"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { saveCategory, saveCrmSettings, saveEscalationRule, saveReportSchedule, saveRoutingRule, saveSlaPolicy, saveSubcategory, saveTeam, setTeamMember } from "@/server/crm/config";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const b = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";
const n = (fd: FormData, k: string) => (s(fd, k) === "" ? null : Number(s(fd, k)));
const mins = (fd: FormData, k: string) => {
  const v = n(fd, `${k}Value`);
  if (v === null) return null;
  return Math.round(v * (s(fd, `${k}Unit`) === "h" ? 60 : s(fd, `${k}Unit`) === "d" ? 1440 : 1));
};

type Handler = (ctx: Awaited<ReturnType<typeof requireUser>>["ctx"], fd: FormData) => Promise<unknown>;
const handlers: Record<string, Handler> = {
  settings: (ctx, fd) =>
    saveCrmSettings(ctx, {
      fallbackTeamId: s(fd, "fallbackTeamId"),
      closurePolicy: s(fd, "closurePolicy"),
      closureTimeoutHours: n(fd, "closureTimeoutHours"),
      workingStart: Number(s(fd, "workingStart")),
      workingEnd: Number(s(fd, "workingEnd")),
      workingDays: fd.getAll("workingDays").map(Number),
      holidays: s(fd, "holidays").split(/[\s,]+/).filter(Boolean),
      pauseOnPendingInfo: b(fd, "pauseOnPendingInfo"),
      reason: s(fd, "reason"),
    }),
  category: (ctx, fd) => saveCategory(ctx, { id: s(fd, "id") || null, name: s(fd, "name"), description: s(fd, "description"), active: b(fd, "active"), sortOrder: n(fd, "sortOrder") ?? undefined, reason: s(fd, "reason") }),
  issue: (ctx, fd) => saveSubcategory(ctx, { id: s(fd, "id") || null, categoryId: s(fd, "categoryId"), name: s(fd, "name"), productCode: s(fd, "productCode") || null, defaultPriority: s(fd, "defaultPriority"), active: b(fd, "active"), sortOrder: n(fd, "sortOrder") ?? undefined, reason: s(fd, "reason") }),
  team: (ctx, fd) => saveTeam(ctx, { id: s(fd, "id") || null, name: s(fd, "name"), description: s(fd, "description"), active: b(fd, "active"), reason: s(fd, "reason") }),
  member: (ctx, fd) => setTeamMember(ctx, { teamId: s(fd, "teamId"), email: s(fd, "email"), staffId: s(fd, "staffId") || undefined, memberRole: s(fd, "memberRole") === "REMOVE" ? null : (s(fd, "memberRole") as "LEAD" | "OFFICER"), reason: s(fd, "reason") }),
  routing: (ctx, fd) => saveRoutingRule(ctx, { id: s(fd, "id") || null, productCode: s(fd, "productCode") || null, categoryId: s(fd, "categoryId") || null, subcategoryId: s(fd, "subcategoryId") || null, stage: s(fd, "stage") || null, teamId: s(fd, "teamId"), priorityOverride: s(fd, "priorityOverride") || null, active: b(fd, "active"), reason: s(fd, "reason") }),
  sla: (ctx, fd) =>
    saveSlaPolicy(ctx, {
      id: s(fd, "id") || null,
      name: s(fd, "name"),
      productCode: s(fd, "productCode") || null,
      categoryId: s(fd, "categoryId") || null,
      subcategoryId: s(fd, "subcategoryId") || null,
      priority: s(fd, "priority") || null,
      teamId: s(fd, "teamId") || null,
      assignmentMinutes: mins(fd, "assignment"),
      firstResponseMinutes: mins(fd, "firstResponse"),
      resolutionMinutes: mins(fd, "resolution"),
      businessHours: s(fd, "clock") !== "continuous",
      active: b(fd, "active"),
      reason: s(fd, "reason"),
    }),
  escalation: (ctx, fd) => saveEscalationRule(ctx, { id: s(fd, "id") || null, trigger: s(fd, "trigger"), threshold: Number(s(fd, "threshold")), notifyTeamLead: b(fd, "notifyTeamLead"), notifyCxHead: b(fd, "notifyCxHead"), markEscalated: b(fd, "markEscalated"), active: b(fd, "active"), reason: s(fd, "reason") }),
  report: (ctx, fd) => saveReportSchedule(ctx, { frequency: s(fd, "frequency"), enabled: b(fd, "enabled"), sendHour: Number(s(fd, "sendHour")), includeCxHeads: b(fd, "includeCxHeads"), extraRecipientEmails: s(fd, "extra").split(/[\s,;]+/).filter(Boolean), reason: s(fd, "reason") }),
};

export async function crmConfigAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const h = handlers[s(fd, "kind")];
  try {
    if (!h) return { ok: false, error: "Unknown setting.", nonce: Date.now() };
    await h(ctx, fd);
    revalidatePath("/admin/crm");
    return { ok: true, message: "Saved. It applies from now on; existing tickets keep their recorded details.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
