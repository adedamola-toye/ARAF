/**
 * Periculum Insights API client (server-side only), built strictly from insights-periculum.readme.io:
 *
 *   Token        POST {authUrl}  (OAuth 2.0 client credentials; client_id and client_secret in the form body, as documented)
 *   Submit PDF   PUT  /statements                          multipart: file, password, statementType
 *   Analytics    GET  /statements/{statementKey}           processingStatus + analytics
 *   Transactions GET  /statements/{statementKey}/transactions
 *
 * Every call is recorded in fi_api_calls (operation, status, outcome, duration — never statement content or
 * credentials). Outcomes are classified so the caller never retries blindly:
 *   SUCCESS · REJECTED (vendor refused, with its message) · RATE_LIMITED · TIMEOUT · FAILED ·
 *   AMBIGUOUS (a submission whose outcome is unknown: it may have been accepted, so it is reconciled, not resent).
 *
 * The network layer can be replaced (`setPericulumFetchForTests`, or PERICULUM_MODE=fixture for labelled test
 * data); the rest of the code path is identical. Results obtained that way are stored as source FIXTURE.
 */
import { z } from "zod";
import { db } from "../../db";
import { config } from "../../config";
import { fixtureFetch } from "./fixtures";
import { forgetPericulumConnection, normaliseBaseUrl, periculumConnection, type PericulumConnection } from "./settings";

export type PericulumSource = "PERICULUM" | "FIXTURE";
export type CallOutcome = "SUCCESS" | "REJECTED" | "RATE_LIMITED" | "TIMEOUT" | "FAILED" | "AMBIGUOUS";
export type CallResult<T> = { ok: true; data: T; status: number } | { ok: false; outcome: Exclude<CallOutcome, "SUCCESS">; status: number | null; message: string; category: string };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
let testFetch: FetchLike | null = null;
/** Tests: replace the network (a programmable fake). The source is then FIXTURE. */
export function setPericulumFetchForTests(f: FetchLike | null) {
  testFetch = f;
  token = null;
  forgetPericulumConnection();
}

export function periculumSource(): PericulumSource {
  return testFetch || config.periculum.mode === "fixture" ? "FIXTURE" : "PERICULUM";
}

function transport(): FetchLike {
  if (testFetch) return testFetch;
  if (config.periculum.mode === "fixture") {
    if (process.env.NODE_ENV === "production") throw new Error("PERICULUM_MODE=fixture is not allowed in production.");
    return fixtureFetch;
  }
  return (url, init) => fetch(url, init);
}

/**
 * The connection to use: settings saved by a Super Admin (Administration → Periculum), else environment variables.
 * Test data mode and tests use a placeholder connection with the documented addresses.
 */
async function connection(): Promise<PericulumConnection | null> {
  const saved = await periculumConnection();
  if (saved) return saved;
  if (testFetch || config.periculum.mode === "fixture") {
    const c = config.periculum;
    return { clientId: "fixture-client", clientSecret: "fixture-secret", baseUrl: normaliseBaseUrl(c.baseUrl), authUrl: c.authUrl, origin: "ENVIRONMENT", fingerprint: "fixture" };
  }
  return null;
}

/** Whether Automatic Statement Analysis can run at all (and why not). */
export async function periculumReadiness(): Promise<{ ready: boolean; problem: string | null }> {
  const c = config.periculum;
  if (!c.enabled) return { ready: false, problem: "Automatic Statement Analysis is not enabled. Periculum is switched off until credentials, testing and the bank's approvals are in place." };
  if (c.mode === "fixture" && process.env.NODE_ENV === "production") return { ready: false, problem: "Test data mode is not allowed in production." };
  if (!(await connection())) return { ready: false, problem: "Periculum credentials are not configured. A Super Admin enters them in Administration → Periculum." };
  return { ready: true, problem: null };
}

// ------------------------------------------------------------------ schemas (documented fields only; extra fields kept)

const statementSchema = z
  .object({
    key: z.number().int(),
    processingStatus: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
  })
  .passthrough();
export type VendorStatement = z.infer<typeof statementSchema>;

const transactionSchema = z
  .object({
    date: z.string(),
    amount: z.number(),
    type: z.string(),
    description: z.string().nullable().optional(),
    balance: z.number().nullable().optional(),
  })
  .passthrough();
export type VendorTransaction = z.infer<typeof transactionSchema>;
const transactionsSchema = z.array(transactionSchema);

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive(), token_type: z.string() }).passthrough();

// ------------------------------------------------------------------ token

let token: { value: string; expiresAt: number; fingerprint: string } | null = null;
/** Refresh this long before expiry (Periculum recommends obtaining a new token some minutes before). */
const REFRESH_MARGIN_MS = 5 * 60_000;

