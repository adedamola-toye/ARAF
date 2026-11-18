"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { setOrgLink } from "@/server/domain/org";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function setOrgLinkAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await setOrgLink(ctx, { staffId: s(fd, "staffId"), relation: s(fd, "relation"), managerId: s(fd, "managerId") || null, reason: s(fd, "reason") });
    revalidatePath("/admin/reporting-lines");
    return { ok: true, message: "Reporting line saved.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
