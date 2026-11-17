"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { saveSlaPolicy } from "@/server/domain/sla-reminders";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const list = (v: string) => v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

export async function saveSlaPolicyAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await saveSlaPolicy(ctx, {
      reminderHours: Number(s(fd, "reminderHours")),
      repeatHours: s(fd, "repeatHours") ? Number(s(fd, "repeatHours")) : null,
      hourMode: s(fd, "hourMode") === "WORKING" ? "WORKING" : "CALENDAR",
      workingStart: Number(s(fd, "workingStart")),
      workingEnd: Number(s(fd, "workingEnd")),
      workingDays: fd.getAll("workingDays").map(Number),
      holidays: list(s(fd, "holidays")),
      excludedQueues: ["RETAIL_TASK", "STAFF_REQUEST", "ALTPHONES", "INVOICE_CONFIRMATION"].filter((q) => fd.get(`queue_${q}`) !== "on"),
      ccEmails: list(s(fd, "ccEmails")),
      subjectTemplate: s(fd, "subjectTemplate"),
      bodyTemplate: String(fd.get("bodyTemplate") ?? ""),
      enabled: fd.get("enabled") === "on",
      reason: s(fd, "reason"),
    });
    revalidatePath("/admin/sla-reminders");
    return { ok: true, message: "SLA reminder settings saved.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
