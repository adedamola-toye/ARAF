/**
 * Altphones origination by the Delight Officer (Branch) or Smile Associate (BOX):
 *
 *   OUTRIGHT: DRAFT → AWAITING_PAYMENT → PAID (unit reserved) → COMPLETED (handover, receipt)
 *   CREDIT:   DRAFT (BVN → Seedfi → customer and accounts) → AWAITING_DOWN_PAYMENT
 *             → IN_PREPARATION (unit reserved; Direct Debit, internal mandate, contract by OTP)
 *             → review (approvals.ts) → APPROVED → DISBURSED
 *
 * Payments are only ever marked successful from a Paystack verification of the exact reference,
 * amount and currency; webhooks are re-verified through the API before they change anything.
 */
import { randomUUID } from "node:crypto";
import type { Db, Tx } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { auditOutsideTx } from "../audit";
import { DomainError, conflict, forbidden, gate, invalid } from "../errors";
import { decryptField, encryptField, hmac, randomOtp, safeEqualHex, sha256Hex } from "../crypto";
import { config } from "../config";
import { holdsRole } from "../domain/access";
import { mailTransport } from "../notify/transport";
import { simpleEmail } from "../notify/templates";
import { lagosDate } from "../time";
import {
  computeTerms,
  formatNaira,
  formatRateE4,
  imeiChecksumOk,
  instalmentAmounts,
  isBvn,
  isEmail,
  isNuban,
  isTenure,
  mapScore,
  normalisePhone,
  repaymentDates,
  type AltStatus,
  type MarkupBasis,
} from "@/lib/altphones";
import {
  type AltApp,
  type AltSettings,
  alertOperations,
  auditDenied,
  BPM_ROLE,
  checkLock,
  creditReadiness,
  currentSettings,
  emailCustomer,
  expectStatus,
  isUuid,
  loadApp,
  lockApp,
  nextRef,
  notifyRole,
  notifyStaffIds,
  PM_ROLE,
  recordEvent,
  requireOriginator,
  routeUnitHead,
  settingsById,
  transition,
} from "./core";
import { renderContract, type ContractPlaceholder } from "@/lib/altphones-contract";
import { creditBureau, IntegrationUnavailable, paymentGateway, type CreditResult, type PaymentVerification } from "./integrations";
import { ALTERNATIVE_BANK_CODE, otherBanks, resolveAccount } from "./banks";
import { availableAt, holdsStock, issueUnit, locationInfo, releaseUnit, reserveUnit } from "./stock";

const EDITABLE: AltStatus[] = ["DRAFT"];

async function denyOnError<T>(ctx: Ctx, appId: string, action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") await auditDenied(ctx, appId, action, e.message);
    throw e;
  }
}

// ------------------------------------------------------------------ start

