"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { saveBouquetSettings, type ExclusionAction } from "@/server/domain/bouquet";
import { parseNairaToKobo } from "@/server/money";

export async function saveBouquetSettingsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const amt = (k: string) => {
    const v = String(fd.get(k) ?? "").trim();
    return v ? (parseNairaToKobo(v) ?? -1) : null;
  };
  try {
    await saveBouquetSettings(
      ctx,
      {
        eligibleProducts: fd.getAll("products").map(String),
        maxSize: Number(fd.get("maxSize")),
        minInspections: Number(fd.get("minInspections")),
        individualReviewAboveKobo: amt("individualReviewAbove"),
        maxTotalKobo: amt("maxTotal"),
        exclusionDefault: String(fd.get("exclusionDefault")) as ExclusionAction,
      },
      String(fd.get("reason") ?? ""),
    );
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/admin/bouquet-settings");
  return { ok: true, message: "Bouquet settings saved. The change is recorded with your reason. Open bouquets use the new settings at concurrence.", nonce: Date.now() };
}
