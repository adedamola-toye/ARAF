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
 * Seedfi: the endpoint contract is configured (SEEDFI_BASE_URL + SEEDFI_ASSESS_PATH) and must be
 * confirmed with Seedfi; the response must carry a reference and a numeric score.
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
      const msg = body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message).slice(0, 200) : `HTTP ${res.status}`;
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

// ------------------------------------------------------------------ Seedfi

export interface CreditResult {
  reference: string;
  score: number;
}
export interface CreditBureau {
  readonly name: string;
  assess(input: { bvn: string; reference: string }): Promise<CreditResult>;
}

class SeedfiHttp implements CreditBureau {
  readonly name = "Seedfi";
  async assess(input: { bvn: string; reference: string }): Promise<CreditResult> {
    const c = config.seedfi;
    const body = await call("Seedfi", `${c.baseUrl}${c.assessPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({ bvn: input.bvn, reference: input.reference }),
      timeoutMs: c.timeoutMs,
    });
    const top = obj(body);
    const d = obj(top.data ?? top);
    const score = typeof d.score === "number" ? d.score : typeof d.score === "string" && /^-?\d+(\.\d+)?$/.test(d.score) ? Number(d.score) : NaN;
    const ref = d.reference ?? d.id ?? d.assessment_id;
    if (!Number.isFinite(score) || (typeof ref !== "string" && typeof ref !== "number")) throw new IntegrationUnavailable("Seedfi", "Seedfi returned a response without a reference and a numeric score.");
    return { reference: String(ref).slice(0, 120), score: Math.round(score * 100) / 100 };
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
