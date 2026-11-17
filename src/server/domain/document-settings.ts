/** Bank details printed on documents ARAF prepares (Remita set-up sheet beneficiary, charges). Super Admin only. */
import { withTx, type Db } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { forbidden, invalid } from "../errors";
import { holdsRole } from "./access";
import { parseNairaToKobo } from "../money";

export interface DocumentSettingsInput {
  bankName: string;
  bankAddress: string;
  beneficiaryName: string;
  beneficiaryBank: string;
  beneficiaryAccount: string;
  beneficiaryEmail: string;
  beneficiaryPhone: string;
  charge: string; // naira, blank = not printed
  vatPercent: string;
  /** E-mail the prepared closing documents to the customer automatically (off by default). */
  customerEmail: boolean;
  reason: string;
}

export async function documentSettings(q: Db) {
  return (await q.query("SELECT * FROM document_settings WHERE id = 1")).rows[0];
}

export async function saveDocumentSettings(ctx: Ctx, i: DocumentSettingsInput) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const f: Record<string, string> = {};
  if (i.bankName.trim().length < 3) f.bankName = "Enter the bank's name.";
  if (i.beneficiaryAccount.trim() && !/^\d{10}$/.test(i.beneficiaryAccount.trim())) f.beneficiaryAccount = "Enter a 10-digit account number.";
  if (i.beneficiaryEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.beneficiaryEmail.trim())) f.beneficiaryEmail = "Enter a valid email.";
  let chargeKobo: number | null = null;
  if (i.charge.trim()) {
    chargeKobo = parseNairaToKobo(i.charge.trim());
    if (chargeKobo === null || chargeKobo < 0) f.charge = "Enter an amount in naira, e.g. 1000.";
  }
  const vat = i.vatPercent.trim() ? Number(i.vatPercent) : null;
  if (vat !== null && (!Number.isFinite(vat) || vat < 0 || vat > 100)) f.vatPercent = "Enter a percentage between 0 and 100.";
  if (i.reason.trim().length < 20) f.reason = "Give a reason of at least 20 characters.";
  if (Object.keys(f).length) throw invalid("Check the highlighted fields.", f);
  await withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden();
    const before = (await tx.query("SELECT * FROM document_settings WHERE id = 1 FOR UPDATE")).rows[0];
    const v = (s: string) => s.trim() || null;
    await tx.query(
      `UPDATE document_settings SET bank_name = $1, bank_address = $2, remita_beneficiary_name = $3, remita_beneficiary_bank = $4, remita_beneficiary_account = $5,
         remita_beneficiary_email = $6, remita_beneficiary_phone = $7, remita_charge_kobo = $8, remita_vat_percent = $9, updated_by = $10, updated_at = $11,
         customer_email_enabled = $12,
         customer_email_enabled_at = CASE WHEN $12 AND NOT customer_email_enabled THEN $11 WHEN $12 THEN customer_email_enabled_at ELSE NULL END WHERE id = 1`,
      [i.bankName.trim(), v(i.bankAddress), v(i.beneficiaryName), v(i.beneficiaryBank), v(i.beneficiaryAccount), v(i.beneficiaryEmail), v(i.beneficiaryPhone), chargeKobo, vat, actor.staffId, ctx.now, i.customerEmail],
    );
    await audit(tx, ctx, {
      action: "DOCUMENT_SETTINGS_CHANGED",
      actorRole: "SUPER_ADMIN",
      reason: i.reason.trim(),
      details: { previous: { ...before, updated_by: undefined }, next: { bankName: i.bankName, beneficiaryName: i.beneficiaryName, beneficiaryBank: i.beneficiaryBank, beneficiaryAccountLast4: i.beneficiaryAccount.slice(-4), chargeKobo, vat, customerEmail: i.customerEmail } },
    });
  });
}
