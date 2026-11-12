/**
 * External integrations for Altphones, behind small interfaces so the workflow never depends on a
 * provider's response shape and tests can substitute providers. Nothing here ever reports success
 * that the provider did not return: an unconfigured provider is `null`, a failed call throws
 * IntegrationUnavailable, and an unexpected response is treated as unavailable.
 *
 * Paystack endpoints used (https://paystack.com/docs/api):
 *   POST /transaction/initialize            — checkout for the payment (bank transfer channel)
 *   GET  /transaction/verify/:reference     — server-side verification
 *   POST /customer/authorization/initialize — Direct Debit mandate authorisation (channel direct_debit)
 *   GET  /customer/authorization/verify/:reference
 *   Webhooks: x-paystack-signature = HMAC-SHA512(raw body, secret key); every webhook is re-verified
 *   through the API before it changes anything.
 * SeedFi: Seed Score per the SeedFi API documentation v2.0 (see below).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config";

export class IntegrationUnavailable extends Error {
  constructor(
    public provider: string,
    message: string,
  ) {
    super(message);
  }
}

async function call(provider: string, url: string, init: RequestInit & { timeoutMs: number }): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new IntegrationUnavailable(provider, `${provider} returned a response that is not JSON (HTTP ${res.status}).`);
    }
    if (!res.ok) {
      const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const raw = typeof o.detail === "string" ? o.detail : typeof o.message === "string" ? o.message : null;
      const msg = raw ? `${raw.slice(0, 200)} (HTTP ${res.status})` : `HTTP ${res.status}`;
      throw new IntegrationUnavailable(provider, `${provider} refused the request: ${msg}`);
    }
    return body;
  } catch (e) {
    if (e instanceof IntegrationUnavailable) throw e;
    if ((e as Error).name === "AbortError") throw new IntegrationUnavailable(provider, `${provider} did not respond in time.`);
    throw new IntegrationUnavailable(provider, `${provider} could not be reached.`);
  } finally {
    clearTimeout(t);
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

// ------------------------------------------------------------------ SeedFi (Seed Score)

/**
 * SeedFi Loan Engine — Seed Score (API documentation v2.0, April 2026):
 *   POST {base}/scoring/api/v1/seed-score/calculate, header X-API-Key
 *   body: customer_id, first_name, last_name, bvn, date_of_birth (YYYY-MM-DD), phone_number, gender ("male"/"female"),
 *         optional monthly_income, loan_duration_in_month, include_narration
 *   response: { credit_score: { overall_seedfi_score, reviewed_seedfi_score, user_has_credit_history, payment_history,
 *              depth_of_credit, open_credit, demographics } } (possibly wrapped as { status, data })
 * The score runs from 280 (highest risk) to 800 (lowest risk). The decision uses the reviewed score, which SeedFi
 * lowers for adverse credit behaviour; the overall score and the components are stored for review.
 */
export interface CreditInput {
  customerId: string;
  firstName: string;
  lastName: string;
  bvn: string;
  dateOfBirth: string;
  phone: string;
  gender: "male" | "female";
  loanDurationMonths?: number | null;
}
export interface CreditResult {
  /** The customer identifier the score was requested under (SeedFi returns no separate reference). */
  reference: string;
  /** Reviewed Seed Score (used for the decision). */
  score: number;
  overallScore: number;
  hasCreditHistory: boolean | null;
  validUntil: string | null;
  /** SeedFi marks staging/test responses with is_dummy_data: true. */
  isDummyData: boolean;
  components: Record<string, unknown>;
}
export interface CreditBureau {
  readonly name: string;
  assess(input: CreditInput): Promise<CreditResult>;
}

export const SEED_SCORE_MIN = 280;
export const SEED_SCORE_MAX = 800;

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN);

/** Validate a Seed Score response; anything unexpected is treated as unavailable, never as a pass. */
export function parseSeedScore(body: unknown, customerId: string): CreditResult {
  const top = obj(body);
  const data = obj(top.data ?? top);
  const cs = obj(data.credit_score ?? data);
  const overall = num(cs.overall_seedfi_score);
  const reviewed = Number.isFinite(num(cs.reviewed_seedfi_score)) ? num(cs.reviewed_seedfi_score) : overall;
  const inRange = (n: number) => Number.isFinite(n) && n >= SEED_SCORE_MIN && n <= SEED_SCORE_MAX;
  if (!inRange(overall) || !inRange(reviewed)) throw new IntegrationUnavailable("SeedFi", "SeedFi returned a response without a valid Seed Score (280–800).");
  const components: Record<string, unknown> = {};
  for (const k of ["payment_history", "depth_of_credit", "open_credit", "demographics"]) if (cs[k] && typeof cs[k] === "object") components[k] = cs[k];
  const validity = cs.validity_date ?? data.validity_date;
  return {
    reference: customerId,
    score: Math.round(reviewed * 100) / 100,
    overallScore: Math.round(overall * 100) / 100,
    hasCreditHistory: typeof cs.user_has_credit_history === "boolean" ? cs.user_has_credit_history : null,
    validUntil: typeof validity === "string" ? validity.slice(0, 10) : null,
    isDummyData: cs.is_dummy_data === true || data.is_dummy_data === true,
    components,
  };
}

/** SeedFi expects a Nigerian number; send the local 11-digit form (0XXXXXXXXXX). */
export function seedfiPhone(e164: string) {
  return e164.replace(/^\+234/, "0");
}

