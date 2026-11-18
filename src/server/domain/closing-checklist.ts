/**
 * Product-specific closing checklist: the documents that must be on file before the offer and contract pack
 * is submitted, re-checked before disbursement. Configurable per product by the Super Admin; products
 * without a saved checklist use the bank's standard pack.
 */
import { withTx, type Db } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { forbidden, invalid } from "../errors";
import { holdsRole } from "./access";
import { CATEGORY_LABEL, currentCleanDocuments } from "./documents";
import { invoiceConfirmationBlocker } from "./invoice-confirmation";

export interface ChecklistItem {
  code: string;
  required: boolean;
}
/** Documents a checklist may include. */
export const CHECKLIST_CANDIDATES = ["GENERATED_OFFER", "SIGNED_OFFER", "KYC", "PRE_DISBURSEMENT", "GSI_FORM", "REMITA_MANDATE", "INSURANCE_SIGNED"];
export const STANDARD_CHECKLIST: ChecklistItem[] = [
  { code: "GENERATED_OFFER", required: true },
  { code: "SIGNED_OFFER", required: true },
  { code: "KYC", required: true },
  { code: "PRE_DISBURSEMENT", required: true },
  { code: "GSI_FORM", required: true },
  { code: "REMITA_MANDATE", required: false },
  { code: "INSURANCE_SIGNED", required: true },
];
export const CHECKLIST_LABELS: Record<string, string> = {
  ...CATEGORY_LABEL,
  GENERATED_OFFER: "Offer letter (prepared by ARAF)",
  GSI_FORM: "Signed GSI mandate form",
  REMITA_MANDATE: "Signed Remita direct debit mandate",
  CONTRACT_EVIDENCE: "Structure-specific contracting evidence",
};

export function checklistKey(app: { workflow: string; product_code: string | null }) {
  return app.workflow === "RETAIL" ? (app.product_code ?? "RETAIL") : "WAKEELBOOST";
}

export async function checklistItems(q: Db, key: string): Promise<ChecklistItem[]> {
  const r = (await q.query<{ items: ChecklistItem[] }>("SELECT items FROM closing_checklists WHERE product_code = $1", [key])).rows[0];
  return r?.items ?? STANDARD_CHECKLIST;
}

export interface ChecklistStatus {
  code: string;
  label: string;
  required: boolean;
  onFile: boolean;
}

/** The checklist for a request with what is on file (contract evidence is added when the structure has a contract sequence). */
export async function checklistStatus(q: Db, app: { id: string; workflow: string; product_code: string | null }, contractSequence = false): Promise<ChecklistStatus[]> {
  // Contracting / acquisition evidence is not part of the pack: it is taken at RM disbursement confirmation.
  void contractSequence;
  const items = (await checklistItems(q, checklistKey(app))).filter((i) => i.code !== "CONTRACT_EVIDENCE");
  const cats = new Set((await currentCleanDocuments(q, app.id)).map((d) => d.category));
  return items.map((i) => ({ code: i.code, label: CHECKLIST_LABELS[i.code] ?? i.code, required: i.required, onFile: cats.has(i.code) }));
}

export async function missingRequired(q: Db, app: { id: string; workflow: string; product_code: string | null }, contractSequence = false): Promise<string[]> {
  return (await checklistStatus(q, app, contractSequence)).filter((i) => i.required && !i.onFile).map((i) => i.label);
}

/** Disbursement readiness: the closing checklist and the invoice confirmation. */
export async function disbursementBlockers(q: Db, app: { id: string; workflow: string; product_code: string | null }, contractSequence = false): Promise<string[]> {
  const out: string[] = [];
  const miss = await missingRequired(q, app, contractSequence);
  if (miss.length) out.push(`Missing from the closing pack: ${miss.join(", ")}.`);
  const ic = await invoiceConfirmationBlocker(q, app.id);
  if (ic) out.push(ic);
  return out;
}

export async function saveChecklist(ctx: Ctx, key: string, items: ChecklistItem[], reason: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (reason.trim().length < 20) throw invalid("Give a reason of at least 20 characters.", { reason: "Give a reason of at least 20 characters." });
  const clean = items.filter((i) => CHECKLIST_CANDIDATES.includes(i.code));
  if (!clean.some((i) => i.code === "SIGNED_OFFER" && i.required)) throw invalid("The signed offer letter must stay required.");
  await withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden();
    const before = await checklistItems(tx, key);
    await tx.query(
      `INSERT INTO closing_checklists (product_code, items, updated_by, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (product_code) DO UPDATE SET items = EXCLUDED.items, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [key, JSON.stringify(clean), actor.staffId, ctx.now],
    );
    await audit(tx, ctx, { action: "CLOSING_CHECKLIST_CHANGED", actorRole: "SUPER_ADMIN", reason: reason.trim(), details: { product: key, previous: before, next: clean } });
  });
}
