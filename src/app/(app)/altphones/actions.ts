"use server";
import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { toActionError, type ActionState } from "../../_lib/action";
import {
  acceptContract,
  cancelApplication,
  checkDirectDebit,
  checkPayment,
  completeOutright,
  confirmInternalMandate,
  recordRefund,
  requestPayment,
  retryReservation,
  runCreditCheck,
  saveCustomer,
  saveLocations,
  sendContractOtp,
  startDirectDebit,
  startSale,
  submitForApproval,
} from "@/server/altphones/origination";
import { confirmDisbursement, decide, type Decision } from "@/server/altphones/approvals";
import { saveContract, saveHoliday, saveModel, savePolicy, savePricing, setModelImage } from "@/server/altphones/catalogue";
import { decideReplenishment, requestReplenishment } from "@/server/altphones/stock";
import { commitImport, discardImport, previewImport } from "@/server/altphones/imports";
import { invalid } from "@/server/errors";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const on = (fd: FormData, k: string) => ["on", "true", "1"].includes(String(fd.get(k) ?? ""));
const lock = (fd: FormData) => (fd.get("lockVersion") ? Number(fd.get("lockVersion")) : null);
type Ctx = Awaited<ReturnType<typeof requireUser>>["ctx"];

async function run(op: (ctx: Ctx) => Promise<unknown>, ok: string | ((r: unknown) => string)): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = await op(ctx);
    return { ok: true, message: typeof ok === "function" ? ok(r) : ok, nonce: Date.now(), data: r };
  } catch (e) {
    return toActionError(e);
  }
}

export async function startSaleAction(fd: FormData): Promise<void> {
  const { ctx } = await requireUser();
  let id: string;
  try {
    id = (await startSale(ctx, { kind: s(fd, "kind"), modelId: s(fd, "modelId") })).id;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "The sale could not be started.";
    redirect(`/altphones?error=${encodeURIComponent(msg)}`);
  }
  redirect(`/altphones/applications/${id}`);
}

export const locationsAction = async (_p: ActionState, fd: FormData) =>
  run((ctx) => saveLocations(ctx, s(fd, "id"), { modelId: s(fd, "modelId"), originId: s(fd, "originId"), supplyId: s(fd, "supplyId"), lockVersion: lock(fd) }), "Phone and location saved.");

export const creditCheckAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) => runCreditCheck(ctx, s(fd, "id"), { bvn: s(fd, "bvn"), firstName: s(fd, "firstName"), lastName: s(fd, "lastName"), dateOfBirth: s(fd, "dateOfBirth"), gender: s(fd, "gender"), phone: s(fd, "phone"), consent: on(fd, "consent"), lockVersion: lock(fd) }),
    (r) => (r as { message: string }).message,
  );

export const customerAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) =>
      saveCustomer(ctx, s(fd, "id"), {
        name: s(fd, "name"),
        email: s(fd, "email"),
        phone: s(fd, "phone"),
        abAccount: s(fd, "abAccount"),
        externalAccount: s(fd, "externalAccount"),
        externalBank: s(fd, "externalBank"),
        tenure: s(fd, "tenure"),
        repaymentDay: s(fd, "repaymentDay"),
        accountsConfirmed: on(fd, "accountsConfirmed"),
        lockVersion: lock(fd),
      }),
    "Customer details saved.",
  );

export const requestPaymentAction = async (_p: ActionState, fd: FormData) => run((ctx) => requestPayment(ctx, s(fd, "id"), { lockVersion: lock(fd) }), "Payment link created. Share it with the customer.");
export const checkPaymentAction = async (_p: ActionState, fd: FormData) => run((ctx) => checkPayment(ctx, s(fd, "id")), (r) => (r as { message: string }).message);
export const retryReservationAction = async (_p: ActionState, fd: FormData) => run((ctx) => retryReservation(ctx, s(fd, "id")), "Phone reserved.");
export const completeOutrightAction = async (_p: ActionState, fd: FormData) =>
  run((ctx) => completeOutright(ctx, s(fd, "id"), { imei: s(fd, "imei"), handedOver: on(fd, "handedOver"), lockVersion: lock(fd) }), "Sale completed. The receipt has been emailed to the customer.");

export const startMandateAction = async (_p: ActionState, fd: FormData) => run((ctx) => startDirectDebit(ctx, s(fd, "id")), "Mandate link created. The customer must authorise it.");
export const checkMandateAction = async (_p: ActionState, fd: FormData) => run((ctx) => checkDirectDebit(ctx, s(fd, "id")), (r) => (r as { message: string }).message);
export const internalMandateAction = async (_p: ActionState, fd: FormData) => run((ctx) => confirmInternalMandate(ctx, s(fd, "id"), { confirmed: on(fd, "confirmed"), lockVersion: lock(fd) }), "Internal mandate recorded as Officer Confirmed.");
export const sendOtpAction = async (_p: ActionState, fd: FormData) => run((ctx) => sendContractOtp(ctx, s(fd, "id"), { lockVersion: lock(fd) }), "The contract and a one-time code were emailed to the customer.");
export const acceptContractAction = async (_p: ActionState, fd: FormData) => run((ctx) => acceptContract(ctx, s(fd, "id"), { code: s(fd, "code") }), "Contract accepted by the customer.");
export const submitAction = async (_p: ActionState, fd: FormData) => run((ctx) => submitForApproval(ctx, s(fd, "id"), { comments: s(fd, "comments"), lockVersion: lock(fd) }), "Submitted for approval.");
export const cancelAction = async (_p: ActionState, fd: FormData) => run((ctx) => cancelApplication(ctx, s(fd, "id"), { reason: s(fd, "reason"), lockVersion: lock(fd) }), "Application cancelled.");
export const refundAction = async (_p: ActionState, fd: FormData) => run((ctx) => recordRefund(ctx, s(fd, "id"), { reference: s(fd, "reference") }), "Refund recorded.");