async function accessToken(ctxIds: Ids, force = false): Promise<CallResult<string>> {
  const now = Date.now();
  const c = await connection();
  if (!c) return { ok: false, outcome: "FAILED", status: null, message: "Periculum credentials are not configured.", category: "NOT_CONFIGURED" };
  // A cached token is reused only while the same credentials are in force.
  if (!force && token && token.fingerprint === c.fingerprint && token.expiresAt - REFRESH_MARGIN_MS > now) return { ok: true, data: token.value, status: 200 };
  // Exactly as documented (Authentication Request): client_id, client_secret and grant_type in the form body.
  // (Not HTTP Basic: secrets containing characters such as "+" or "%" can be decoded differently in a header.)
  const r = await send(
    ctxIds,
    "TOKEN",
    c.authUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: "client_credentials" }).toString(),
    },
    false,
  );
  if (!r.ok) return r;
  const parsed = tokenSchema.safeParse(r.data);
  if (!parsed.success) return invalidResponse(ctxIds, "TOKEN");
  token = { value: parsed.data.access_token, expiresAt: now + parsed.data.expires_in * 1000, fingerprint: c.fingerprint };
  return { ok: true, data: token.value, status: r.status };
}

// ------------------------------------------------------------------ transport with classification and usage log

interface Ids {
  analysisId?: string | null;
  statementId?: string | null;
}

async function logCall(ids: Ids, operation: string, status: number | null, outcome: CallOutcome, started: number, category: string | null, billable: boolean) {
  await db
    .query(
      `INSERT INTO fi_api_calls (analysis_id, statement_id, operation, http_status, outcome, billable, source, duration_ms, error_category, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
      [ids.analysisId ?? null, ids.statementId ?? null, operation, status, outcome, billable, periculumSource(), Date.now() - started, category],
    )
    .catch((e) => console.error("[periculum] could not record usage", (e as Error).message));
}

async function invalidResponse(ids: Ids, operation: string): Promise<CallResult<never>> {
  await logCall(ids, `${operation}_VALIDATION`, null, "FAILED", Date.now(), "INVALID_RESPONSE", false);
  return { ok: false, outcome: "FAILED", status: null, message: "Periculum returned a response ARAF could not validate.", category: "INVALID_RESPONSE" };
}

/**
 * One HTTP exchange. `submission` marks the billable PUT: a timeout, a dropped connection or a 5xx there is
 * AMBIGUOUS (the statement may have been accepted and charged), never a plain failure.
 */
async function send(ids: Ids, operation: string, url: string, init: RequestInit, submission: boolean): Promise<CallResult<unknown>> {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.periculum.timeoutMs);
  let res: Response;
  try {
    res = await transport()(url, { ...init, signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    const timedOut = (e as Error).name === "AbortError";
    const outcome: CallOutcome = submission ? "AMBIGUOUS" : timedOut ? "TIMEOUT" : "FAILED";
    const category = timedOut ? "TIMEOUT" : "NETWORK";
    await logCall(ids, operation, null, outcome, started, category, submission);
    return { ok: false, outcome: outcome as Exclude<CallOutcome, "SUCCESS">, status: null, message: timedOut ? "Periculum did not respond in time." : "Periculum could not be reached.", category };
  }
  clearTimeout(timer);
  let body: unknown = null;
  const text = await res.text().catch(() => "");
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (res.ok) {
    await logCall(ids, operation, res.status, "SUCCESS", started, null, submission);
    return { ok: true, data: body, status: res.status };
  }
  const message = vendorMessage(body) ?? `Periculum returned HTTP ${res.status}.`;
  if (res.status === 429) {
    await logCall(ids, operation, 429, "RATE_LIMITED", started, "RATE_LIMITED", false);
    return { ok: false, outcome: "RATE_LIMITED", status: 429, message: "Periculum's rate limit was reached; ARAF will try again shortly.", category: "RATE_LIMITED" };
  }
  if (res.status >= 500) {
    const outcome = submission ? "AMBIGUOUS" : "FAILED";
    await logCall(ids, operation, res.status, outcome, started, "VENDOR_ERROR", submission);
    return { ok: false, outcome, status: res.status, message, category: "VENDOR_ERROR" };
  }
  const category = res.status === 401 ? "UNAUTHORISED" : classifyRejection(message);
  await logCall(ids, operation, res.status, "REJECTED", started, category, false);
  return { ok: false, outcome: "REJECTED", status: res.status, message, category };
}

function vendorMessage(body: unknown): string | null {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const k of ["message", "error_description", "error", "title"]) if (typeof b[k] === "string" && b[k]) return String(b[k]).slice(0, 300);
  }
  return null;
}

/** Map Periculum's documented error messages to categories ARAF acts on. */
export function classifyRejection(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("password")) return "PASSWORD_REQUIRED";
  if (m.includes("insufficient balance")) return "VENDOR_CREDIT_EXHAUSTED";
  if (m.includes("same name has already been analyzed")) return "ALREADY_SUBMITTED";
  if (m.includes("page count") || m.includes("file size")) return "FILE_LIMIT";
  if (m.includes("upload a pdf") || m.includes("upload a file")) return "UNSUPPORTED_FILE";
  if (m.includes("not allowed")) return "UPLOAD_NOT_ALLOWED";
  return "REJECTED";
}

/** Authenticated API call; a 401 refreshes the token once (it may have expired early). */
async function api(ids: Ids, operation: string, path: string, init: RequestInit, submission = false): Promise<CallResult<unknown>> {
  const t = await accessToken(ids);
  if (!t.ok) return t;
  const url = `${(await connection())!.baseUrl}${path}`;
  const withAuth = (tok: string): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${tok}` } });
  let r = await send(ids, operation, url, withAuth(t.data), submission);
  if (!r.ok && r.status === 401) {
    const t2 = await accessToken(ids, true);
    if (!t2.ok) return t2;
    r = await send(ids, operation, url, withAuth(t2.data), submission);
  }
  return r;
}

