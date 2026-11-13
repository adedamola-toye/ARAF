/**
 * Central configuration, read from environment variables (see .env.example).
 * Values are read lazily so tests can override process.env before first use.
 */
function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}
function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer for ${name}`);
  return n;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (!v) return fallback;
  return v === "true" || v === "1";
}

export type AppEnv = "development" | "test" | "production";

/** Fail fast with an actionable message when DATABASE_URL cannot work on the hosting platform. */
function databaseUrlValue(): string {
  const raw = str("DATABASE_URL");
  let host = "";
  let username = "";
  try {
    const u = new URL(raw);
    host = u.hostname;
    username = decodeURIComponent(u.username);
  } catch {
    return raw;
  }
  const hosted = Boolean(process.env.VERCEL || process.env.RENDER);
  if (hosted && /^db\.[a-z0-9]+\.supabase\.co$/i.test(host)) {
    const platform = process.env.VERCEL ? "Vercel" : "Render";
    const port = process.env.VERCEL ? "6543 (transaction pooler)" : "5432 (session pooler)";
    throw new Error(
      `DATABASE_URL uses the Supabase direct host ${host}, which is IPv6-only and unreachable from ${platform}. ` +
        `Use the shared pooler connection string from Supabase -> Connect (port ${port}) with username postgres.<project-ref>.`,
    );
  }
  if (/\.pooler\.supabase\.com$/i.test(host) && !username.includes(".")) {
    throw new Error(
      "Supabase shared pooler requires the username postgres.<project-ref>. Copy the exact connection string from Supabase -> Connect.",
    );
  }
  return raw;
}

export const config = {
  get appEnv(): AppEnv {
    const v = str("APP_ENV", "development");
    if (v !== "development" && v !== "test" && v !== "production") throw new Error("APP_ENV invalid");
    return v;
  },
  get isProduction() {
    return this.appEnv === "production";
  },
  get appUrl() {
    return str("APP_URL", "http://localhost:3000").replace(/\/$/, "");
  },
  get databaseUrl() {
    return databaseUrlValue();
  },
  get fieldKey() {
    return keyFrom("FIELD_ENCRYPTION_KEY");
  },
  get hmacKey() {
    return keyFrom("APP_HMAC_KEY");
  },
  get storageKey() {
    return keyFrom("STORAGE_ENCRYPTION_KEY");
  },
  get sessionIdleSeconds() {
    return int("SESSION_IDLE_SECONDS", 300);
  },
  get sessionAbsoluteHours() {
    return int("SESSION_ABSOLUTE_HOURS", 12);
  },
  get otpTtlSeconds() {
    return int("OTP_TTL_SECONDS", 300);
  },
  get otpMaxAttempts() {
    return int("OTP_MAX_ATTEMPTS", 5);
  },
  get otpIssueLimit() {
    return int("OTP_ISSUE_LIMIT_PER_15_MIN", 5);
  },
  get trustedProxyHops() {
    return int("TRUSTED_PROXY_HOPS", 0);
  },
  get cookieSecure() {
    return bool("COOKIE_SECURE", false);
  },
  get staffEmailDomain() {
    return str("STAFF_EMAIL_DOMAIN", "altbank.ng").toLowerCase();
  },
  get storageDriver() {
    return str("STORAGE_DRIVER", "local") as "local" | "s3";
  },
  get storageLocalDir() {
    return str("STORAGE_LOCAL_DIR", ".data/objects");
  },
  get s3() {
    return {
      bucket: str("S3_BUCKET", ""),
      region: str("S3_REGION", "eu-west-1"),
      endpoint: process.env.S3_ENDPOINT || undefined,
      kmsKeyId: process.env.S3_KMS_KEY_ID || undefined,
      forcePathStyle: bool("S3_FORCE_PATH_STYLE", false),
      serverSideEncryption: str("S3_SERVER_SIDE_ENCRYPTION", "AES256") as "AES256" | "aws:kms" | "none",
    };
  },
  /**
   * SeedFi Loan Engine Seed Score (Altphones), per the SeedFi API documentation v2.0. Disabled unless
   * SEEDFI_ENABLED=true and the base URL and API key are set. Staging: https://stg-loan-engine.theseedfi.com;
   * production: https://loanengine.theseedfi.com (after SeedFi's go-live sign-off).
   */
  get seedfi() {
    return {
      enabled: bool("SEEDFI_ENABLED", false),
      baseUrl: str("SEEDFI_BASE_URL", "").replace(/\/$/, ""),
      apiKey: str("SEEDFI_API_KEY", ""),
      assessPath: str("SEEDFI_ASSESS_PATH", "/scoring/api/v1/seed-score/calculate"),
      timeoutMs: int("SEEDFI_TIMEOUT_MS", 30000),
    };
  },
  /** Paystack (Altphones payments and Direct Debit). Disabled unless PAYSTACK_ENABLED=true and the secret key is set. */
  get paystack() {
    return {
      enabled: bool("PAYSTACK_ENABLED", false),
      secretKey: str("PAYSTACK_SECRET_KEY", ""),
      baseUrl: str("PAYSTACK_BASE_URL", "https://api.paystack.co").replace(/\/$/, ""),
      directDebitEnabled: bool("PAYSTACK_DIRECT_DEBIT_ENABLED", false),
      /** Test keys only: adds Paystack's "Test Bank" (001), the only bank test-mode name enquiry resolves. */
      testMode: bool("PAYSTACK_TEST_MODE", false),
      timeoutMs: int("PAYSTACK_TIMEOUT_MS", 15000),
    };
  },
  get altphonesOtpTtlSeconds() {
    return int("ALTPHONES_OTP_TTL_SECONDS", 600);
  },
  get altphonesOtpMaxAttempts() {
    return int("ALTPHONES_OTP_MAX_ATTEMPTS", 5);
  },
  get maxUploadBytes() {
    return int("MAX_UPLOAD_BYTES", 15 * 1024 * 1024);
  },
  get scannerDriver() {
    return str("SCANNER_DRIVER", "dev") as "none" | "dev" | "defer";
  },
  get retentionYears() {
    return int("RETENTION_YEARS", 10);
  },
  get retentionPurgeEnabled() {
    return bool("RETENTION_PURGE_ENABLED", false);
  },
  get mailDriver() {
    return str("MAIL_DRIVER", "resend") as "dev" | "smtp" | "resend";
  },
  get mailFrom() {
    return str("MAIL_FROM", "ARAF Retail Asset Factory <noreply@araf.ng>");
  },
  get smtp() {
    return {
      host: str("SMTP_HOST", ""),
      port: int("SMTP_PORT", 587),
      user: process.env.SMTP_USER || undefined,
      pass: process.env.SMTP_PASS || undefined,
      secure: bool("SMTP_SECURE", false),
    };
  },
  get resend() {
    return {
      apiKey: str("RESEND_API_KEY", ""),
      baseUrl: str("RESEND_BASE_URL", "https://api.resend.com").replace(/\/$/, ""),
      replyTo: process.env.RESEND_REPLY_TO || undefined,
    };
  },
  get closureMaxAttachmentBytes() {
    return int("CLOSURE_MAX_ATTACHMENT_BYTES", 10 * 1024 * 1024);
  },
  get aprCalculator() {
    return str("APR_CALCULATOR", "wakeelboost-pricing@2026.1");
  },
  /** Failures with the same fingerprint within this many minutes of the last occurrence join one incident. */
  get incidentCorrelationMinutes() {
    return int("INCIDENT_CORRELATION_MINUTES", 30);
  },
  /** Where incident alerts go (comma-separated). Empty: incidents are recorded but not routed. */
  get incidentAlertEmails() {
    return str("INCIDENT_ALERT_EMAILS", "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  },
  /** Cap on incident alert emails per hour across all incidents. */
  get incidentAlertsPerHour() {
    return int("INCIDENT_ALERTS_PER_HOUR", 20);
  },
  get workerPollMs() {
    return int("WORKER_POLL_MS", 5000);
  },
  /**
   * Microsoft SharePoint (Microsoft Graph, app-only client credentials) for completed staff financing
   * archives. Disabled unless SHAREPOINT_ENABLED=true and every value below is set. The client secret
   * is read on the server only and is never sent to the browser.
   */
  get sharepoint() {
    return {
      enabled: bool("SHAREPOINT_ENABLED", false),
      tenantId: str("SHAREPOINT_TENANT_ID", ""),
      clientId: str("SHAREPOINT_CLIENT_ID", ""),
      clientSecret: str("SHAREPOINT_CLIENT_SECRET", ""),
      driveId: str("SHAREPOINT_DRIVE_ID", ""),
      rootFolder: str("SHAREPOINT_ROOT_FOLDER", "ARAF Staff Financing").replace(/^\/+|\/+$/g, ""),
      authorityHost: str("SHAREPOINT_AUTHORITY_HOST", "https://login.microsoftonline.com").replace(/\/$/, ""),
      graphBaseUrl: str("SHAREPOINT_GRAPH_BASE_URL", "https://graph.microsoft.com/v1.0").replace(/\/$/, ""),
    };
  },
};

/** Development keys published in .env.example; refused when APP_ENV=production. */
const DEV_KEYS = new Set([
  "ZGV2LW9ubHktZmllbGQta2V5LWNoYW5nZS1tZS0zMmI=",
  "ZGV2LW9ubHktaG1hYy1rZXktY2hhbmdlLW1lLTMyYnk=",
  "ZGV2LW9ubHktc3RvcmFnZS1rZXktY2hhbmdlLW1lLTM=",
]);

function keyFrom(name: string): Buffer {
  const raw = str(name);
  if (process.env.APP_ENV === "production" && DEV_KEYS.has(raw)) throw new Error(`${name} is the published development key; set a real secret in production`);
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error(`${name} must be 32 bytes, base64 encoded`);
  return buf;
}

/** Guard used by development-only adapters. */
export function assertNotProduction(what: string) {
  if (config.isProduction) {
    throw new Error(`${what} is a development adapter and cannot be used when APP_ENV=production`);
  }
}
