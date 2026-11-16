"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { discardDraft, dismissProposal, publishDraft, reviewSavedDraft, saveDraft, saveGeneralDirect, startDraft, type SaveInput } from "@/server/domain/product-settings";
import type { General } from "@/lib/product-settings";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const page = (code: string) => `/admin/product-settings/${encodeURIComponent(code)}`;

/** Start (or replace) the working draft, then open the editor. */
export async function startDraftAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const code = s(fd, "productCode");
  try {
    const kind = s(fd, "kind") as "SUPPLIED" | "BLANK" | "VERSION" | "PROPOSAL";
    await startDraft(ctx, code, { kind, ref: s(fd, "ref") || null, replace: s(fd, "replace") === "true" });
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/admin/product-settings");
  redirect(`${page(code)}?edit=1`);
}

/** Save Draft (called from the editor; "Saved" is shown only after this returns). */
export async function saveDraftAction(code: string, input: SaveInput): Promise<ActionState & { revision?: number; savedAt?: string }> {
  const { ctx } = await requireUser();
  try {
    const r = await saveDraft(ctx, code, input);
    return { ok: true, revision: r.revision, savedAt: r.savedAt.toISOString() };
  } catch (e) {
    return toActionError(e);
  }
}

/** Review Configuration: the server's checks on the saved draft (including approvers and contract types). */
export async function reviewAction(code: string): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    return { ok: true, data: await reviewSavedDraft(ctx, code) };
  } catch (e) {
    return toActionError(e);
  }
}

export async function discardDraftAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const code = s(fd, "productCode");
  try {
    await discardDraft(ctx, code);
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/admin/product-settings");
  redirect(page(code));
}

/** Review & Publish: the draft is saved first by the editor, then published with its reason and effective date. */
export async function publishAction(code: string, input: { reason: string; revision: number; effectiveFrom: string | null }): Promise<ActionState> {
  const { ctx } = await requireUser();
  let id: string;
  try {
    id = (await publishDraft(ctx, code, input)).id;
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/admin/product-settings");
  redirect(`${page(code)}?published=${id}`);
}

export async function dismissProposalAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await dismissProposal(ctx, s(fd, "id"), s(fd, "reason"));
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/admin/product-settings");
  return { ok: true, message: "Proposal dismissed. It stays in the version history.", nonce: Date.now() };
}

/** General settings of WakeelBoost (its pricing, workflow and documents are managed in their own screens). */
export async function saveGeneralAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const code = s(fd, "productCode");
  const roles = fd.getAll("originationRoles").map(String);
  const general: General = { name: s(fd, "name"), description: s(fd, "description"), owner: s(fd, "owner"), originationRoles: s(fd, "allRoles") === "on" ? null : roles, active: s(fd, "active") === "on" };
  try {
    const r = await saveGeneralDirect(ctx, code, general, s(fd, "reason"));
    revalidatePath("/admin/product-settings");
    return { ok: true, message: `Saved: ${r.changes} change${r.changes === 1 ? "" : "s"} applied and recorded in the audit trail.`, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
