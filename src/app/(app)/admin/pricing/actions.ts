"use server";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { createProduct, proposeMarkup, proposeTenor, saveContractType } from "@/server/domain/product-admin";
import type { CustomerProfile, RateConvention } from "@/server/domain/products";
import { fromLagos } from "@/server/time";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const effective = (fd: FormData) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s(fd, "effectiveFrom"));
  return m ? fromLagos(Number(m[1]), Number(m[2]), Number(m[3])) : new Date(NaN);
};
const APPROVAL = "It takes effect only after a Product Configuration Approver (a different person) approves it under Products and rules.";

async function run(op: (ctx: Awaited<ReturnType<typeof requireUser>>["ctx"]) => Promise<string>): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    return { ok: true, message: await op(ctx), nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export const markupAction = async (_p: ActionState, fd: FormData) =>
  run(async (ctx) => {
    const action = s(fd, "action") === "REMOVE" ? "REMOVE" : "SET";
    const r = await proposeMarkup(ctx, {
      productCode: s(fd, "productCode"),
      profile: (s(fd, "profile") || "ALL") as CustomerProfile | "ALL",
      contractType: s(fd, "contractType"),
      action,
      markupPercent: s(fd, "markupPercent"),
      rateConvention: (s(fd, "rateConvention") || null) as RateConvention | null,
      effectiveFrom: effective(fd),
      reason: s(fd, "reason"),
    });
    return `${action === "REMOVE" ? "Removal" : "Mark-up"} proposed as version ${r.version}. ${APPROVAL}`;
  });

export const tenorAction = async (_p: ActionState, fd: FormData) =>
  run(async (ctx) => {
    const min = s(fd, "minMonths");
    const r = await proposeTenor(ctx, {
      productCode: s(fd, "productCode"),
      profile: (s(fd, "profile") || "ALL") as CustomerProfile | "ALL",
      minMonths: min ? Number(min) : null,
      maxMonths: Number(s(fd, "maxMonths")),
      effectiveFrom: effective(fd),
      reason: s(fd, "reason"),
    });
    return `Tenor change proposed as version ${r.version}. ${APPROVAL}`;
  });

export const contractTypeAction = async (_p: ActionState, fd: FormData) =>
  run(async (ctx) => {
    const isNew = s(fd, "isNew") === "1";
    const r = await saveContractType(ctx, { code: s(fd, "code") || null, name: s(fd, "name"), description: s(fd, "description"), active: fd.has("active") ? s(fd, "active") === "true" : undefined, isNew });
    return isNew ? `Contract type ${r.code} added. Give it a mark-up on a product to offer it.` : "Contract type updated.";
  });

export const createProductAction = async (_p: ActionState, fd: FormData) =>
  run(async (ctx) => {
    const r = await createProduct(ctx, { code: s(fd, "code") || null, name: s(fd, "name"), description: s(fd, "description"), copyFrom: s(fd, "copyFrom"), reason: s(fd, "reason") });
    return `Product ${r.code} created, closed to applications. Its first configuration is waiting for approval under Products and rules; open the product there once it is approved.`;
  });
