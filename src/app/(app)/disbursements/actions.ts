"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../_lib/auth";
import { toActionError, type ActionState } from "../../_lib/action";
import { holdDisbursement, recordAttempt, releaseHold, resolveAttempt } from "@/server/domain/cad";
import { parseNairaToKobo } from "@/server/money";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const done = (message: string): ActionState => {
  revalidatePath("/disbursements");
  return { ok: true, message, nonce: Date.now() };
};

export async function holdAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await holdDisbursement(ctx, s(fd, "applicationId"), s(fd, "reason"));
    return done("On hold. The initiator has been notified. Disbursement is blocked until the hold is released.");
  } catch (e) {
    return toActionError(e);
  }
}

export async function releaseAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await releaseHold(ctx, s(fd, "applicationId"), s(fd, "note"));
    return done("Hold released.");
  } catch (e) {
    return toActionError(e);
  }
}

export async function attemptAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const amount = s(fd, "amount").trim();
    await recordAttempt(ctx, s(fd, "applicationId"), {
      outcome: s(fd, "outcome") as "FAILED" | "UNCERTAIN",
      attemptedRef: s(fd, "attemptedRef"),
      amountKobo: amount ? parseNairaToKobo(amount) : null,
      note: s(fd, "note"),
    });
    return done(s(fd, "outcome") === "UNCERTAIN" ? "Recorded as uncertain. Verify in core banking before anything else is posted." : "Failed posting recorded.");
  } catch (e) {
    return toActionError(e);
  }
}

export async function resolveAttemptAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await resolveAttempt(ctx, s(fd, "attemptId"), s(fd, "resolution") as "NOT_POSTED" | "POSTED", s(fd, "note"), s(fd, "postedRef"));
    return done(s(fd, "resolution") === "POSTED" ? "Verified as posted. Record the disbursement with that reference; do not post again." : "Verified as not posted. A new posting can be made.");
  } catch (e) {
    return toActionError(e);
  }
}
