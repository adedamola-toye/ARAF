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
    return str("DATABASE_URL");
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
    };
  },
  get maxUploadBytes() {
    return int("MAX_UPLOAD_BYTES", 15 * 1024 * 1024);
  },
  get scannerDriver() {
    return str("SCANNER_DRIVER", "dev") as "dev" | "clamd";
  },
  get clamd() {
    return { host: str("CLAMD_HOST", "127.0.0.1"), port: int("CLAMD_PORT", 3310) };
  },
  get retentionYears() {
    return int("RETENTION_YEARS", 10);
  },
  get retentionPurgeEnabled() {
    return bool("RETENTION_PURGE_ENABLED", false);
  },
  get mailDriver() {
    return str("MAIL_DRIVER", "dev") as "dev" | "smtp";
  },
  get mailFrom() {
    return str("MAIL_FROM", "WakeelBoost Work Desk <workdesk@altbank.ng>");
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
  get closureMaxAttachmentBytes() {
    return int("CLOSURE_MAX_ATTACHMENT_BYTES", 10 * 1024 * 1024);
  },
  get aprCalculator() {
    return str("APR_CALCULATOR", "altbank-apr-2024@1.0");
  },
  get workerPollMs() {
    return int("WORKER_POLL_MS", 5000);
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
