"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../_lib/auth";
import { toActionError, type ActionState } from "../../_lib/action";
import { uploadDocument } from "@/server/domain/documents";
import { completeConfirmation, icDetail, returnConfirmation } from "@/server/domain/invoice-confirmation";
import { db } from "@/server/db";
import { forbidden, notFound } from "@/server/errors";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const lv = (fd: FormData) => (s(fd, "lockVersion") ? Number(s(fd, "lockVersion")) : null);

export async function uploadResponseAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const id = s(fd, "confirmationId");
  try {
    const row = await icDetail(db, id);
    if (!row) throw notFound();
    if (row.officer_id !== ctx.actor?.staffId) throw forbidden("This confirmation is not assigned to you.");
    const file = fd.get("response");
    if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose the issuer's response file.", fields: { response: "Choose a file." }, nonce: Date.now() };
    const r = await uploadDocument(ctx, { applicationId: row.application_id, category: "INVOICE_CONFIRMATION_RESPONSE", filename: file.name || "response.pdf", data: Buffer.from(await file.arrayBuffer()) });
    revalidatePath(`/invoice-confirmation/${id}`);
    return { ok: true, message: r.scanStatus === "CLEAN" ? "Response uploaded." : "Response uploaded; it is being scanned.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function completeConfirmationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const id = s(fd, "confirmationId");
  try {
    await completeConfirmation(ctx, id, s(fd, "remarks"), lv(fd));
    revalidatePath("/invoice-confirmation");
    revalidatePath(`/invoice-confirmation/${id}`);
    return { ok: true, message: "Confirmation Completed. The initiator has been notified.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function returnConfirmationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const id = s(fd, "confirmationId");
  try {
    await returnConfirmation(ctx, id, s(fd, "reason"), lv(fd));
    revalidatePath("/invoice-confirmation");
    revalidatePath(`/invoice-confirmation/${id}`);
    return { ok: true, message: "Returned to the initiator with your reason.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
