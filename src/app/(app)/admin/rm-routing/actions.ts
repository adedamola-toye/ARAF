"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { setRmClassification, setRoutingAssignment } from "@/server/domain/rm-routing";
import { provisionStaff } from "@/server/domain/admin";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const done = (message: string): ActionState => {
  revalidatePath("/admin/rm-routing");
  return { ok: true, message, nonce: Date.now() };
};

export async function classifyRmAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await setRmClassification(ctx, { staffId: s(fd, "staffId"), segment: s(fd, "segment"), dbcRegion: s(fd, "dbcRegion") || null, rbeId: s(fd, "rbeId") || null, businessUnit: s(fd, "businessUnit") || null, reason: s(fd, "reason") });
    return done("Classification saved. It applies to requests submitted from now on.");
  } catch (e) {
    return toActionError(e);
  }
}

export async function routingAssignmentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await setRoutingAssignment(ctx, { key: s(fd, "key"), staffId: s(fd, "staffId") || null, reason: s(fd, "reason") });
    return done("Approver saved. It applies to requests submitted from now on.");
  } catch (e) {
    return toActionError(e);
  }
}

/** Provision a Regional Business Executive (Super Admin): adds to the bank directory if needed and grants only the RBE role. */
export async function provisionRbeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await provisionStaff(ctx, { email: s(fd, "email"), fullName: s(fd, "fullName"), region: s(fd, "region") || null, businessUnit: s(fd, "businessUnit") || null, role: "RBE", addToDirectory: true });
    return done("Regional Business Executive provisioned. You can now assign Relationship Managers to them.");
  } catch (e) {
    return toActionError(e);
  }
}
