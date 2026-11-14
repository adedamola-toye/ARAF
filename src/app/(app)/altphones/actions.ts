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
import { decideReplenishment, decideStockCount, requestReplenishment, submitStockCount } from "@/server/altphones/stock";
import { commitImport, discardImport, previewImport } from "@/server/altphones/imports";
import { invalid } from "@/server/errors";
import { applyProfiling, decideAddressRequest, decideBpmRequest, rerouteWaitingNow, discardProfiling, linkSource, previewProfiling, proposeLocation, requestAddress, requestBpmMapping } from "@/server/altphones/location-master";
import { decideBatch, decideMatching, decideRecord, discardBatch, mapLocations, mapReferrers, setAsAt, stageRegister, submitBatch } from "@/server/altphones/migration";

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
        externalBankCode: s(fd, "externalBankCode"),
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

/** Physical count: one "count_<modelId>" field per phone line; blanks are not counted. */
export const stockCountAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) =>
      submitStockCount(ctx, {
        locationId: s(fd, "locationId"),
        countedOn: s(fd, "countedOn"),
        note: s(fd, "note"),
        lines: [...fd.keys()].filter((k) => k.startsWith("count_")).map((k) => ({ modelId: k.slice(6), counted: s(fd, k) })),
      }),
    (r) => {
      const x = r as { ref: string; variance: number };
      return `Count ${x.ref} sent for approval (${x.variance >= 0 ? "+" : ""}${x.variance} against the ledger).`;
    },
  );
export const decideStockCountAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) => decideStockCount(ctx, s(fd, "id"), { decision: s(fd, "decision") as "APPROVE" | "REJECT", comment: s(fd, "comment") }),
    (r) => {
      const x = r as { ref: string; adjustment: number };
      return `${x.ref} decided${x.adjustment ? ` (${x.adjustment > 0 ? "+" : ""}${x.adjustment} posted to the ledger)` : ""}.`;
    },
  );

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

// ---------- historical migration ----------

export async function stageRegisterAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  let id: string;
  try {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw invalid("Choose the register workbook.", { file: "Choose a file." });
    id = (await stageRegister(ctx, { filename: file.name, data: Buffer.from(await file.arrayBuffer()), asAt: s(fd, "asAt") })).id;
  } catch (e) {
    return toActionError(e);
  }
  redirect(`/altphones/migration/${id}`);
}
export const setAsAtAction = async (_p: ActionState, fd: FormData) => run((ctx) => setAsAt(ctx, s(fd, "batchId"), s(fd, "asAt")), "As-at date saved and every record re-evaluated.");
/** Label links: pairs of fields "label_<n>" and "to_<n>"; blanks are skipped. */
const pairs = (fd: FormData) =>
  [...fd.keys()]
    .filter((k) => k.startsWith("label_"))
    .map((k) => ({ label: s(fd, k), to: s(fd, `to_${k.slice(6)}`) }))
    .filter((x) => x.to);
export const mapLocationsAction = async (_p: ActionState, fd: FormData) =>
  run((ctx) => mapLocations(ctx, s(fd, "batchId"), pairs(fd).map((x) => ({ label: x.label, locationId: x.to }))), (r) => `${(r as { saved: number }).saved} location label${(r as { saved: number }).saved === 1 ? "" : "s"} linked.`);
export const mapReferrersAction = async (_p: ActionState, fd: FormData) =>
  run((ctx) => mapReferrers(ctx, s(fd, "batchId"), pairs(fd).map((x) => ({ label: x.label, staffId: x.to }))), (r) => `${(r as { saved: number }).saved} name${(r as { saved: number }).saved === 1 ? "" : "s"} linked to staff.`);
export const decideRecordAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) => decideRecord(ctx, s(fd, "recordId"), { decision: s(fd, "decision"), classification: s(fd, "classification"), note: s(fd, "note") }),
    (r) => {
      const b = (r as { blocked: number }).blocked;
      return `Decision saved. ${b ? `${b} record${b === 1 ? "" : "s"} still need${b === 1 ? "s" : ""} a decision.` : "No records are blocked."}`;
    },
  );
