/**
 * Altphones test and demo helpers. Provider doubles stand in for Seedfi, Paystack and email ONLY in
 * tests and the development demo script; the application never uses them on its own.
 * Markup rates here are SYNTHETIC PLACEHOLDERS, not the approved rates.
 */
import { createHmac } from "node:crypto";
import { db } from "../db";
import { ctxFor } from "./scenario";
import { saveModel, savePolicy, savePricing } from "../altphones/catalogue";
import { decideReplenishment, requestReplenishment } from "../altphones/stock";
import type { CreditBureau, MandateVerification, PaymentGateway, PaymentVerification } from "../altphones/integrations";
import type { MailTransport, OutgoingEmail } from "../notify/transport";
import type { AltApp } from "../altphones/core";

export const ALT = {
  doOfficer: "do.ife@altbank.ng",
  sa: "sa.tobi@altbank.ng",
  bpm: "bpm@altbank.ng",
  pm: "pm.altphones@altbank.ng",
  unitHead: "unit.head@altbank.ng",
  admin: "superadmin@altbank.ng",
};

export const loc = async (name: string) => (await db.query<{ id: string }>("SELECT id FROM locations WHERE name = $1", [name])).rows[0].id;
export const appRow = async (id: string) => (await db.query<AltApp>("SELECT * FROM altphones_applications WHERE id = $1", [id])).rows[0];
export const lv = async (id: string) => (await appRow(id)).lock_version;

export const DEMO_CONTRACT = `ALTPHONES FINANCING CONTRACT — SYNTHETIC TEST WORDING (replace with the bank-approved contract)
Reference {{ref}} dated {{date}} between The Alternative Bank and {{customer_name}} ({{customer_email}}, {{customer_phone}}).
Phone: {{phone_model}}. Price {{price}}; down payment {{down_payment}}; financed {{financed_amount}}.
Tenure {{tenure_months}} months at {{markup_rate}} markup ({{markup_amount}}); total repayment {{total_repayment}}.
Monthly instalment {{monthly_instalment}} (final {{final_instalment}}) on day {{repayment_day}}, first {{first_repayment_date}}, last {{final_repayment_date}}.
Accounts: Alternative Bank {{ab_account}}; {{external_bank}} {{external_account}} (Direct Debit {{dd_reference}}).
Schedule:
{{schedule}}`;

