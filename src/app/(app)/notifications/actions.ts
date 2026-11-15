"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { markRead } from "@/server/domain/notifications";
import type { ActionState } from "../../_lib/action";

export async function markReadAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { session, ctx } = await requireUser();
  const id = String(fd.get("id") ?? "");
  await markRead(db, session.staffId, ctx.now, id === "ALL" ? "ALL" : id);
  revalidatePath("/", "layout");
  return { ok: true, nonce: Date.now() };
}