export const submitBatchAction = async (_p: ActionState, fd: FormData) => run((ctx) => submitBatch(ctx, s(fd, "batchId"), s(fd, "note")), (r) => `${(r as { ref: string }).ref} sent to the Unit Head for approval.`);
export const discardBatchAction = async (_p: ActionState, fd: FormData) => run((ctx) => discardBatch(ctx, s(fd, "batchId"), s(fd, "reason")), (r) => `${(r as { ref: string }).ref} discarded. Its staged personal data has been cleared.`);
export const decideBatchAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) => decideBatch(ctx, s(fd, "batchId"), { decision: s(fd, "decision"), comment: s(fd, "comment") }),
    (r) => {
      const x = r as { ref: string; published: number };
      return x.published ? `${x.ref} approved: ${x.published.toLocaleString("en-NG")} historical accounts published as verified.` : `${x.ref} returned to the preparer.`;
    },
  );
export const decideMatchingAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) =>
      decideMatching(ctx, s(fd, "batchId"), { sheet: s(fd, "f_sheet"), status: s(fd, "f_status"), issue: s(fd, "f_issue"), q: s(fd, "f_q") }, { decision: s(fd, "decision"), classification: s(fd, "classification"), note: s(fd, "note") }),
    (r) => {
      const x = r as { decided: number; blocked: number };
      return `${x.decided.toLocaleString("en-NG")} records decided. ${x.blocked ? `${x.blocked.toLocaleString("en-NG")} still need a decision.` : "No records are blocked."}`;
    },
  );

// ---------- location master ----------

export async function previewProfilingAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw invalid("Choose the profiling workbook.", { file: "Choose a file." });
    await previewProfiling(ctx, { filename: file.name, data: Buffer.from(await file.arrayBuffer()) });
  } catch (e) {
    return toActionError(e);
  }
  redirect("/altphones/locations?tab=import");
}
export const linkSourceAction = async (_p: ActionState, fd: FormData) => run((ctx) => linkSource(ctx, s(fd, "sourceId"), s(fd, "locationId") || null), "Link saved and the import re-checked.");
export const applyProfilingAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) => applyProfiling(ctx, s(fd, "importId")),
    (r) => {
      const x = r as { ref: string; created: number; registered: number; flagged: number; bpmStates: number };
      return `${x.ref} applied: ${x.created} locations created, ${x.registered} addresses registered, ${x.flagged} flagged for an address, ${x.bpmStates} states mapped to a BPM.`;
    },
  );
export const discardProfilingAction = async (_p: ActionState, fd: FormData) => run((ctx) => discardProfiling(ctx, s(fd, "importId")), "Import discarded. Nothing was changed.");
export const requestAddressAction = async (_p: ActionState, fd: FormData) =>
  run((ctx) => requestAddress(ctx, { locationId: s(fd, "locationId"), address: s(fd, "address"), choice: s(fd, "choice"), note: s(fd, "note") }), (r) => `Address request ${(r as { ref: string }).ref} sent to the Unit Head.`);
export const proposeLocationAction = async (_p: ActionState, fd: FormData) =>
  run((ctx) => proposeLocation(ctx, { state: s(fd, "state"), type: s(fd, "type"), name: s(fd, "name"), address: s(fd, "address"), note: s(fd, "note") }), (r) => `Location proposed (${(r as { ref: string }).ref}). It stays inactive until the Unit Head approves its address.`);
export const decideAddressAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) => decideAddressRequest(ctx, s(fd, "id"), { decision: s(fd, "decision"), note: s(fd, "note") }),
    (r) => {
      const x = r as { ref: string; approved: boolean; activated?: boolean };
      return x.approved ? `${x.ref} approved: the address is registered${x.activated ? " and the location is active" : ""}.` : `${x.ref} rejected.`;
    },
  );
export const requestBpmAction = async (_p: ActionState, fd: FormData) =>
  run(
    (ctx) => requestBpmMapping(ctx, { scope: s(fd, "scope"), state: s(fd, "state"), locationId: s(fd, "locationId"), email: s(fd, "email"), note: s(fd, "note") }),
    (r) => `Mapping request ${(r as { ref: string }).ref} sent to the Unit Head. It takes effect once approved.`,
  );
export const decideBpmAction = async (_p: ActionState, fd: FormData) =>
  run((ctx) => decideBpmRequest(ctx, s(fd, "id"), { decision: s(fd, "decision"), note: s(fd, "note") }), (r) => ((r as { approved: boolean }).approved ? `${(r as { ref: string }).ref} approved: the mapping is in effect.` : `${(r as { ref: string }).ref} rejected.`));
export const rerouteAction = async (_p: ActionState) =>
  run(
    (ctx) => rerouteWaitingNow(ctx),
    (r) => {
      const x = r as { moved: number; left: number };
      return `${x.moved} application${x.moved === 1 ? "" : "s"} moved to a BPM. ${x.left ? `${x.left} still waiting for a mapping.` : "None are waiting."}`;
    },
  );
