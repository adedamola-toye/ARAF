/**
 * Periculum connection settings: client ID, client secret, API base URL and token URL.
 *
 * Entered by a Super Admin on Administration → Periculum (stored in integration_credentials, the secret encrypted
 * and write-only). Environment variables (PERICULUM_CLIENT_ID, …) remain a fallback. The website and the worker
 * both read the same saved settings, so nothing has to be copied into the hosting dashboards.
 *
 * Only Periculum addresses are accepted, so credentials can never be sent anywhere else.
 */
import { createHash } from "node:crypto";
import { db, withTx, type Db } from "../../db";
import type { Ctx } from "../../context";
import { config } from "../../config";
import { audit } from "../../audit";
import { decryptField, encryptField } from "../../crypto";
import { forbidden, invalid } from "../../errors";
import { holdsRole } from "../../domain/access";

export interface PericulumConnection {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  authUrl: string;
  /** Where the credentials came from. */
  origin: "SAVED" | "ENVIRONMENT";
  /** Changes whenever the credentials change (the cached access token is dropped). */
  fingerprint: string;
}

const API_HOSTS = /^([a-z0-9-]+\.)*insights-periculum\.io$/;
const AUTH_HOSTS = /^([a-z0-9-]+\.)*auth-periculum\.app$/;

/** "https://api.insights-periculum.io/statements" → "https://api.insights-periculum.io" (ARAF adds /statements itself). */
export function normaliseBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/statements$/i, "");
}

function checkUrl(raw: string, hosts: RegExp, what: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `Enter the full ${what}, starting with https://`;
  }
  if (u.protocol !== "https:") return `The ${what} must start with https://`;
  if (!hosts.test(u.hostname)) return `The ${what} must be a Periculum address (${hosts === API_HOSTS ? "…insights-periculum.io" : "…auth-periculum.app"}).`;
  return null;
}

let cache: { at: number; value: PericulumConnection | null } | null = null;
const CACHE_MS = 30_000;
/** Tests and the settings screen: forget the cached settings. */
export function forgetPericulumConnection() {
  cache = null;
}

/** The connection in force: saved settings first, then environment variables; null when no credentials are set. */
export async function periculumConnection(q: Db = db): Promise<PericulumConnection | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = (
    await q
      .query<{
        client_id: string;
        client_secret_enc: string;
        base_url: string;
        auth_url: string;
        updated_at: Date;
      }>("SELECT client_id, client_secret_enc, base_url, auth_url, updated_at FROM integration_credentials WHERE provider = 'PERICULUM'")
      .catch(() => ({ rows: [] as never[] }))
  ).rows[0];
  const c = config.periculum;
  let value: PericulumConnection | null = null;
  if (row) {
    value = { clientId: row.client_id, clientSecret: decryptField(row.client_secret_enc), baseUrl: row.base_url, authUrl: row.auth_url, origin: "SAVED", fingerprint: "" };
  } else if (c.clientId && c.clientSecret) {
    value = { clientId: c.clientId, clientSecret: c.clientSecret, baseUrl: normaliseBaseUrl(c.baseUrl), authUrl: c.authUrl, origin: "ENVIRONMENT", fingerprint: "" };
  }
  if (value) value.fingerprint = createHash("sha256").update(`${value.clientId}\n${value.clientSecret}\n${value.authUrl}`).digest("hex");
  cache = { at: Date.now(), value };
  return value;
}

export interface SaveInput {
  clientId: string;
  /** Blank keeps the saved secret. */
  clientSecret: string;
  baseUrl: string;
  authUrl: string;
  reason: string;
}