class SeedfiHttp implements CreditBureau {
  readonly name = "SeedFi";
  async assess(input: CreditInput): Promise<CreditResult> {
    const c = config.seedfi;
    const body: Record<string, unknown> = {
      customer_id: input.customerId,
      first_name: input.firstName,
      last_name: input.lastName,
      bvn: input.bvn,
      date_of_birth: input.dateOfBirth,
      phone_number: seedfiPhone(input.phone),
      gender: input.gender,
    };
    if (input.loanDurationMonths) body.loan_duration_in_month = input.loanDurationMonths;
    const res = await call("SeedFi", `${c.baseUrl}${c.assessPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-api-key": c.apiKey },
      body: JSON.stringify(body),
      timeoutMs: c.timeoutMs,
    });
    return parseSeedScore(res, input.customerId);
  }
}

let bureauOverride: CreditBureau | null | undefined;
export function setCreditBureauForTests(b: CreditBureau | null | undefined) {
  bureauOverride = b;
}
/** The configured credit bureau, or null when Seedfi is not configured. */
export function creditBureau(): CreditBureau | null {
  if (bureauOverride !== undefined) return bureauOverride;
  const c = config.seedfi;
  return c.enabled && c.baseUrl && c.apiKey ? new SeedfiHttp() : null;
}

// ------------------------------------------------------------------ Paystack

export interface PaymentVerification {
  status: "success" | "failed" | "abandoned" | "pending";
  amountKobo: number;
  currency: string;
  reference: string;
  transactionId: string | null;
  paidAt: Date | null;
  channel: string | null;
  gatewayResponse: string | null;
}
export interface MandateVerification {
  active: boolean;
  authorizationCode: string | null;
  last4: string | null;
  bank: string | null;
}
export interface PaymentGateway {
  readonly name: string;
  readonly directDebit: boolean;
  initialize(p: { reference: string; amountKobo: number; email: string; callbackUrl: string; metadata: Record<string, string> }): Promise<{ checkoutUrl: string }>;
  verify(reference: string): Promise<PaymentVerification>;
  initDirectDebit(p: { email: string; callbackUrl: string; metadata: Record<string, string> }): Promise<{ redirectUrl: string; reference: string }>;
  verifyDirectDebit(reference: string): Promise<MandateVerification>;
  verifySignature(rawBody: string, signature: string | null): boolean;
}

class PaystackHttp implements PaymentGateway {
  readonly name = "Paystack";
  get directDebit() {
    return config.paystack.directDebitEnabled;
  }
  private req(method: string, path: string, body?: unknown) {
    const c = config.paystack;
    return call("Paystack", `${c.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${c.secretKey}`, "content-type": "application/json", accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: c.timeoutMs,
    });
  }
  async initialize(p: { reference: string; amountKobo: number; email: string; callbackUrl: string; metadata: Record<string, string> }) {
    const d = obj(obj(await this.req("POST", "/transaction/initialize", { email: p.email, amount: p.amountKobo, currency: "NGN", reference: p.reference, channels: ["bank_transfer"], callback_url: p.callbackUrl, metadata: p.metadata })).data);
    if (typeof d.authorization_url !== "string") throw new IntegrationUnavailable("Paystack", "Paystack did not return a checkout link.");
    return { checkoutUrl: d.authorization_url };
  }
  async verify(reference: string): Promise<PaymentVerification> {
    const d = obj(obj(await this.req("GET", `/transaction/verify/${encodeURIComponent(reference)}`)).data);
    const status = String(d.status ?? "");
    const amount = Number(d.amount);
    if (!Number.isInteger(amount) || typeof d.reference !== "string") throw new IntegrationUnavailable("Paystack", "Paystack returned an incomplete verification response.");
    return {
      status: status === "success" ? "success" : status === "failed" || status === "reversed" ? "failed" : status === "abandoned" ? "abandoned" : "pending",
      amountKobo: amount,
      currency: String(d.currency ?? ""),
      reference: d.reference,
      transactionId: d.id !== undefined && d.id !== null ? String(d.id) : null,
      paidAt: typeof d.paid_at === "string" ? new Date(d.paid_at) : null,
      channel: typeof d.channel === "string" ? d.channel : null,
      gatewayResponse: typeof d.gateway_response === "string" ? d.gateway_response.slice(0, 200) : null,
    };
  }
  async initDirectDebit(p: { email: string; callbackUrl: string; metadata: Record<string, string> }) {
    const d = obj(obj(await this.req("POST", "/customer/authorization/initialize", { email: p.email, channel: "direct_debit", callback_url: p.callbackUrl, metadata: p.metadata })).data);
    if (typeof d.redirect_url !== "string" || typeof d.reference !== "string") throw new IntegrationUnavailable("Paystack", "Paystack did not return a mandate authorisation link.");
    return { redirectUrl: d.redirect_url, reference: d.reference };
  }
  async verifyDirectDebit(reference: string): Promise<MandateVerification> {
    const d = obj(obj(await this.req("GET", `/customer/authorization/verify/${encodeURIComponent(reference)}`)).data);
    const code = typeof d.authorization_code === "string" ? d.authorization_code : null;
    return { active: d.active === true && !!code, authorizationCode: code, last4: typeof d.last4 === "string" ? d.last4.slice(-4) : null, bank: typeof d.bank === "string" ? d.bank.slice(0, 80) : null };
  }
  verifySignature(rawBody: string, signature: string | null): boolean {
    if (!signature || !/^[0-9a-f]{128}$/i.test(signature)) return false;
    const expected = createHmac("sha512", config.paystack.secretKey).update(rawBody).digest();
    const got = Buffer.from(signature, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  }
}

let gatewayOverride: PaymentGateway | null | undefined;
export function setPaymentGatewayForTests(g: PaymentGateway | null | undefined) {
  gatewayOverride = g;
}
/** The configured payment gateway, or null when Paystack is not configured. */
export function paymentGateway(): PaymentGateway | null {
  if (gatewayOverride !== undefined) return gatewayOverride;
  const c = config.paystack;
  return c.enabled && c.secretKey ? new PaystackHttp() : null;
}
