"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { invalid } from "@/server/errors";
import { applyImport, holdRecord, previewImport, recordRepayment, saveRecord } from "@/server/staff/register";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function uploadRegisterAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  let id: string;
  try {
    const file = fd.get("file");
    if (!(file instanceof File) || !file.size) throw invalid("Choose the CSV file.");
    id = await previewImport(ctx, file.name, Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    return toActionError(e);
  }
  redirect(`/admin/salary-register/imports/${id}`);
}

export async function decideImportAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const decision = s(fd, "decision") === "DISCARD" ? "DISCARD" : "APPLY";
    const r = await applyImport(ctx, s(fd, "importId"), decision);
    revalidatePath("/admin/salary-register");
    return { ok: true, message: decision === "APPLY" ? `Applied: ${r.created} created, ${r.updated} updated. Rows with errors were not applied.` : "Import discarded. The register is unchanged.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function saveRecordAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = await saveRecord(
      ctx,
      {
        staffId: s(fd, "staffId"),
        staffNumber: s(fd, "staffNumber"),
        monthlySalary: s(fd, "monthlySalary"),
        accountNumber: s(fd, "accountNumber"),
        accountName: s(fd, "accountName"),
        employmentStatus: s(fd, "employmentStatus"),
        salaryAsOf: s(fd, "salaryAsOf"),
      },
      s(fd, "reason"),
    );
    revalidatePath("/admin/salary-register");
    return { ok: true, message: r === "UNCHANGED" ? "No change: the record already holds these values." : r === "CREATED" ? "Record created." : "Record updated.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function holdAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const hold = s(fd, "hold") === "1";
    await holdRecord(ctx, s(fd, "staffId"), hold, s(fd, "reason"));
    revalidatePath("/admin/salary-register");
    return { ok: true, message: hold ? "Eligibility put on hold." : "Hold released.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function repaymentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = await recordRepayment(ctx, s(fd, "requestId"), { amount: s(fd, "amount"), valueDate: s(fd, "valueDate"), reference: s(fd, "reference"), source: s(fd, "source"), note: s(fd, "note") });
    revalidatePath("/admin/salary-register/repayments");
    return { ok: true, message: r.settled ? "Repayment recorded. The advance is fully repaid." : "Repayment recorded.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
