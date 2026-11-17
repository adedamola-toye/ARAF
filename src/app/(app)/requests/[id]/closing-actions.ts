"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { saveRepaymentAccount } from "@/server/domain/closing-docs";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function saveRepaymentAccountAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const appId = s(fd, "applicationId");
  try {
    await saveRepaymentAccount(ctx, appId, { bankName: s(fd, "bankName"), accountNumber: s(fd, "accountNumber"), accountName: s(fd, "accountName"), branch: s(fd, "branch"), townCity: s(fd, "townCity") });
    revalidatePath(`/requests/${appId}`);
    return { ok: true, message: "Repayment account saved. The GSI form and Remita set-up sheet have been prepared.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