export const decideAction = async (_p: ActionState, fd: FormData) => {
  const action = s(fd, "decision") as Decision;
  const msg = { APPROVE: "Approved.", RETURN: "Returned to the officer for correction.", REJECT: "Application rejected." }[action] ?? "Saved.";
  return run((ctx) => decide(ctx, s(fd, "id"), { action, comments: s(fd, "comments"), reviewed: on(fd, "reviewed"), lockVersion: lock(fd) }), msg);
};

export const disburseAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) => confirmDisbursement(ctx, s(fd, "id"), { imei: s(fd, "imei"), modelConfirmed: on(fd, "modelConfirmed"), locationConfirmed: on(fd, "locationConfirmed"), handedOver: on(fd, "handedOver"), lockVersion: lock(fd) }),
    "Disbursement confirmed. The customer and the Altphones team have been notified.",
  );

// ------------------------------------------------------------------ catalogue, settings, stock, imports

export const modelAction = async (_p: ActionState, fd: FormData) =>
  run(async (ctx) => {
    const r = await saveModel(ctx, { id: s(fd, "id") || null, name: s(fd, "name"), specifications: String(fd.get("specifications") ?? ""), active: on(fd, "active"), sortOrder: s(fd, "sortOrder") });
    const file = fd.get("image");
    if (file instanceof File && file.size > 0) await setModelImage(ctx, r.id, Buffer.from(await file.arrayBuffer()));
    return r;
  }, "Phone saved.");

export const pricingAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) =>
      savePricing(ctx, {
        rates: { "3": s(fd, "rate3"), "6": s(fd, "rate6"), "12": s(fd, "rate12") },
        basis: s(fd, "basis"),
        weekendRule: s(fd, "weekendRule"),
        shortMonthRule: s(fd, "shortMonthRule"),
        reason: s(fd, "reason"),
      }),
    (r) => `Saved as settings version ${(r as { version: number }).version}. It applies to new sales; agreed terms are unchanged.`,
  );

export const policyAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) => savePolicy(ctx, { passMin: s(fd, "passMin"), fairMin: s(fd, "fairMin"), unitHeadId: s(fd, "unitHeadId"), teamEmail: s(fd, "teamEmail"), reason: s(fd, "reason") }),
    (r) => `Saved as settings version ${(r as { version: number }).version}.`,
  );

export const holidayAction = async (_p: ActionState, fd: FormData) => run((ctx) => saveHoliday(ctx, { date: s(fd, "date"), name: s(fd, "name"), remove: s(fd, "remove") === "1" }), "Holidays updated.");

export const replenishAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) => requestReplenishment(ctx, { kind: s(fd, "kind"), locationId: s(fd, "locationId"), modelId: s(fd, "modelId"), quantity: s(fd, "quantity"), imeis: String(fd.get("imeis") ?? ""), reason: s(fd, "reason") }),
    (r) => `Stock request ${(r as { ref: string }).ref} sent to the Super Admin for approval.`,
  );
export const decideStockAction = async (_p: ActionState, fd: FormData) =>
  run((ctx) => decideReplenishment(ctx, s(fd, "id"), { decision: s(fd, "decision") as "APPROVE" | "REJECT", comment: s(fd, "comment") }), (r) => `${(r as { ref: string }).ref} decided.`);

export const previewImportAction = async (_p: ActionState, fd: FormData) =>
  run(async (ctx) => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw invalid("Choose a CSV or Excel file.", { file: "Choose a file." });
    return previewImport(ctx, s(fd, "kind"), file.name, Buffer.from(await file.arrayBuffer()));
  }, "File checked. Review the result below before importing.");
export const commitImportAction = async (_p: ActionState, fd: FormData) => run((ctx) => commitImport(ctx, s(fd, "importId")), (r) => `Imported ${(r as { applied: number }).applied} records.`);
export const discardImportAction = async (_p: ActionState, fd: FormData) => run((ctx) => discardImport(ctx, s(fd, "importId")), "Import discarded.");

export const contractAction = async (_p: ActionState, fd: FormData) =>
  run((ctx) => saveContract(ctx, { template: String(fd.get("template") ?? ""), reason: s(fd, "reason") }), (r) => `Contract wording saved as settings version ${(r as { version: number }).version}. New contracts use it; contracts already accepted keep their text.`);
