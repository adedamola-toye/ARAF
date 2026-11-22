"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../_lib/auth";
import { toActionError, type ActionState } from "../../_lib/action";
import { designateEditor, editTeamMemberProfile } from "@/server/domain/team-profiles";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function editMemberAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await editTeamMemberProfile(ctx, s(fd, "staffId"), { fullName: s(fd, "fullName"), businessUnit: s(fd, "businessUnit") });
    revalidatePath("/team");
    return { ok: true, message: "Profile updated. The change is recorded in the audit trail.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function designateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const on = s(fd, "on") === "1";
  try {
    await designateEditor(ctx, s(fd, "staffId"), on, s(fd, "reason"));
    revalidatePath("/admin/profile-editors");
    return { ok: true, message: on ? "Designated." : "Designation removed.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