export async function startSale(ctx: Ctx, p: { kind: string; modelId: string }): Promise<{ id: string }> {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (p.kind !== "OUTRIGHT" && p.kind !== "CREDIT") throw invalid("Choose Buy Outright or Buy on Credit.");
  return withTx(async (tx) => {
    const isDo = await holdsRole(tx, actor.staffId, "DELIGHT_OFFICER");
    const isSa = await holdsRole(tx, actor.staffId, "SMILE_ASSOCIATE");
    if (!isDo && !isSa) throw forbidden("Altphones sales are originated by Delight Officers and Smile Associates.");
    const channel = isDo && isSa ? (actor.activeRole === "SMILE_ASSOCIATE" ? "SA" : "DO") : isSa ? "SA" : "DO";
    const model = isUuid(p.modelId) ? (await tx.query("SELECT id, name FROM altphones_models WHERE id = $1 AND active", [p.modelId])).rows[0] : null;
    if (!model) throw invalid("Choose a phone from the catalogue.");
    const s = await currentSettings(tx);
    if (p.kind === "CREDIT") {
      const missing = creditReadiness(s);
      if (missing.length) throw gate(`Credit sales are not available yet: ${missing.join(" ")}`);
    }
    const ref = await nextRef(tx, "altphones_ref_seq", "ALP", ctx.now);
    const app = (
      await tx.query<AltApp>(
        `INSERT INTO altphones_applications (ref, kind, channel, originator_id, originator_role, settings_id, model_id, model_name, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
        [ref, p.kind, channel, actor.staffId, channel === "DO" ? "DELIGHT_OFFICER" : "SMILE_ASSOCIATE", s.id, model.id, model.name, ctx.now],
      )
    ).rows[0];
    await recordEvent(tx, ctx, app, { action: "CREATED", to: "DRAFT", role: app.originator_role, details: { kind: p.kind, channel, model: model.name } });
    return { id: app.id };
  });
}

// ------------------------------------------------------------------ phone and locations

export async function saveLocations(ctx: Ctx, id: string, p: { modelId: string; originId: string; supplyId: string; lockVersion?: number | null }) {
  return denyOnError(ctx, id, "LOCATIONS", () =>
    withTx(async (tx) => {
      let app = await lockApp(tx, id);
      await requireOriginator(tx, ctx, app);
      expectStatus(app, EDITABLE, "Changing the phone or location");
      checkLock(app, p.lockVersion);
      const e: Record<string, string> = {};
      const model = isUuid(p.modelId) ? (await tx.query("SELECT id, name FROM altphones_models WHERE id = $1 AND active", [p.modelId])).rows[0] : null;
      if (!model) e.modelId = "Choose a phone.";
      const origin = await locationInfo(tx, p.originId);
      let supply = app.channel === "DO" ? origin : await locationInfo(tx, p.supplyId);
      if (app.channel === "DO") {
        if (!origin || !origin.active || origin.outlet_type !== "BRANCH") e.originId = "Choose your Alternative Bank Branch.";
      } else {
        if (!origin || !origin.active || origin.outlet_type !== "ALTBOX") e.originId = "Choose the BOX you are selling from.";
        if (!supply || !supply.active || !holdsStock(supply.outlet_type)) e.supplyId = "Choose the Shop or Branch that will supply the phone.";
      }
      if (Object.keys(e).length) throw invalid("Check the phone and location.", e);
      supply = supply!;
      const avail = await availableAt(tx, supply.id, model.id);
      if (avail < 1) throw invalid(`${model.name} is out of stock at ${supply.name}.`, { [app.channel === "DO" ? "originId" : "supplyId"]: "No units available here. Choose another location." });
      app = await transition(tx, ctx, app, {
        action: "LOCATIONS_SET",
        role: app.originator_role,
        set: { model_id: model.id, model_name: model.name, origin_location_id: origin!.id, supply_location_id: supply.id },
        details: { model: model.name, origin: origin!.name, supply: supply.name, availableAtSelection: avail },
      });
      return { lockVersion: app.lock_version };
    }),
  );
}

// ------------------------------------------------------------------ Seedfi credit assessment

export interface CreditCheckInput {
  bvn: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  phone: string;
  consent: boolean;
  lockVersion?: number | null;
}

/** Validate the Seed Score inputs (BVN first, as the officer captures it). */
export function validateCreditInput(p: CreditCheckInput, today: string) {
  const e: Record<string, string> = {};
  const bvn = (p.bvn ?? "").replace(/\s/g, "");
  if (!isBvn(bvn)) e.bvn = "The BVN must be exactly 11 digits.";
  const clean = (s: string) => (s ?? "").trim().replace(/\s+/g, " ");
  const first = clean(p.firstName);
  const last = clean(p.lastName);
  if (first.length < 2 || first.length > 60) e.firstName = "Enter the first name as on the BVN.";
  if (last.length < 2 || last.length > 60) e.lastName = "Enter the last name as on the BVN.";
  const dob = (p.dateOfBirth ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(new Date(`${dob}T00:00:00Z`).getTime()) || dob >= today || dob < "1900-01-01") e.dateOfBirth = "Enter the date of birth.";
  const gender = (p.gender ?? "").toLowerCase();
  if (gender !== "male" && gender !== "female") e.gender = "Choose the gender on the BVN record.";
  const phone = normalisePhone(p.phone ?? "");
  if (!phone) e.phone = "Enter a Nigerian mobile number, e.g. 0803 123 4567.";
  if (!p.consent) e.consent = "The customer's consent is required.";
  return { errors: e, bvn, first, last, dob, gender: gender as "male" | "female", phone: phone! };
}

export async function runCreditCheck(ctx: Ctx, id: string, p: CreditCheckInput) {
  const v = validateCreditInput(p, lagosDate(ctx.now));
  if (Object.keys(v.errors).length) throw invalid(v.errors.bvn ? "Enter the customer's 11-digit BVN." : "Check the customer's details for the credit check.", v.errors);
  const bvn = v.bvn;
  const customerId = `altphones-${hmac(`bvn:${bvn}`).slice(0, 32)}`;
  const pre = await denyOnError(ctx, id, "CREDIT_CHECK", () =>
    withTx(async (tx) => {
      let app = await lockApp(tx, id);
      await requireOriginator(tx, ctx, app);
      if (app.kind !== "CREDIT") throw conflict("Outright purchases do not need a credit check.");
      expectStatus(app, EDITABLE, "A credit check");
      checkLock(app, p.lockVersion);
      if (app.seedfi_status === "COMPLETED") throw conflict("The credit assessment for this application is complete. Start a new sale for a different customer.");
      const s = await currentSettings(tx);
      if (s.score_pass_min === null || s.score_fair_min === null) throw gate("Seed Score bands are not configured. A Super Admin must record them from the approved credit policy.");
      app = await transition(tx, ctx, app, {
        action: "CREDIT_CHECK_REQUESTED",
        role: app.originator_role,
        set: {
          bvn_enc: encryptField(bvn),
          bvn_hash: hmac(`bvn:${bvn}`),
          bvn_last4: bvn.slice(-4),
          customer_first_name: v.first,
          customer_last_name: v.last,
          customer_name: `${v.first} ${v.last}`,
          customer_dob: v.dob,
          customer_gender: v.gender,
          customer_phone: v.phone,
          seedfi_customer_id: customerId,
        },
        details: { bvnLast4: bvn.slice(-4), customerId },
      });
      return { app, s };
    }),
  );
  const bureau = creditBureau();
  let result: CreditResult | null = null;
  let failure: string | null = null;
  if (!bureau) failure = "SeedFi is not configured. The credit check cannot be run until the integration is set up.";
  else {
    try {
      result = await bureau.assess({ customerId, firstName: v.first, lastName: v.last, bvn, dateOfBirth: v.dob, phone: v.phone, gender: v.gender, loanDurationMonths: pre.app.tenure_months ?? null });
    } catch (e) {
      failure = e instanceof IntegrationUnavailable ? e.message : "The SeedFi request failed.";
      if (!(e instanceof IntegrationUnavailable)) console.error("[altphones] SeedFi failure", e);
    }
  }
  return withTx(async (tx) => {
    let app = await lockApp(tx, id);
    if (!result) {
      app = await transition(tx, ctx, app, { action: "CREDIT_CHECK_UNAVAILABLE", role: app.originator_role, set: { seedfi_status: "UNAVAILABLE", seedfi_last_error: failure }, details: { error: failure } });
      return { outcome: "UNAVAILABLE" as const, message: failure!, lockVersion: app.lock_version };
    }
    const outcome = mapScore(result.score, Number(pre.s.score_pass_min), Number(pre.s.score_fair_min))!;
    const bands = { passMin: pre.s.score_pass_min, fairMin: pre.s.score_fair_min, settingsVersion: pre.s.version, scoreUsed: "reviewed_seedfi_score" };
    app = await transition(tx, ctx, app, {
      action: "CREDIT_ASSESSED",
      to: outcome === "FAIL" ? "CREDIT_DECLINED" : undefined,
      role: app.originator_role,
      set: {
        seedfi_status: "COMPLETED",
        seedfi_reference: result.reference,
        seedfi_score: result.score,
        seedfi_overall_score: result.overallScore,
        seedfi_has_history: result.hasCreditHistory,
        seedfi_details: JSON.stringify({ components: result.components, validUntil: result.validUntil, isDummyData: result.isDummyData }),
        seedfi_outcome: outcome,
        seedfi_bands: JSON.stringify(bands),
        seedfi_assessed_at: ctx.now,
        seedfi_last_error: null,
      },
      details: { reference: result.reference, isDummyData: result.isDummyData, reviewedScore: result.score, overallScore: result.overallScore, hasCreditHistory: result.hasCreditHistory, outcome, bands },
    });
    return { outcome, message: outcome === "FAIL" ? `Seed Score ${result.score}: below the approval threshold. This credit application has been closed.` : `Seed Score ${result.score}: ${outcome === "PASS" ? "Pass" : "Fair"}.`, lockVersion: app.lock_version };
  });
}

// ------------------------------------------------------------------ customer and terms

export interface CustomerInput {
  name: string;
  email: string;
  phone: string;
  abAccount?: string;
  externalAccount?: string;
  /** Paystack bank code of the customer's other bank (when Paystack is configured). */
  externalBankCode?: string;
  /** Bank name typed by the officer (only when Paystack is not configured). */
  externalBank?: string;
  tenure?: string;
  repaymentDay?: string;
  accountsConfirmed?: boolean;
  lockVersion?: number | null;
}

/**
 * Account checks for a credit customer. With Paystack configured, both accounts are looked up by name
 * enquiry (Alternative Bank by its code 000304) and the names are stored as "Verified by Paystack"; the
 * officer still confirms they belong to the customer. Without Paystack, the officer confirms manually.
 */
async function checkAccounts(p: CustomerInput, e: Record<string, string>) {
  const ab = (p.abAccount ?? "").replace(/\s/g, "");
  const ext = (p.externalAccount ?? "").replace(/\s/g, "");
  if (!isNuban(ab)) e.abAccount = "Enter the 10-digit Alternative Bank account number.";
  if (!isNuban(ext)) e.externalAccount = "Enter the 10-digit account number.";
  if (!paymentGateway()) {
    const bank = (p.externalBank ?? "").trim();
    if (bank.length < 2) e.externalBank = "Enter the bank's name.";
    if (/alternative\s*bank/i.test(bank)) e.externalBank = "This must be the customer's account at another bank.";
    return { ab, ext, bankCode: null, bankName: bank, abName: null, extName: null, via: "OFFICER" as const };
  }
  const code = (p.externalBankCode ?? "").trim();
  const bank = (await otherBanks()).find((b) => b.code === code);
  if (!bank) e.externalBank = "Choose the customer's other bank.";
  let abName: string | null = null;
  let extName: string | null = null;
  if (isNuban(ab)) {
    const r = await resolveAccount(ab, ALTERNATIVE_BANK_CODE);
    if (r.status === "FOUND") abName = r.accountName;
    else if (r.status === "NOT_FOUND") e.abAccount = "No Alternative Bank account has this number.";
    else throw gate(`The account lookup is unavailable (${r.message}). Try again in a moment.`);
  }
  if (bank && isNuban(ext)) {
    const r = await resolveAccount(ext, bank.code);
    if (r.status === "FOUND") extName = r.accountName;
    else if (r.status === "NOT_FOUND") e.externalAccount = `No ${bank.name} account has this number.`;
    else throw gate(`The account lookup is unavailable (${r.message}). Try again in a moment.`);
  }
  return { ab, ext, bankCode: bank?.code ?? null, bankName: bank?.name ?? "", abName, extName, via: "PAYSTACK" as const };
}

export async function saveCustomer(ctx: Ctx, id: string, p: CustomerInput) {
  const accountErrors: Record<string, string> = {};
  let acc: Awaited<ReturnType<typeof checkAccounts>> | null = null;
  const pre = await loadApp(db, id);
  if (pre.kind === "CREDIT") acc = await checkAccounts(p, accountErrors);
  return denyOnError(ctx, id, "CUSTOMER", () =>
    withTx(async (tx) => {
      let app = await lockApp(tx, id);
      await requireOriginator(tx, ctx, app);
      expectStatus(app, EDITABLE, "Changing customer details");
      checkLock(app, p.lockVersion);
      if (app.kind === "CREDIT" && !(app.seedfi_status === "COMPLETED" && (app.seedfi_outcome === "PASS" || app.seedfi_outcome === "FAIR"))) throw gate("Run the credit assessment first.");
      const e: Record<string, string> = { ...accountErrors };
      const name = (p.name ?? "").trim().replace(/\s+/g, " ");
      if (name.length < 3 || name.length > 120) e.name = "Enter the customer's full name.";
      const email = (p.email ?? "").trim().toLowerCase();
      if (!isEmail(email)) e.email = "Enter a valid email address.";
      const phone = normalisePhone(p.phone ?? "");
      if (!phone) e.phone = "Enter a Nigerian mobile number, e.g. 0803 123 4567.";
      const set: Record<string, unknown> = { customer_name: name, customer_email: email, customer_phone: phone };
      if (app.kind === "CREDIT" && acc) {
        if (!isTenure(p.tenure)) e.tenure = "Choose 3, 6 or 12 months.";
        const day = Number(p.repaymentDay);
        if (!Number.isInteger(day) || day < 1 || day > 31) e.repaymentDay = "Choose a repayment day from 1 to 31.";
        if (!p.accountsConfirmed) e.accountsConfirmed = acc.via === "PAYSTACK" ? "Confirm both account names belong to the customer." : "Confirm you have checked the customer's Alternative Bank account.";
        Object.assign(set, {
          ab_account_number: acc.ab,
          external_account_number: acc.ext,
          external_bank_name: acc.bankName,
          external_bank_code: acc.bankCode,
          ab_account_name: acc.abName,
          external_account_name: acc.extName,
          accounts_verified_via: acc.via,
          tenure_months: Number(p.tenure),
          repayment_day: day,
          details_confirmed_by: ctx.actor!.staffId,
          details_confirmed_at: ctx.now,
        });
      }
      if (Object.keys(e).length) throw invalid("Check the customer details.", e);
      app = await transition(tx, ctx, app, {
        action: "CUSTOMER_SAVED",
        role: app.originator_role,
        set,
        details:
          app.kind === "CREDIT" && acc
            ? { tenure: Number(p.tenure), repaymentDay: Number(p.repaymentDay), accountConfirmation: acc.via === "PAYSTACK" ? "PAYSTACK_NAME_ENQUIRY_AND_OFFICER" : "OFFICER_CONFIRMED", abAccountLast4: acc.ab.slice(-4), externalAccountLast4: acc.ext.slice(-4), externalBank: acc.bankName }
            : {},
      });
      return { lockVersion: app.lock_version };
    }),
  );
}

/** Terms for the current settings (preview) — the server is the only source of the figures. */
export function termsFor(s: AltSettings, tenure: number) {
  const rate = s.markup_rates?.[String(tenure)];
  if (rate === undefined || rate === null || !s.markup_basis) return null;
  return computeTerms({ priceKobo: Number(s.outright_price_kobo), downPaymentKobo: Number(s.down_payment_kobo), tenureMonths: tenure, rateE4: Number(rate), basis: s.markup_basis as MarkupBasis });
}

// ------------------------------------------------------------------ payments (Paystack)

function paymentFor(app: AltApp) {
  return app.kind === "OUTRIGHT" ? { purpose: "OUTRIGHT", amount: Number(app.price_kobo) } : { purpose: "DOWN_PAYMENT", amount: Number(app.down_payment_kobo) };
}

/** Lock the agreed terms and open a Paystack payment for the fixed amount. */
export async function requestPayment(ctx: Ctx, id: string, p: { lockVersion?: number | null }) {
  const gw = paymentGateway();
  const pre = await denyOnError(ctx, id, "PAYMENT_REQUEST", () =>
    withTx(async (tx) => {
      let app = await lockApp(tx, id);
      await requireOriginator(tx, ctx, app);
      expectStatus(app, ["DRAFT", "AWAITING_PAYMENT", "AWAITING_DOWN_PAYMENT"], "Requesting payment");
      checkLock(app, p.lockVersion);
      if (!gw) throw gate("Paystack is not configured, so payments cannot be collected yet. An administrator must set up the Paystack integration.");
      if (!app.supply_location_id || !app.model_id) throw gate("Choose the phone and the supplying location first.");
      if (!app.customer_name || !app.customer_email) throw gate("Enter the customer's details first.");
      if (app.status === "DRAFT") {
        const avail = await availableAt(tx, app.supply_location_id, app.model_id);
        if (avail < 1) throw gate(`${app.model_name} is out of stock at the supplying location. Choose another location.`);
        const s = await currentSettings(tx);
        const set: Record<string, unknown> = { settings_id: s.id, terms_locked_at: ctx.now };
        if (app.kind === "OUTRIGHT") {
          set.price_kobo = s.outright_price_kobo;
        } else {
          if (app.seedfi_outcome !== "PASS" && app.seedfi_outcome !== "FAIR") throw gate("The credit assessment has not passed.");
          if (!app.details_confirmed_at || !app.tenure_months) throw gate("Confirm the customer's accounts and the tenure first.");
          const missing = creditReadiness(s);
          if (missing.length) throw gate(`Credit sales are not available: ${missing.join(" ")}`);
          const t = termsFor(s, app.tenure_months)!;
          Object.assign(set, {
            price_kobo: t.priceKobo,
            down_payment_kobo: t.downPaymentKobo,
            financed_kobo: t.financedKobo,
            markup_rate_e4: t.rateE4,
            markup_basis: t.basis,
            markup_kobo: t.markupKobo,
            total_repayment_kobo: t.totalRepaymentKobo,
            instalment_kobo: t.instalmentKobo,
            final_instalment_kobo: t.finalInstalmentKobo,
          });
        }
        app = await transition(tx, ctx, app, { action: "TERMS_LOCKED", to: app.kind === "OUTRIGHT" ? "AWAITING_PAYMENT" : "AWAITING_DOWN_PAYMENT", role: app.originator_role, set, details: { settingsVersion: s.version } });
      }
      const existing = (await tx.query("SELECT 1 FROM altphones_payments WHERE application_id = $1 AND status = 'SUCCESS'", [app.id])).rowCount;
      if (existing) throw conflict("Payment has already been received for this application.");
      const { purpose, amount } = paymentFor(app);
      const reference = `${app.ref}-${purpose === "OUTRIGHT" ? "P" : "D"}-${randomUUID().slice(0, 8)}`.toUpperCase();
      await tx.query("UPDATE altphones_payments SET status = 'ABANDONED' WHERE application_id = $1 AND status = 'INITIATED'", [app.id]);
      await tx.query("INSERT INTO altphones_payments (application_id, purpose, reference, amount_kobo, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6)", [app.id, purpose, reference, amount, ctx.actor!.staffId, ctx.now]);
      await recordEvent(tx, ctx, app, { action: "PAYMENT_REQUESTED", role: app.originator_role, details: { reference, purpose, amountKobo: amount } });
      return { app, reference, amount };
    }),
  );
  let checkoutUrl: string;
  try {
    ({ checkoutUrl } = await gw!.initialize({ reference: pre.reference, amountKobo: pre.amount, email: pre.app.customer_email, callbackUrl: `${config.appUrl}/altphones/applications/${id}`, metadata: { application_ref: pre.app.ref } }));
  } catch (e) {
    await db.query("UPDATE altphones_payments SET status = 'FAILED', failure_reason = $2 WHERE reference = $1", [pre.reference, e instanceof IntegrationUnavailable ? e.message : "Paystack request failed"]);
    throw gate(e instanceof IntegrationUnavailable ? `${e.message} Try again in a moment.` : "Paystack could not start the payment. Try again in a moment.");
  }
  await db.query("UPDATE altphones_payments SET checkout_url = $2 WHERE reference = $1", [pre.reference, checkoutUrl]);
  return { reference: pre.reference, checkoutUrl };
}

/**
 * Apply a Paystack verification (from the officer's status check or a re-verified webhook). Idempotent:
 * a payment already marked successful is left as it is; the reservation is made once.
 */
async function applyVerification(tx: Tx, ctx: Ctx, reference: string, v: PaymentVerification, via: "WEBHOOK" | "VERIFY_API"): Promise<{ status: string; message: string }> {
  const pay = (await tx.query("SELECT * FROM altphones_payments WHERE reference = $1 FOR UPDATE", [reference])).rows[0];
  if (!pay) return { status: "UNKNOWN", message: "Unknown payment reference." };
  let app = await lockApp(tx, pay.application_id);
  if (pay.status === "SUCCESS") return { status: "SUCCESS", message: "Payment already confirmed." };
  if (v.status !== "success") {
    if (v.status === "failed") await tx.query("UPDATE altphones_payments SET status = 'FAILED', failure_reason = $2 WHERE id = $1", [pay.id, v.gatewayResponse ?? "failed"]);
    return { status: v.status.toUpperCase(), message: v.status === "pending" ? "Paystack has not received the payment yet." : `Paystack reports the payment as ${v.status}.` };
  }
  if (v.reference !== reference || v.currency !== "NGN" || v.amountKobo !== Number(pay.amount_kobo)) {
    await tx.query("UPDATE altphones_payments SET status = 'FAILED', failure_reason = $2 WHERE id = $1", [pay.id, `Mismatch: ${v.currency} ${v.amountKobo} for ${v.reference}`]);
    await alertOperations(tx, ctx, app, "PAYMENT_MISMATCH", "Payment amount or currency mismatch", [`Paystack reported ${v.currency} ${formatNaira(v.amountKobo)} for reference ${reference}, but ${formatNaira(pay.amount_kobo)} NGN was expected. The payment was not accepted; check it in the Paystack dashboard.`]);
    return { status: "MISMATCH", message: "The amount or currency received does not match. The Altphones team has been alerted." };
  }
  const dupTxn = v.transactionId ? (await tx.query("SELECT 1 FROM altphones_payments WHERE provider_transaction_id = $1 AND id <> $2", [v.transactionId, pay.id])).rowCount : 0;
  if (dupTxn) return { status: "DUPLICATE", message: "This Paystack transaction is already recorded against another payment." };
  await tx.query("UPDATE altphones_payments SET status = 'SUCCESS', provider_transaction_id = $2, paid_at = $3, verified_at = $4, verified_via = $5, channel = $6 WHERE id = $1", [
    pay.id,
    v.transactionId,
    v.paidAt ?? ctx.now,
    ctx.now,
    via,
    v.channel,
  ]);
  const waiting = app.status === "AWAITING_PAYMENT" || app.status === "AWAITING_DOWN_PAYMENT";
  if (!waiting) {
    // Paid after the application was closed (e.g. cancelled): keep the money visible for a refund.
    app = await transition(tx, ctx, app, { action: "PAYMENT_RECEIVED_AFTER_CLOSE", set: { refund_status: "REQUIRED" }, details: { reference } });
    await alertOperations(tx, ctx, app, "LATE_PAYMENT", "Payment received on a closed application", [`A payment for ${app.ref} was received after it was closed. A refund is required.`]);
    return { status: "SUCCESS", message: "Payment received on a closed application; a refund is required." };
  }
  const nextStatus: AltStatus = app.kind === "OUTRIGHT" ? "PAID" : "IN_PREPARATION";
  const avail = await availableAt(tx, app.supply_location_id, app.model_id);
  let deviceId: string | null = null;
  let reserved = false;
  if (avail >= 1) {
    deviceId = await reserveUnit(tx, ctx, app);
    reserved = true;
  }
  app = await transition(tx, ctx, app, {
    action: "PAYMENT_CONFIRMED",
    to: nextStatus,
    set: reserved ? { reservation_status: "RESERVED", reserved_at: ctx.now, device_id: deviceId } : {},
    details: { reference, amountKobo: v.amountKobo, via, transactionId: v.transactionId, reserved },
  });
  if (!reserved) {
    await alertOperations(tx, ctx, app, "PAID_NO_STOCK", "Paid, but no stock to reserve", [`${app.ref} was paid, but no ${app.model_name} unit was available to reserve at the supplying location. Add stock there (approved replenishment) and retry the reservation, or cancel and refund.`]);
  }
  await notifyStaffIds(tx, ctx, app, "PAID", [app.originator_id], "Payment confirmed", [`The ${app.kind === "OUTRIGHT" ? "payment" : "down payment"} for ${app.ref} has been verified.${reserved ? " A phone is reserved for the customer." : " No phone could be reserved yet; the Altphones team has been alerted."}`]);
  return { status: "SUCCESS", message: reserved ? "Payment verified and a phone reserved." : "Payment verified. No phone could be reserved; the Altphones team has been alerted." };
}

export async function checkPayment(ctx: Ctx, id: string) {
  const gw = paymentGateway();
  if (!gw) throw gate("Paystack is not configured.");
  const app = await denyOnError(ctx, id, "PAYMENT_CHECK", async () => {
    const a = await withTx(async (tx) => {
      const x = await lockApp(tx, id);
      await requireOriginator(tx, ctx, x);
      return x;
    });
    return a;
  });
  const pay = (await db.query("SELECT reference FROM altphones_payments WHERE application_id = $1 AND status IN ('INITIATED','SUCCESS') ORDER BY created_at DESC LIMIT 1", [app.id])).rows[0];
  if (!pay) throw gate("No payment has been requested.");
  let v: PaymentVerification;
  try {
    v = await gw.verify(pay.reference);
  } catch (e) {
    throw gate(e instanceof IntegrationUnavailable ? `${e.message} Try again in a moment.` : "Paystack could not be checked. Try again in a moment.");
  }
  return withTx((tx) => applyVerification(tx, ctx, pay.reference, v, "VERIFY_API"));
}

/** Retry a reservation for a paid application that had no stock at the time of payment. */
export async function retryReservation(ctx: Ctx, id: string) {
  return withTx(async (tx) => {
    let app = await lockApp(tx, id);
    const isOrig = app.originator_id === ctx.actor?.staffId;
    if (!isOrig && !(await holdsRole(tx, ctx.actor!.staffId, PM_ROLE))) throw forbidden();
    if (app.reservation_status !== "NONE" || !["PAID", "IN_PREPARATION"].includes(app.status)) throw conflict("This application does not need a reservation.");
    const avail = await availableAt(tx, app.supply_location_id, app.model_id);
    if (avail < 1) throw gate("Still no stock available at the supplying location.");
    const deviceId = await reserveUnit(tx, ctx, app);
    app = await transition(tx, ctx, app, { action: "RESERVED", set: { reservation_status: "RESERVED", reserved_at: ctx.now, device_id: deviceId } });
    return { lockVersion: app.lock_version };
  });
}

/** Paystack webhook: signature-checked, de-duplicated, and re-verified through the API before use. */
export async function handlePaystackWebhook(ctx: Ctx, rawBody: string, signature: string | null): Promise<{ status: number; outcome: string }> {
  const gw = paymentGateway();
  if (!gw) return { status: 503, outcome: "NOT_CONFIGURED" };
  if (!gw.verifySignature(rawBody, signature)) {
    await auditOutsideTx(ctx, { action: "ALTPHONES_WEBHOOK_REJECTED", outcome: "DENIED", reason: "invalid signature" });
    return { status: 401, outcome: "INVALID_SIGNATURE" };
  }
  let body: { event?: string; data?: { reference?: string } };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, outcome: "INVALID_JSON" };
  }
  const event = String(body.event ?? "");
  const reference = typeof body.data?.reference === "string" ? body.data.reference : null;
  const sha = sha256Hex(rawBody);
  const ins = await db.query("INSERT INTO altphones_provider_events (provider, event, body_sha256, reference, received_at, outcome) VALUES ('PAYSTACK',$1,$2,$3,$4,'RECEIVED') ON CONFLICT (body_sha256) DO NOTHING RETURNING id", [
    event.slice(0, 80),
    sha,
    reference,
    ctx.now,
  ]);
  if (!ins.rowCount) return { status: 200, outcome: "DUPLICATE" };
  const evId = ins.rows[0].id;
  let outcome = "IGNORED";
  try {
    if (event === "charge.success" && reference) {
      const known = (await db.query("SELECT 1 FROM altphones_payments WHERE reference = $1", [reference])).rowCount;
      if (known) {
        const v = await gw.verify(reference);
        outcome = (await withTx((tx) => applyVerification(tx, ctx, reference, v, "WEBHOOK"))).status;
      }
    } else if (event.startsWith("direct_debit.") && reference) {
      const app = (await db.query<{ id: string }>("SELECT id FROM altphones_applications WHERE dd_reference = $1", [reference])).rows[0];
      if (app) outcome = (await applyMandateCheck(ctx, app.id, true)).status;
    }
  } catch (e) {
    outcome = e instanceof IntegrationUnavailable ? "VERIFY_UNAVAILABLE" : "ERROR";
    if (!(e instanceof IntegrationUnavailable)) console.error("[altphones] webhook processing failed", e);
    await db.query("UPDATE altphones_provider_events SET outcome = $2, detail = $3 WHERE id = $1", [evId, outcome, String((e as Error).message).slice(0, 300)]);
    return { status: 500, outcome };
  }
  await db.query("UPDATE altphones_provider_events SET outcome = $2 WHERE id = $1", [evId, outcome]);
  return { status: 200, outcome };
}

// ------------------------------------------------------------------ outright completion

export async function completeOutright(ctx: Ctx, id: string, p: { imei: string; handedOver: boolean; lockVersion?: number | null }) {
  if (!p.handedOver) throw invalid("Confirm the phone was handed to the customer.", { handedOver: "Confirm the physical handover." });
  return denyOnError(ctx, id, "OUTRIGHT_COMPLETE", () =>
    withTx(async (tx) => {
      let app = await lockApp(tx, id);
      await requireOriginator(tx, ctx, app);
      if (app.kind !== "OUTRIGHT") throw conflict("This is a credit application.");
      if (app.status === "COMPLETED") return { lockVersion: app.lock_version, receipt: app.receipt_number, already: true };
      expectStatus(app, ["PAID"], "Completing the sale");
      checkLock(app, p.lockVersion);
      const paid = (await tx.query("SELECT reference FROM altphones_payments WHERE application_id = $1 AND purpose = 'OUTRIGHT' AND status = 'SUCCESS'", [app.id])).rows[0];
      if (!paid) throw gate("No verified payment is recorded for this sale.");
      if (app.reservation_status !== "RESERVED") throw gate("No phone is reserved for this sale yet.");
      const imei = p.imei.replace(/\s/g, "");
      if (/^\d{15}$/.test(imei) && !imeiChecksumOk(imei)) throw invalid("Check the IMEI.", { imei: "This IMEI fails its check digit. Re-read it from the box or dial *#06#." });
      const issued = await issueUnit(tx, ctx, app, imei, "SALE");
      const receipt = await nextRef(tx, "altphones_receipt_seq", "RCT", ctx.now);
      app = await transition(tx, ctx, app, {
        action: "OUTRIGHT_SALE_COMPLETED",
        to: "COMPLETED",
        role: app.originator_role,
        set: { imei: issued.imei, device_id: issued.deviceId, handed_over_at: ctx.now, completed_by: ctx.actor!.staffId, completed_at: ctx.now, receipt_number: receipt, reservation_status: "CONSUMED" },
        details: { imei: issued.imei, receipt, paymentReference: paid.reference },
      });
      const s = await settingsById(tx, app.settings_id);
      await emailCustomer(tx, ctx, app, "RECEIPT", "Your Altphones receipt", receiptLines(app, paid.reference), s.team_email);
      return { lockVersion: app.lock_version, receipt, already: false };
    }),
  );
}

export function receiptLines(app: AltApp, paymentReference: string) {
  return [
    `Thank you for buying your phone from The Alternative Bank.`,
    "",
    `Receipt number: ${app.receipt_number}`,
    `Date: ${lagosDate(app.completed_at ?? new Date())}`,
    `Phone: ${app.model_name}`,
    `IMEI: ${app.imei}`,
    `Amount paid: ${formatNaira(app.price_kobo)} (outright purchase)`,
    `Payment reference: ${paymentReference}`,
    `Sale reference: ${app.ref}`,
  ];
}

// ------------------------------------------------------------------ mandates

export async function startDirectDebit(ctx: Ctx, id: string) {
  const gw = paymentGateway();
  const app = await denyOnError(ctx, id, "MANDATE_START", () =>
    withTx(async (tx) => {
      const a = await lockApp(tx, id);
      await requireOriginator(tx, ctx, a);
      expectStatus(a, ["IN_PREPARATION", "RETURNED_FOR_CORRECTION"], "Setting up the Direct Debit");
      if (a.dd_status === "ACTIVE") throw conflict("The Direct Debit mandate is already active.");
      if (!gw || !gw.directDebit) throw gate("Paystack Direct Debit is not enabled. It must be confirmed with Paystack and enabled by an administrator before mandates can be set up.");
      return a;
    }),
  );
  let r: { redirectUrl: string; reference: string };
  try {
    r = await gw!.initDirectDebit({ email: app.customer_email, callbackUrl: `${config.appUrl}/altphones/applications/${id}`, metadata: { application_ref: app.ref } });
  } catch (e) {
    throw gate(e instanceof IntegrationUnavailable ? `${e.message} Try again in a moment.` : "Paystack could not start the mandate. Try again.");
  }
  return withTx(async (tx) => {
    let a = await lockApp(tx, id);
    a = await transition(tx, ctx, a, { action: "MANDATE_INITIATED", role: a.originator_role, set: { dd_status: "PENDING", dd_reference: r.reference, dd_redirect_url: r.redirectUrl, dd_initiated_at: ctx.now }, details: { reference: r.reference } });
    return { redirectUrl: r.redirectUrl, lockVersion: a.lock_version };
  });
}

async function applyMandateCheck(ctx: Ctx, id: string, fromWebhook: boolean) {
  const gw = paymentGateway();
  if (!gw) throw gate("Paystack is not configured.");
  const app = await db.query<AltApp>("SELECT * FROM altphones_applications WHERE id = $1", [id]).then((r) => r.rows[0]);
  if (!app?.dd_reference) throw gate("No Direct Debit mandate has been started.");
  if (app.dd_status === "ACTIVE") return { status: "ACTIVE", message: "The mandate is already active." };
  const v = await gw.verifyDirectDebit(app.dd_reference);
  return withTx(async (tx) => {
    let a = await lockApp(tx, id);
    if (a.dd_status === "ACTIVE") return { status: "ACTIVE", message: "The mandate is already active." };
    if (!v.active) return { status: "PENDING", message: "Paystack has not confirmed the mandate yet. If the customer has authorised it, their bank's confirmation can take some time; check again later." };
    a = await transition(tx, ctx, a, {
      action: "MANDATE_ACTIVE",
      set: { dd_status: "ACTIVE", dd_active_at: ctx.now, dd_authorization_enc: v.authorizationCode ? encryptField(v.authorizationCode) : null, dd_account_last4: v.last4, dd_bank_name: v.bank },
      details: { reference: a.dd_reference, bank: v.bank, last4: v.last4, via: fromWebhook ? "WEBHOOK" : "VERIFY_API" },
    });
    return { status: "ACTIVE", message: "Paystack confirmed the Direct Debit mandate." };
  });
}

export async function checkDirectDebit(ctx: Ctx, id: string) {
  await denyOnError(ctx, id, "MANDATE_CHECK", () =>
    withTx(async (tx) => {
      await requireOriginator(tx, ctx, await lockApp(tx, id));
    }),
  );
  try {
    return await applyMandateCheck(ctx, id, false);
  } catch (e) {
    if (e instanceof IntegrationUnavailable) throw gate(`${e.message} Try again in a moment.`);
    throw e;
  }
}

export const INTERNAL_MANDATE_WORDING =
  "I confirm that the customer's Alternative Bank account debit mandate has been successfully created and authorised for repayment of this Altphones facility.";

export async function confirmInternalMandate(ctx: Ctx, id: string, p: { confirmed: boolean; lockVersion?: number | null }) {
  if (!p.confirmed) throw invalid("Tick the confirmation.", { confirmed: "Confirm the internal debit mandate." });
  return denyOnError(ctx, id, "INTERNAL_MANDATE", () =>
    withTx(async (tx) => {
      let app = await lockApp(tx, id);
      await requireOriginator(tx, ctx, app);
      expectStatus(app, ["IN_PREPARATION", "RETURNED_FOR_CORRECTION"], "Confirming the internal mandate");
      checkLock(app, p.lockVersion);
      app = await transition(tx, ctx, app, {
        action: "INTERNAL_MANDATE_CONFIRMED",
        role: app.originator_role,
        set: { internal_mandate_confirmed_by: ctx.actor!.staffId, internal_mandate_confirmed_at: ctx.now },
        details: { status: "OFFICER_CONFIRMED", wording: INTERNAL_MANDATE_WORDING },
      });
      return { lockVersion: app.lock_version };
    }),
  );
}

// ------------------------------------------------------------------ schedule

export async function holidaySet(q: Db): Promise<string[]> {
  return (await q.query<{ d: string }>("SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d FROM altphones_holidays")).rows.map((r) => r.d);
}

export async function buildSchedule(q: Db, app: AltApp, startDate: string) {
  const s = await settingsById(q, app.settings_id);
  if (!s.weekend_rule || !s.short_month_rule) throw gate("Repayment-date rules are not configured.");
  const dates = repaymentDates({ startDate, months: app.tenure_months, repaymentDay: app.repayment_day, shortMonthRule: s.short_month_rule, weekendRule: s.weekend_rule, holidays: await holidaySet(q) });
  const amounts = instalmentAmounts({ tenureMonths: app.tenure_months, instalmentKobo: Number(app.instalment_kobo), finalInstalmentKobo: Number(app.final_instalment_kobo) });
  return dates.map((d, i) => ({ seq: i + 1, dueDate: d, amountKobo: amounts[i] }));
}

export async function writeSchedule(tx: Tx, app: AltApp, rows: { seq: number; dueDate: string; amountKobo: number }[], basis: "PROVISIONAL" | "FINAL", now: Date) {
  await tx.query("DELETE FROM altphones_schedule WHERE application_id = $1", [app.id]);
  for (const r of rows) {
    await tx.query("INSERT INTO altphones_schedule (application_id, seq, due_date, amount_kobo, basis, generated_at) VALUES ($1,$2,$3,$4,$5,$6)", [app.id, r.seq, r.dueDate, r.amountKobo, basis, now]);
  }
}

// ------------------------------------------------------------------ contract and OTP


const otpHash = (challengeId: string, code: string) => hmac(`altphones-otp:${challengeId}:${code}`);

/** Generate the contract from the approved wording and send a one-time code to the customer's email. */
export async function sendContractOtp(ctx: Ctx, id: string, p: { lockVersion?: number | null }) {
  const code = randomOtp();
  const out = await denyOnError(ctx, id, "CONTRACT_OTP", () =>
    withTx(async (tx) => {
      let app = await lockApp(tx, id);
      await requireOriginator(tx, ctx, app);
      expectStatus(app, ["IN_PREPARATION", "RETURNED_FOR_CORRECTION"], "Sending the contract");
      checkLock(app, p.lockVersion);
      if (app.reservation_status !== "RESERVED") throw gate("A phone must be reserved before the contract is accepted.");
      if (app.dd_status !== "ACTIVE") throw gate("The Paystack Direct Debit mandate must be active first.");
      if (!app.internal_mandate_confirmed_at) throw gate("Confirm the Alternative Bank internal debit mandate first.");
      const recent = Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM altphones_otp_challenges WHERE application_id = $1 AND created_at > $2", [app.id, new Date(ctx.now.getTime() - 3600_000)])).rows[0].n);
      if (recent >= 5) throw gate("Too many codes sent in the last hour. Wait before sending another.");
      const current = await currentSettings(tx);
      const tpl = current.contract_template?.trim();
      if (!tpl) throw gate("The approved contract wording is not loaded. The Altphones Product Manager must load it.");
      const sched = await buildSchedule(tx, app, lagosDate(ctx.now));
      await writeSchedule(tx, app, sched, "PROVISIONAL", ctx.now);
      const values: Record<ContractPlaceholder, string> = {
        ref: app.ref,
        date: lagosDate(ctx.now),
        customer_name: app.customer_name,
        customer_email: app.customer_email,
        customer_phone: app.customer_phone,
        phone_model: app.model_name,
        price: formatNaira(app.price_kobo),
        down_payment: formatNaira(app.down_payment_kobo),
        financed_amount: formatNaira(app.financed_kobo),
        tenure_months: String(app.tenure_months),
        markup_rate: formatRateE4(app.markup_rate_e4),
        markup_amount: formatNaira(app.markup_kobo),
        total_repayment: formatNaira(app.total_repayment_kobo),
        monthly_instalment: formatNaira(app.instalment_kobo),
        final_instalment: formatNaira(app.final_instalment_kobo),
        repayment_day: String(app.repayment_day),
        first_repayment_date: sched[0]?.dueDate ?? "",
        final_repayment_date: sched[sched.length - 1]?.dueDate ?? "",
        ab_account: app.ab_account_number,
        external_account: app.external_account_number,
        external_bank: app.external_bank_name,
        dd_reference: app.dd_reference ?? "",
        schedule: sched.map((r) => `${r.seq}. ${r.dueDate}  ${formatNaira(r.amountKobo)}`).join("\n"),
        support_email: current.team_email,
      };
      const body = renderContract(tpl, values);
      const version = Number((await tx.query<{ n: string }>("SELECT coalesce(max(version), 0) AS n FROM altphones_contracts WHERE application_id = $1", [app.id])).rows[0].n) + 1;
      const terms = { price: app.price_kobo, downPayment: app.down_payment_kobo, financed: app.financed_kobo, tenure: app.tenure_months, rateE4: app.markup_rate_e4, basis: app.markup_basis, markup: app.markup_kobo, total: app.total_repayment_kobo, instalment: app.instalment_kobo, finalInstalment: app.final_instalment_kobo, schedule: sched };
      const contract = (
        await tx.query<{ id: string }>("INSERT INTO altphones_contracts (application_id, version, settings_id, body, sha256, terms, generated_by, generated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id", [
          app.id,
          version,
          current.id,
          body,
          sha256Hex(body),
          JSON.stringify(terms),
          ctx.actor!.staffId,
          ctx.now,
        ])
      ).rows[0];
      await tx.query("UPDATE altphones_otp_challenges SET consumed_at = $2 WHERE application_id = $1 AND consumed_at IS NULL", [app.id, ctx.now]);
      const ch = (
        await tx.query<{ id: string }>("INSERT INTO altphones_otp_challenges (application_id, contract_id, code_hash, sent_to, expires_at, max_attempts, created_by, created_at) VALUES ($1,$2,'pending',$3,$4,$5,$6,$7) RETURNING id", [
          app.id,
          contract.id,
          app.customer_email,
          new Date(ctx.now.getTime() + config.altphonesOtpTtlSeconds * 1000),
          config.altphonesOtpMaxAttempts,
          ctx.actor!.staffId,
          ctx.now,
        ])
      ).rows[0];
      await tx.query("UPDATE altphones_otp_challenges SET code_hash = $2 WHERE id = $1", [ch.id, otpHash(ch.id, code)]);
      app = await transition(tx, ctx, app, { action: "CONTRACT_SENT", role: app.originator_role, set: { contract_id: contract.id, contract_accepted_at: null }, details: { contractVersion: version, sha256: sha256Hex(body), challengeId: ch.id } });
      return { app, body, challengeId: ch.id };
    }),
  );
  try {
    await mailTransport().send({
      to: [out.app.customer_email],
      cc: [],
      subject: `Your Altphones contract code — ${out.app.ref}`,
      text: simpleEmail([
        `Dear ${out.app.customer_name},`,
        "",
        `Your one-time code to accept your Altphones financing contract is: ${code}`,
        `It expires in ${Math.round(config.altphonesOtpTtlSeconds / 60)} minutes. Give it to the officer only if you agree to the contract below.`,
        "",
        out.body,
      ]),
      attachments: [],
    });
    await auditOutsideTx(ctx, { action: "ALTPHONES_OTP_SENT", altphonesApplicationId: out.app.id, details: { challengeId: out.challengeId } });
  } catch (err) {
    await auditOutsideTx(ctx, { action: "ALTPHONES_OTP_FAILED", outcome: "FAILURE", altphonesApplicationId: out.app.id, details: { error: String(err).slice(0, 200) } });
    throw gate("The code could not be emailed to the customer. Check the email address and try again.");
  }
  return { lockVersion: out.app.lock_version };
}

export async function acceptContract(ctx: Ctx, id: string, p: { code: string }) {
  const code = (p.code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) throw invalid("Enter the 6-digit code.", { code: "The code has 6 digits." });
  const res = await denyOnError(ctx, id, "CONTRACT_ACCEPT", () =>
    withTx(async (tx) => {
      let app = await lockApp(tx, id);
      await requireOriginator(tx, ctx, app);
      expectStatus(app, ["IN_PREPARATION", "RETURNED_FOR_CORRECTION"], "Accepting the contract");
      const ch = (await tx.query("SELECT * FROM altphones_otp_challenges WHERE application_id = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [app.id])).rows[0];
      if (!ch || ch.contract_id !== app.contract_id) return { ok: false as const, message: "No active code. Send a new code to the customer." };
      if (ch.expires_at.getTime() <= ctx.now.getTime()) return { ok: false as const, message: "The code has expired. Send a new code." };
      if (ch.attempts >= ch.max_attempts) return { ok: false as const, message: "Too many wrong attempts. Send a new code." };
      if (!safeEqualHex(ch.code_hash, otpHash(ch.id, code))) {
        await tx.query("UPDATE altphones_otp_challenges SET attempts = attempts + 1, consumed_at = CASE WHEN attempts + 1 >= max_attempts THEN $2::timestamptz ELSE NULL END WHERE id = $1", [ch.id, ctx.now]);
        await recordEvent(tx, ctx, app, { action: "CONTRACT_OTP_WRONG", role: app.originator_role, details: { attempts: ch.attempts + 1 } });
        const left = ch.max_attempts - ch.attempts - 1;
        return { ok: false as const, message: left > 0 ? `That code is not correct. ${left} attempt${left === 1 ? "" : "s"} left.` : "Too many wrong attempts. Send a new code." };
      }
      await tx.query("UPDATE altphones_otp_challenges SET consumed_at = $2 WHERE id = $1", [ch.id, ctx.now]);
      const contract = (await tx.query("SELECT id, version, sha256 FROM altphones_contracts WHERE id = $1", [app.contract_id])).rows[0];
      await tx.query("INSERT INTO altphones_contract_acceptances (contract_id, application_id, challenge_id, contract_sha256, accepted_at, witnessed_by) VALUES ($1,$2,$3,$4,$5,$6)", [
        contract.id,
        app.id,
        ch.id,
        contract.sha256,
        ctx.now,
        ctx.actor!.staffId,
      ]);
      app = await transition(tx, ctx, app, { action: "CONTRACT_ACCEPTED", role: app.originator_role, set: { contract_accepted_at: ctx.now }, details: { contractVersion: contract.version, sha256: contract.sha256 } });
      const s = await settingsById(tx, app.settings_id);
      await emailCustomer(tx, ctx, app, `CONTRACT_ACCEPTED_${contract.version}`, "You accepted your Altphones financing contract", [
        `You accepted contract version ${contract.version} for ${app.ref} on ${lagosDate(ctx.now)}.`,
        `Phone: ${app.model_name}. Down payment received: ${formatNaira(app.down_payment_kobo)}.`,
        `Repayment: ${app.tenure_months} months, ${formatNaira(app.instalment_kobo)} per month (total ${formatNaira(app.total_repayment_kobo)}).`,
        "Your application now goes for approval. The officer will contact you when your phone is ready.",
      ], s.team_email);
      return { ok: true as const, lockVersion: app.lock_version };
    }),
  );
  if (!res.ok) throw invalid(res.message, { code: res.message });
  return res;
}

// ------------------------------------------------------------------ submission and cancellation

export function submissionBlockers(app: AltApp): string[] {
  const b: string[] = [];
  if (app.kind !== "CREDIT") return ["Outright sales are not submitted for approval."];
  if (!(app.seedfi_outcome === "PASS" || app.seedfi_outcome === "FAIR")) b.push("The credit assessment has not passed.");
  if (app.reservation_status !== "RESERVED") b.push("No phone is reserved.");
  if (app.dd_status !== "ACTIVE") b.push("The Paystack Direct Debit mandate is not active.");
  if (!app.internal_mandate_confirmed_at) b.push("The Alternative Bank internal mandate is not confirmed.");
  if (!app.contract_accepted_at) b.push("The customer has not accepted the contract by OTP.");
  return b;
}

export async function submitForApproval(ctx: Ctx, id: string, p: { comments?: string; lockVersion?: number | null }) {
  return denyOnError(ctx, id, "SUBMIT", () =>
    withTx(async (tx) => {
      let app = await lockApp(tx, id);
      await requireOriginator(tx, ctx, app);
      expectStatus(app, ["IN_PREPARATION", "RETURNED_FOR_CORRECTION"], "Submitting");
      checkLock(app, p.lockVersion);
      const paid = (await tx.query("SELECT 1 FROM altphones_payments WHERE application_id = $1 AND purpose = 'DOWN_PAYMENT' AND status = 'SUCCESS'", [app.id])).rowCount;
      const blockers = submissionBlockers(app);
      if (!paid) blockers.unshift("The down payment is not verified.");
      if (blockers.length) throw gate(blockers.join(" "));
      if (app.channel === "DO") {
        const uh = await routeUnitHead(tx, app);
        if (uh.problem && !uh.id) throw gate(`Submission is blocked: ${uh.problem}`);
      }
      const to: AltStatus = app.channel === "SA" ? "UNDER_BPM_REVIEW" : "UNDER_PM_REVIEW";
      app = await transition(tx, ctx, app, {
        action: app.submission_count > 0 ? "RESUBMITTED" : "SUBMITTED",
        to,
        role: app.originator_role,
        comments: p.comments?.trim() || null,
        set: { submission_count: app.submission_count + 1, submitted_at: ctx.now, bpm_reviewer_id: null, pm_reviewer_id: null, unit_head_id: null },
      });
      if (to === "UNDER_BPM_REVIEW") await notifyRole(tx, ctx, app, "BPM_QUEUE", [BPM_ROLE], "Altphones application awaiting your review", [`${app.ref} (Smile Associate sale) is waiting for Business Performance Manager review.`], [app.originator_id]);
      else await notifyRole(tx, ctx, app, "PM_QUEUE", [PM_ROLE], "Altphones application awaiting product review", [`${app.ref} is waiting for Product Manager review.`], [app.originator_id]);
      return { lockVersion: app.lock_version };
    }),
  );
}

export async function cancelApplication(ctx: Ctx, id: string, p: { reason: string; lockVersion?: number | null }) {
  const reason = (p.reason ?? "").trim();
  if (reason.length < 3) throw invalid("Give the reason for cancelling.", { reason: "Enter a reason." });
  return denyOnError(ctx, id, "CANCEL", () =>
    withTx(async (tx) => {
      let app = await lockApp(tx, id);
      await requireOriginator(tx, ctx, app);
      expectStatus(app, ["DRAFT", "AWAITING_PAYMENT", "AWAITING_DOWN_PAYMENT", "PAID", "IN_PREPARATION", "RETURNED_FOR_CORRECTION"], "Cancelling");
      checkLock(app, p.lockVersion);
      await releaseUnit(tx, ctx, app, `Cancelled: ${reason}`);
      await tx.query("UPDATE altphones_payments SET status = 'ABANDONED' WHERE application_id = $1 AND status = 'INITIATED'", [app.id]);
      const paid = (await tx.query("SELECT 1 FROM altphones_payments WHERE application_id = $1 AND status = 'SUCCESS'", [app.id])).rowCount;
      app = await transition(tx, ctx, app, {
        action: "CANCELLED",
        to: "CANCELLED",
        role: app.originator_role,
        comments: reason,
        set: { reservation_status: app.reservation_status === "RESERVED" ? "RELEASED" : app.reservation_status, device_id: null, closed_reason: reason, refund_status: paid ? "REQUIRED" : null },
      });
      if (paid) await alertOperations(tx, ctx, app, "REFUND_REQUIRED", "Refund required", [`${app.ref} was cancelled after payment. Process the refund under the approved refund process and record it in the platform.`]);
      return { lockVersion: app.lock_version };
    }),
  );
}

/** Super Admin records that a refund was made under the bank's refund process (no automated refund). */
export async function recordRefund(ctx: Ctx, id: string, p: { reference: string }) {
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, ctx.actor!.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can record a refund.");
    let app = await lockApp(tx, id);
    if (app.refund_status !== "REQUIRED") throw conflict("No refund is outstanding on this application.");
    const ref = (p.reference ?? "").trim();
    if (ref.length < 3) throw invalid("Enter the refund transaction reference.", { reference: "Enter the reference." });
    app = await transition(tx, ctx, app, { action: "REFUND_RECORDED", role: "SUPER_ADMIN", set: { refund_status: "RECORDED", refund_reference: ref }, details: { reference: ref } });
    return { lockVersion: app.lock_version };
  });
}

/** BVN for the authorised view only (never logged). */
export function revealBvnLast4(app: AltApp) {
  return app.bvn_last4 ? `•••••••${app.bvn_last4}` : "—";
}
export function decryptBvnForProvider(app: AltApp) {
  return app.bvn_enc ? decryptField(app.bvn_enc) : null;
}
