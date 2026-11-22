"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../_lib/auth";
import { toActionError, type ActionState } from "../../_lib/action";
import { assembleBouquet, concurBouquet, excludeMember, markInspected, restoreMember, sampleMember, type ExclusionAction } from "@/server/domain/bouquet";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function assembleAction(_p: ActionState, _fd: FormData): Promise<ActionState> {
  void _fd;
  const { ctx } = await requireUser();
  let id: string;
  try {
    const r = await assembleBouquet(ctx);
    id = r.id;
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/bouquets");
  redirect(`/bouquets/${id}`);
}

export async function refreshAction(_p: ActionState, _fd: FormData): Promise<ActionState> {
  void _fd;
  const { ctx } = await requireUser();
  try {
    const r = await assembleBouquet(ctx);
    revalidatePath(`/bouquets/${r.id}`);
    const parts = [r.added ? `${r.added} added` : null, r.refreshed ? `${r.refreshed} refreshed for fresh review` : null, r.left ? `${r.left} left (no longer eligible)` : null].filter(Boolean);
    return {
      ok: true,
      message: parts.length ? `Bouquet updated: ${parts.join(", ")}.` : "No change: the bouquet is up to date.",
      nonce: Date.now(),
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function sampleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  let to: string;
  try {
    const r = await sampleMember(ctx, s(fd, "bouquetId"));
    to = `/requests/${r.applicationId}?bouquet=${s(fd, "bouquetId")}&member=${r.memberId}&sampled=1`;
  } catch (e) {
    return toActionError(e);
  }
  redirect(to);
}

export async function inspectAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await markInspected(ctx, s(fd, "memberId"), s(fd, "note"));
  } catch (e) {
    return toActionError(e);
  }
  const back = s(fd, "bouquetId");
  if (back) redirect(`/bouquets/${back}`);
  return { ok: true, message: "Marked as inspected.", nonce: Date.now() };
}

export async function excludeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = await excludeMember(ctx, s(fd, "memberId"), s(fd, "reason"), s(fd, "exclusionAction") as ExclusionAction);
    revalidatePath("/bouquets");
    return { ok: true, message: `Excluded. ${r.outcome}`, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function restoreAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await restoreMember(ctx, s(fd, "memberId"));
    return { ok: true, message: "Restored to the bouquet.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function concurAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const id = s(fd, "bouquetId");
  try {
    await concurBouquet(ctx, {
      bouquetId: id,
      acknowledged: s(fd, "acknowledged") === "on",
      expectedCount: Number(s(fd, "expectedCount")),
      expectedTotalKobo: s(fd, "expectedTotalKobo"),
    });
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/bouquets");
  revalidatePath("/queue");
  redirect(`/bouquets/${id}?concurred=1`);
}
