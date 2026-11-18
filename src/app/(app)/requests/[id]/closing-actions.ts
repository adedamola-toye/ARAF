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

export async function updateHandoverAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const appId = s(fd, "applicationId");
  try {
    const { updateHandover } = await import("@/server/domain/facility-archive");
    await updateHandover(ctx, appId, s(fd, "group") as "LEGAL" | "SHARIAH", s(fd, "to") === "REVIEWED" ? "REVIEWED" : "RECEIVED", s(fd, "comments"));
    revalidatePath(`/requests/${appId}`);
    return { ok: true, message: "Records review updated.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function signOnDeviceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const appId = s(fd, "applicationId");
  try {
    const { signDocumentOnDevice } = await import("@/server/domain/signing");
    const signatories = JSON.parse(String(fd.get("signatories") ?? "[]")) as { name: string; role: string; signaturePng: string }[];
    await signDocumentOnDevice(
      ctx,
      {
        applicationId: appId,
        sourceDocumentId: s(fd, "sourceDocumentId"),
        signatories,
        consent: fd.get("consent") === "on",
        idType: s(fd, "idType"),
        idLast4: s(fd, "idLast4"),
        idVerified: fd.get("idVerified") === "on",
      },
      ctx.userAgent,
    );
    revalidatePath(`/requests/${appId}`);
    return { ok: true, message: "Signed. The signed copy is saved in Documents and counts towards the closing checklist.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