/** Catalogue, synthetic pricing, policy and stock for tests/demo. */
export async function setupAltphones(opts: { stock?: number; rates?: Record<string, string>; basis?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const pm = await ctxFor(ALT.pm, now);
  const admin = await ctxFor(ALT.admin, now);
  // The approved catalogue (migration 010); create placeholders only if it is missing.
  const models = (await db.query<{ id: string }>("SELECT id FROM altphones_models WHERE active ORDER BY sort_order, name")).rows.map((r) => r.id);
  for (let i = models.length; i < 3; i++) {
    models.push((await saveModel(pm, { name: `Altphone ${i + 1} (synthetic)`, specifications: "Synthetic specification", active: true, sortOrder: String(i) })).id);
  }
  await savePricing(pm, {
    rates: opts.rates ?? { "3": "10", "6": "20", "12": "40" },
    basis: opts.basis ?? "FLAT_TOTAL",
    weekendRule: "NEXT_BUSINESS_DAY",
    shortMonthRule: "LAST_DAY_OF_MONTH",
    contractTemplate: DEMO_CONTRACT,
    reason: "SYNTHETIC test settings",
  });
  await savePolicy(admin, { passMin: "600", fairMin: "450", unitHeadId: await sidOf(ALT.unitHead), teamEmail: "altbox@altbank.ng", reason: "SYNTHETIC test policy" });
  const qty = opts.stock ?? 5;
  if (qty > 0) {
    for (const where of ["Ikeja Branch", "Yaba Altshop"]) {
      const r = await requestReplenishment(pm, { kind: "OPENING", locationId: await loc(where), modelId: models[0], quantity: String(qty), imeis: "", reason: "Synthetic opening stock" });
      await decideReplenishment(admin, r.id, { decision: "APPROVE", comment: "" });
    }
  }
  return { models };
}

export const sidOf = async (email: string) => (await db.query<{ id: string }>("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id;

// ------------------------------------------------------------------ provider doubles

export class TestBureau implements CreditBureau {
  readonly name = "Test bureau";
  calls: { bvn: string; reference: string }[] = [];
  constructor(
    public score: number | null = 700,
    public fail: Error | null = null,
  ) {}
  async assess(input: { bvn: string; reference: string }) {
    this.calls.push(input);
    if (this.fail) throw this.fail;
    return { reference: `SF-${input.reference}`, score: this.score! };
  }
}

export const TEST_PAYSTACK_SECRET = "sk_test_synthetic_secret";

export class TestGateway implements PaymentGateway {
  readonly name = "Test gateway";
  directDebit = true;
  payments = new Map<string, { amountKobo: number; status: PaymentVerification["status"]; currency: string; txn: string | null }>();
  mandates = new Map<string, boolean>();
  private n = 0;
  async initialize(p: { reference: string; amountKobo: number }) {
    this.payments.set(p.reference, { amountKobo: p.amountKobo, status: "pending", currency: "NGN", txn: null });
    return { checkoutUrl: `https://checkout.example/${p.reference}` };
  }
  /** Simulate the customer paying (optionally the wrong amount). */
  pay(reference: string, amountKobo?: number, currency = "NGN") {
    const p = this.payments.get(reference);
    if (!p) throw new Error("unknown reference");
    p.status = "success";
    p.txn = String(1000 + ++this.n);
    if (amountKobo !== undefined) p.amountKobo = amountKobo;
    p.currency = currency;
  }
  async verify(reference: string): Promise<PaymentVerification> {
    const p = this.payments.get(reference);
    if (!p) throw new Error("unknown reference");
    return { status: p.status, amountKobo: p.amountKobo, currency: p.currency, reference, transactionId: p.txn, paidAt: p.status === "success" ? new Date() : null, channel: "bank_transfer", gatewayResponse: null };
  }
  async initDirectDebit() {
    const reference = `DD-${++this.n}`;
    this.mandates.set(reference, false);
    return { redirectUrl: `https://checkout.example/mandate/${reference}`, reference };
  }
  authorize(reference: string) {
    this.mandates.set(reference, true);
  }
  async verifyDirectDebit(reference: string): Promise<MandateVerification> {
    const ok = this.mandates.get(reference) === true;
    return { active: ok, authorizationCode: ok ? `AUTH_${reference}` : null, last4: ok ? "6789" : null, bank: ok ? "Synthetic Bank" : null };
  }
  verifySignature(rawBody: string, signature: string | null) {
    return signature === createHmac("sha512", TEST_PAYSTACK_SECRET).update(rawBody).digest("hex");
  }
  sign(rawBody: string) {
    return createHmac("sha512", TEST_PAYSTACK_SECRET).update(rawBody).digest("hex");
  }
}

export class CapturingMail implements MailTransport {
  readonly name = "capture";
  sent: OutgoingEmail[] = [];
  async send(m: OutgoingEmail) {
    this.sent.push(m);
    return { messageId: `cap-${this.sent.length}` };
  }
  lastCode() {
    const m = [...this.sent].reverse().find((x) => /one-time code/.test(x.text));
    return m ? /code to accept your Altphones financing contract is: (\d{6})/.exec(m.text)?.[1] ?? null : null;
  }
}

export async function latestPaymentRef(appId: string) {
  return (await db.query<{ reference: string }>("SELECT reference FROM altphones_payments WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1", [appId])).rows[0].reference;
}
export async function stockOf(locationName: string, modelId: string) {
  const r = (await db.query<{ physical: number; reserved: number }>("SELECT physical, reserved FROM altphones_stock WHERE location_id = $1 AND model_id = $2", [await loc(locationName), modelId])).rows[0];
  return r ? { physical: r.physical, reserved: r.reserved, available: r.physical - r.reserved } : { physical: 0, reserved: 0, available: 0 };
}
