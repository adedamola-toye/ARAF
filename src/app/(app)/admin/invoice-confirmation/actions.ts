"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { reassignConfirmation, saveOfficerEmails } from "@/server/domain/invoice-confirmation";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function saveOfficersAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await saveOfficerEmails(ctx, s(fd, "emails").split(/[\n,]+/), s(fd, "reason"));
    revalidatePath("/admin/invoice-confirmation");
    return { ok: true, message: "Invoice Confirmation Officers saved.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function reassignAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await reassignConfirmation(ctx, s(fd, "confirmationId"), s(fd, "officerId"), s(fd, "reason"));
    revalidatePath("/admin/invoice-confirmation");
    return { ok: true, message: "Reassigned.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
