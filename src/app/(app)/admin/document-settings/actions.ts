"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { saveDocumentSettings } from "@/server/domain/document-settings";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function saveDocumentSettingsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await saveDocumentSettings(ctx, {
      bankName: s(fd, "bankName"),
      bankAddress: s(fd, "bankAddress"),
      beneficiaryName: s(fd, "beneficiaryName"),
      beneficiaryBank: s(fd, "beneficiaryBank"),
      beneficiaryAccount: s(fd, "beneficiaryAccount"),
      beneficiaryEmail: s(fd, "beneficiaryEmail"),
      beneficiaryPhone: s(fd, "beneficiaryPhone"),
      charge: s(fd, "charge"),
      vatPercent: s(fd, "vatPercent"),
      customerEmail: fd.get("customerEmail") === "on",
      reason: s(fd, "reason"),
    });
    revalidatePath("/admin/document-settings");
    return { ok: true, message: "Document settings saved. New documents use them; documents already prepared are unchanged.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
