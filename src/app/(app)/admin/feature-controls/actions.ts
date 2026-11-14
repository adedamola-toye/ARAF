"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { setSwitch, SWITCHES, type SwitchKey } from "@/server/domain/switches";

export async function switchAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const key = String(fd.get("key") ?? "") as SwitchKey;
  const on = String(fd.get("enabled")) === "true";
  try {
    if (!(key in SWITCHES)) throw new Error("Unknown setting");
    await setSwitch(ctx, key, on, String(fd.get("reason") ?? ""));
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: `Turned ${on ? "ON" : "OFF"}. The change is recorded with your reason.`, nonce: Date.now() };
}
