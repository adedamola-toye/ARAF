"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { toActionError, type ActionState } from "../../_lib/action";
import {
  addUpdate,
  assignTicket,
  confirmResolution,
  createTicket,
  cxCloseTicket,
  escalateTicket,
  linkTickets,
  reopenTicket,
  requestAction,
  requestInformation,
  resolveTicket,
  startWork,
  transferTicket,
  DuplicateComplaint,
} from "@/server/crm/tickets";
import { addAttachment, CRM_MAX_FILES_PER_UPLOAD } from "@/server/crm/attachments";
import { saveKbArticle } from "@/server/crm/config";
import { invalid } from "@/server/errors";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const lv = (fd: FormData) => (s(fd, "lockVersion") ? Number(s(fd, "lockVersion")) : null);
const files = (fd: FormData, k = "files") => fd.getAll(k).filter((f): f is File => f instanceof File && f.size > 0);
const done = (id: string, message: string): ActionState => {
  revalidatePath(`/crm/tickets/${id}`);
  revalidatePath("/crm", "layout");
  return { ok: true, message, nonce: Date.now() };
};

async function attach(ctx: Awaited<ReturnType<typeof requireUser>>["ctx"], id: string, list: File[], opts: { internal?: boolean; purpose?: "EVIDENCE" | "RESOLUTION" } = {}) {
  const out: string[] = [];
  for (const f of list.slice(0, CRM_MAX_FILES_PER_UPLOAD)) {
    const r = await addAttachment(ctx, id, { filename: f.name, data: Buffer.from(await f.arrayBuffer()), ...opts });
    if (r.scanStatus === "REJECTED") out.push(`${f.name} failed the malware scan and was not kept.`);
  }
  return out;
}

export async function raiseComplaintAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  let id: string;
  try {
    const list = files(fd);
    if (list.length > CRM_MAX_FILES_PER_UPLOAD) return { ok: false, error: `Attach at most ${CRM_MAX_FILES_PER_UPLOAD} files.`, nonce: Date.now() };
    const r = await createTicket(ctx, {
      idempotencyKey: s(fd, "idempotencyKey"),
      productCode: s(fd, "productCode"),
      categoryId: s(fd, "categoryId"),
      subcategoryId: s(fd, "subcategoryId"),
      subject: s(fd, "subject"),
      description: s(fd, "description"),
      requestRef: s(fd, "requestRef") || null,
      applicationId: s(fd, "applicationId") || null,
      urgent: fd.get("urgent") === "on",
      confirmDuplicate: fd.get("confirmDuplicate") === "on",
    });
    id = r.id;
    if (r.created && list.length) await attach(ctx, r.id, list);
  } catch (e) {
    if (e instanceof DuplicateComplaint) return { ok: false, error: e.message, data: { duplicates: e.duplicates }, nonce: Date.now() };
    return toActionError(e);
  }
  revalidatePath("/crm", "layout");
  redirect(`/crm/tickets/${id}?created=1`);
}

type Op = (ctx: Awaited<ReturnType<typeof requireUser>>["ctx"], id: string, fd: FormData) => Promise<string>;
const ops: Record<string, Op> = {
  assign: async (ctx, id, fd) => (await assignTicket(ctx, id, s(fd, "officerId"), s(fd, "reason") || null, lv(fd)), "Assigned. The officer has been notified."),
  start: async (ctx, id, fd) => (await startWork(ctx, id, lv(fd)), "Work started."),
  update: async (ctx, id, fd) => {
    const internal = fd.get("internal") === "on";
    const body = s(fd, "body");
    const list = files(fd);
    if (!body && !list.length) throw invalid("Write an update or attach a file.", { body: "Write an update." });
    if (body) await addUpdate(ctx, id, body, { internal });
    const warn = await attach(ctx, id, list, { internal });
    return warn.length ? warn.join(" ") : internal ? "Internal note added." : "Update added.";
  },
  info: async (ctx, id, fd) => (await requestInformation(ctx, id, s(fd, "question"), lv(fd)), "Information requested from the complainant."),
  transfer: async (ctx, id, fd) => (await transferTicket(ctx, id, s(fd, "teamId"), s(fd, "reason"), lv(fd)), "Transferred. The receiving team has been notified."),
  escalate: async (ctx, id, fd) => (await escalateTicket(ctx, id, s(fd, "reason")), "Escalated to the Team Lead and CX Head."),
  resolve: async (ctx, id, fd) => {
    const list = files(fd);
    await resolveTicket(ctx, id, s(fd, "summary"), lv(fd));
    const warn = await attach(ctx, id, list, { purpose: "RESOLUTION" });
    return warn.length ? `Resolved. ${warn.join(" ")}` : "Resolved. The complainant has been asked to confirm.";
  },
  confirm: async (ctx, id, fd) => (await confirmResolution(ctx, id, { score: s(fd, "score") ? Number(s(fd, "score")) : null, comment: s(fd, "comment") }), "Thank you. The ticket is closed."),
  reopen: async (ctx, id, fd) => (await reopenTicket(ctx, id, s(fd, "reason")), "Reopened. The team has been notified."),
  cxclose: async (ctx, id, fd) => (await cxCloseTicket(ctx, id, s(fd, "reason")), "Closed."),
  action: async (ctx, id, fd) => (await requestAction(ctx, id, s(fd, "message")), "Request sent to the team."),
  link: async (ctx, id, fd) => (await linkTickets(ctx, id, s(fd, "otherRef"), fd.get("asParent") === "on"), "Linked."),
};

export async function ticketAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const id = s(fd, "ticketId");
  const op = ops[s(fd, "op")];
  try {
    if (!op) return { ok: false, error: "Unknown action.", nonce: Date.now() };
    return done(id, await op(ctx, id, fd));
  } catch (e) {
    return toActionError(e);
  }
}

export async function kbAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await saveKbArticle(ctx, { id: s(fd, "id") || null, title: s(fd, "title"), body: s(fd, "body"), categoryId: s(fd, "categoryId") || null, status: s(fd, "status") });
    revalidatePath("/crm/kb");
    return { ok: true, message: "Saved.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
