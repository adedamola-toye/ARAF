"use server";
import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { toActionError, type ActionState } from "../../_lib/action";
import {
  activateTemplate,
  addGroupMember,
  adminAssignTask,
  createTemplateVersion,
  grantRole,
  isSuperAdmin,
  provisionStaff,
  removeGroupMember,
  revokeRole,
  setStaffStatus,
  updateMonthlySchedule,
} from "@/server/domain/admin";
import { retryOutbox } from "@/server/jobs/outbox";
import { auditOutsideTx } from "@/server/audit";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
type Op = (fd: FormData, ctx: Awaited<ReturnType<typeof requireUser>>["ctx"]) => Promise<string | void>;

async function run(fd: FormData, op: Op, ok: string): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = await op(fd, ctx);
    return { ok: true, message: typeof r === "string" ? r : ok, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function provisionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  let id: string;
  try {
    id = await provisionStaff(ctx, { email: s(fd, "email"), fullName: s(fd, "fullName"), region: s(fd, "region") || null, businessUnit: s(fd, "businessUnit") || null });
  } catch (e) {
    return toActionError(e);
  }
  redirect(`/admin/staff/${id}?created=1`);
}
export const grantRoleAction = async (_p: ActionState, fd: FormData) =>
  run(fd, (f, ctx) => grantRole(ctx, { staffId: s(f, "staffId"), role: s(f, "role"), region: s(f, "region") || null, businessUnit: s(f, "businessUnit") || null }), "Role granted.");
export const revokeRoleAction = async (_p: ActionState, fd: FormData) => run(fd, (f, ctx) => revokeRole(ctx, { staffId: s(f, "staffId"), role: s(f, "role") }), "Role revoked. Any open tasks under this role were moved to Assignment exceptions.");
export const statusAction = async (_p: ActionState, fd: FormData) => run(fd, (f, ctx) => setStaffStatus(ctx, s(f, "staffId"), s(f, "status") === "SUSPENDED" ? "SUSPENDED" : "ACTIVE"), "Status updated.");
export const addMemberAction = async (_p: ActionState, fd: FormData) => run(fd, (f, ctx) => addGroupMember(ctx, s(f, "group"), s(f, "email")), "Recipient added.");
export const removeMemberAction = async (_p: ActionState, fd: FormData) => run(fd, (f, ctx) => removeGroupMember(ctx, s(f, "group"), s(f, "email")), "Recipient removed.");
export const assignTaskAction = async (_p: ActionState, fd: FormData) => run(fd, (f, ctx) => adminAssignTask(ctx, s(f, "taskId"), s(f, "staffId"), s(f, "note")), "Task assigned.");
export const createTemplateAction = async (_p: ActionState, fd: FormData) =>
  run(fd, async (f, ctx) => {
    await createTemplateVersion(ctx, { name: s(f, "name"), bodyHtml: String(f.get("bodyHtml") ?? ""), productionApproved: f.get("productionApproved") === "on", notes: s(f, "notes") });
  }, "Template version saved as draft. Activate it to use it for new offers.");
export const activateTemplateAction = async (_p: ActionState, fd: FormData) => run(fd, (f, ctx) => activateTemplate(ctx, s(f, "templateId")), "Template activated.");
export const scheduleAction = async (_p: ActionState, fd: FormData) =>
  run(fd, (f, ctx) =>
    updateMonthlySchedule(ctx, {
      enabled: f.get("enabled") === "on",
      dayOfMonth: Number(s(f, "dayOfMonth")),
      hour: Number(s(f, "hour")),
      minute: Number(s(f, "minute")),
      recipientIds: f.getAll("recipients").map(String),
    }), "Monthly schedule saved.");
export const retryOutboxAction = async (_p: ActionState, fd: FormData) =>
  run(fd, async (f, ctx) => {
    if (!(await isSuperAdmin(ctx.actor!.staffId))) throw new Error("forbidden");
    await retryOutbox(s(f, "outboxId"));
    await auditOutsideTx(ctx, { action: "EMAIL_RETRY_REQUESTED", actorRole: "SUPER_ADMIN", details: { outboxId: s(f, "outboxId") } });
  }, "Message re-queued.");
