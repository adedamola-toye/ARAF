"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { publishWorkflow } from "@/server/domain/approval-workflows";

/** Publish an approval workflow (direct publication by a Super Admin, with a mandatory reason). */
export async function publishWorkflowAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const productCode = String(fd.get("productCode") ?? "");
  let published: { id: string } | null = null;
  try {
    let definition: unknown = null;
    const raw = String(fd.get("definition") ?? "");
    if (raw) {
      try {
        definition = JSON.parse(raw);
      } catch {
        return { ok: false, error: "The workflow could not be read. Reload the page and try again." };
      }
    }
    published = await publishWorkflow(ctx, {
      productCode,
      definition,
      reason: String(fd.get("reason") ?? ""),
      expectedVersion: Number(fd.get("expectedVersion")),
      restoreFromId: String(fd.get("restoreFromId") ?? "") || null,
    });
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/admin/workflows");
  // The confirmation is read back from the published version, so it survives the page refreshing.
  redirect(`/admin/workflows/${productCode}?published=${published!.id}`);
}
