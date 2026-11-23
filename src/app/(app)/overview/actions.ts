"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../_lib/auth";
import { toActionError, type ActionState } from "../../_lib/action";
import { deleteDraft } from "@/server/domain/home";

export async function deleteDraftAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await deleteDraft(ctx, String(fd.get("applicationId") ?? ""));
    revalidatePath("/overview");
    revalidatePath("/requests");
    return { ok: true, message: "Draft deleted. Your other applications are unchanged.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
