"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { recordSignInTest, savePericulumCredentials } from "@/server/integrations/periculum/settings";
import { checkPericulumSignIn, explainSignIn } from "@/server/integrations/periculum/client";

export async function savePericulumAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await savePericulumCredentials(ctx, {
      clientId: String(fd.get("clientId") ?? ""),
      clientSecret: String(fd.get("clientSecret") ?? ""),
      baseUrl: String(fd.get("baseUrl") ?? ""),
      authUrl: String(fd.get("authUrl") ?? ""),
      reason: String(fd.get("reason") ?? ""),
    });
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/admin/periculum");
  return { ok: true, message: "Saved. The secret is stored encrypted and will not be shown again. Use Test sign-in to check it.", nonce: Date.now() };
}

/** Requests an access token only: no statement is sent and nothing is billed. */
export async function testPericulumAction(_p: ActionState, _fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = explainSignIn(await checkPericulumSignIn());
    await recordSignInTest(ctx, r.ok, r.message);
    revalidatePath("/admin/periculum");
    return r.ok ? { ok: true, message: r.message, nonce: Date.now() } : { ok: false, error: r.message, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
