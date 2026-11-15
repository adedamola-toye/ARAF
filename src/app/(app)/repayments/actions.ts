"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../_lib/auth";
import { toActionError, type ActionState } from "../../_lib/action";
import { setSwitch } from "@/server/domain/switches";

export async function trackerSwitchAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const on = String(fd.get("enabled")) === "true";
  try {
    await setSwitch(ctx, "REPAYMENT_TRACKER", on, String(fd.get("reason") ?? ""));
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: on ? "The repayment and PDO tracker is now visible to leadership, credit and collections." : "The repayment and PDO tracker is now hidden from everyone except Super Admins.", nonce: Date.now() };
}