// ------------------------------------------------------------------ documented operations

export async function submitStatement(ids: Ids, p: { data: Buffer; submissionName: string; password: string | null; statementType: "CONSUMER" | "BUSINESS" }): Promise<CallResult<VendorStatement>> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(p.data)], { type: "application/pdf" }), p.submissionName);
  form.append("password", p.password ?? "");
  form.append("statementType", p.statementType);
  const r = await api(ids, "SUBMIT", "/statements", { method: "PUT", body: form }, true);
  if (!r.ok) return r;
  const parsed = statementSchema.safeParse(r.data);
  return parsed.success ? { ok: true, data: parsed.data, status: r.status } : invalidResponse(ids, "SUBMIT");
}

export async function getStatement(ids: Ids, key: number): Promise<CallResult<VendorStatement>> {
  const r = await api(ids, "GET_STATEMENT", `/statements/${encodeURIComponent(String(key))}`, { method: "GET" });
  if (!r.ok) return r;
  const parsed = statementSchema.safeParse(r.data);
  return parsed.success ? { ok: true, data: parsed.data, status: r.status } : invalidResponse(ids, "GET_STATEMENT");
}

export async function getTransactions(ids: Ids, key: number): Promise<CallResult<VendorTransaction[]>> {
  const r = await api(ids, "GET_TRANSACTIONS", `/statements/${encodeURIComponent(String(key))}/transactions`, { method: "GET" });
  if (!r.ok) return r;
  const parsed = transactionsSchema.safeParse(r.data);
  return parsed.success ? { ok: true, data: parsed.data, status: r.status } : invalidResponse(ids, "GET_TRANSACTIONS");
}

/** Sign-in check only (no statement is sent, nothing is billed). */
export async function checkPericulumSignIn(): Promise<CallResult<{ expiresInSeconds: number }>> {
  const r = await accessToken({}, true);
  if (!r.ok) return r;
  return { ok: true, data: { expiresInSeconds: Math.round(((token?.expiresAt ?? Date.now()) - Date.now()) / 1000) }, status: r.status };
}

// ------------------------------------------------------------------ optional: Blacklist Search

const blacklistSchema = z.object({ statementKey: z.number().int().nullable().optional() }).passthrough();
export type VendorBlacklist = z.infer<typeof blacklistSchema>;

/**
 * POST /statements/blacklistsearch {statementKey, bvn} (documented). A search may be billable: a timeout or 5xx is
 * AMBIGUOUS and is not resent automatically.
 */
export async function blacklistSearch(ids: Ids, p: { statementKey: number; bvn: string }): Promise<CallResult<VendorBlacklist>> {
  const r = await api(
    ids,
    "BLACKLIST_SEARCH",
    "/statements/blacklistsearch",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ statementKey: p.statementKey, bvn: p.bvn }) },
    true,
  );
  if (!r.ok) return r;
  const parsed = blacklistSchema.safeParse(r.data);
  return parsed.success ? { ok: true, data: parsed.data, status: r.status } : invalidResponse(ids, "BLACKLIST_SEARCH");
}

/** Plain-language explanation of a sign-in test result (for the Super Admin screen). */
export function explainSignIn(r: CallResult<{ expiresInSeconds: number }>): { ok: boolean; message: string } {
  if (r.ok) return { ok: true, message: `Signed in. Periculum issued an access token valid for about ${Math.round(r.data.expiresInSeconds / 3600)} hour(s). No statement was sent.` };
  const m = r.message.toLowerCase();
  if (m.includes("invalid client secret"))
    return { ok: false, message: "Periculum recognised the Client ID but not the Secret Key. Copy the API Secret Key again from the Insights portal (Settings → API Credentials) and save it." };
  if (m.includes("invalid client credentials") || m.includes("invalid_client"))
    return { ok: false, message: "Periculum did not recognise the Client ID at this token URL. Check the API Client ID, or ask Periculum which token URL your credentials belong to." };
  if (r.category === "NOT_CONFIGURED") return { ok: false, message: "No credentials are saved yet." };
  return { ok: false, message: `Sign-in failed: ${r.message}` };
}