async function requireSuperAdmin(ctx: Ctx) {
  const actor = ctx.actor;
  if (!actor || !(await holdsRole(db, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only a Super Admin can manage the Periculum connection.");
  return actor.staffId;
}

export async function savePericulumCredentials(ctx: Ctx, i: SaveInput) {
  const staffId = await requireSuperAdmin(ctx);
  const errors: Record<string, string> = {};
  const clientId = (i.clientId ?? "").trim();
  const secret = (i.clientSecret ?? "").trim();
  const baseUrl = normaliseBaseUrl(i.baseUrl || config.periculum.baseUrl);
  const authUrl = (i.authUrl || config.periculum.authUrl).trim();
  const reason = (i.reason ?? "").trim();
  if (!clientId || clientId.length > 200 || /\s/.test(clientId)) errors.clientId = "Enter the API Client ID exactly as shown in the Insights portal (no spaces).";
  if (secret && (secret.length > 500 || /\s/.test(secret))) errors.clientSecret = "The client secret cannot contain spaces. Copy it with the portal's Copy button.";
  const b = checkUrl(baseUrl, API_HOSTS, "API base URL");
  if (b) errors.baseUrl = b;
  const a = checkUrl(authUrl, AUTH_HOSTS, "token URL");
  if (a) errors.authUrl = a;
  if (reason.length < 5) errors.reason = "Give a short reason (e.g. live credentials issued by Periculum).";
  const existing = (
    await db.query<{ client_secret_enc: string; client_id: string; base_url: string; auth_url: string }>(
      "SELECT client_secret_enc, client_id, base_url, auth_url FROM integration_credentials WHERE provider = 'PERICULUM'",
    )
  ).rows[0];
  if (!secret && !existing) errors.clientSecret = "Enter the API Secret Key.";
  if (Object.keys(errors).length) throw invalid("Check the Periculum connection details.", errors);
  await withTx(async (tx) => {
    await tx.query(
      `INSERT INTO integration_credentials (provider, client_id, client_secret_enc, base_url, auth_url, updated_by, updated_at, last_test_at, last_test_ok, last_test_message)
       VALUES ('PERICULUM',$1,$2,$3,$4,$5,$6,NULL,NULL,NULL)
       ON CONFLICT (provider) DO UPDATE SET client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc, base_url = EXCLUDED.base_url,
         auth_url = EXCLUDED.auth_url, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at, last_test_at = NULL, last_test_ok = NULL, last_test_message = NULL`,
      [clientId, secret ? encryptField(secret) : existing!.client_secret_enc, baseUrl, authUrl, staffId, ctx.now],
    );
    await audit(tx, ctx, {
      action: "PERICULUM_CREDENTIALS_SAVED",
      actorRole: "SUPER_ADMIN",
      reason,
      details: {
        clientId,
        credentialsRotated: !!secret,
        baseUrl,
        authUrl,
        changed: existing ? { clientId: existing.client_id !== clientId, baseUrl: existing.base_url !== baseUrl, authUrl: existing.auth_url !== authUrl } : "first save",
      },
    });
  });
  forgetPericulumConnection();
}

/** Screen view: never includes the secret. */
export async function periculumSettingsView(q: Db = db) {
  const row = (
    await q.query<{ client_id: string; base_url: string; auth_url: string; updated_at: Date; updated_by_name: string | null; last_test_at: Date | null; last_test_ok: boolean | null; last_test_message: string | null }>(
      `SELECT c.client_id, c.base_url, c.auth_url, c.updated_at, s.full_name AS updated_by_name, c.last_test_at, c.last_test_ok, c.last_test_message
         FROM integration_credentials c LEFT JOIN staff s ON s.id = c.updated_by WHERE c.provider = 'PERICULUM'`,
    )
  ).rows[0];
  const c = config.periculum;
  return {
    saved: row ?? null,
    environmentHasCredentials: !!(c.clientId && c.clientSecret),
    defaults: { baseUrl: normaliseBaseUrl(c.baseUrl), authUrl: c.authUrl },
    enabled: c.enabled,
    mode: c.mode,
    blacklistEnabled: c.blacklistEnabled,
  };
}

/** Record the outcome of a sign-in test (no statement is sent). */
export async function recordSignInTest(ctx: Ctx, ok: boolean, message: string) {
  await requireSuperAdmin(ctx);
  await withTx(async (tx) => {
    await tx.query("UPDATE integration_credentials SET last_test_at = $1, last_test_ok = $2, last_test_message = $3 WHERE provider = 'PERICULUM'", [ctx.now, ok, message.slice(0, 300)]);
    await audit(tx, ctx, { action: "PERICULUM_SIGN_IN_TESTED", actorRole: "SUPER_ADMIN", outcome: ok ? "SUCCESS" : "FAILURE", details: { ok, message: message.slice(0, 300) } });
  });
}
