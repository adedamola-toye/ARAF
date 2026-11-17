"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { CHECKLIST_CANDIDATES, saveChecklist } from "@/server/domain/closing-checklist";

export async function saveChecklistAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const items = CHECKLIST_CANDIDATES.flatMap((code) => {
      const v = String(fd.get(`item_${code}`) ?? "OFF");
      return v === "OFF" ? [] : [{ code, required: v === "REQUIRED" }];
    });
    await saveChecklist(ctx, String(fd.get("product") ?? ""), items, String(fd.get("reason") ?? ""));
    revalidatePath("/admin/closing-checklists");
    return { ok: true, message: "Checklist saved. It applies to packs submitted from now on.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
