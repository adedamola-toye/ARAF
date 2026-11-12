import { loadEnv } from "./load-env";
loadEnv();
import { Client } from "pg";
import { config } from "../src/server/config";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
}
function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

async function checkDatabase() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    record("DATABASE_URL", false, "missing");
    return;
  }
  let host = "";
  let username = "";
  try {
    const u = new URL(raw);
    host = u.hostname;
    username = decodeURIComponent(u.username);
  } catch {
    record("DATABASE_URL", false, "not a valid connection URL");
    return;
  }
  const hosted = Boolean(process.env.VERCEL || process.env.RENDER);
  const direct = /^db\.[a-z0-9]+\.supabase\.co$/i.test(host);
  const pooler = /\.pooler\.supabase\.com$/i.test(host);
  record(
    "DATABASE_URL host",
    !direct,
    direct ? `${host} is the Supabase direct host (IPv6-only); use the shared pooler for Vercel/Render` : `${host}:${uPort(raw)}`,
  );
  if (pooler) {
    record(
      "pooler username",
      username.includes("."),
      username.includes(".") ? username : `${username} (must be postgres.<project-ref>)`,
    );
  }
  if (hosted && direct) return;

  const client = new Client({ connectionString: raw, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    const info = await client.query<{ db: string; usr: string }>("select current_database() as db, current_user as usr");
    record("database connect", true, `${info.rows[0].db} as ${info.rows[0].usr}`);
    const mig = await client.query<{ n: number }>("select count(*)::int as n from schema_migrations");
    record("migrations", mig.rows[0].n > 0, `${mig.rows[0].n} applied`);
    const tbl = await client.query<{ n: number }>(
      "select count(*)::int as n from information_schema.tables where table_schema = 'public'",
    );
    record("schema tables", tbl.rows[0].n > 0, `${tbl.rows[0].n} in public`);
  } catch (e) {
    const m = message(e);
    const hint = m.includes("not found")
      ? " — check the pooler host index (aws-0/aws-1) and username postgres.<project-ref> in Supabase -> Connect"
      : "";
    record("database connect", false, m + hint);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function uPort(raw: string) {
  try {
    return new URL(raw).port || "5432";
  } catch {
    return "5432";
  }
}

async function checkStorage() {
  if (config.storageDriver !== "s3") {
    record("storage", true, `${config.storageDriver} (local storage cannot be used on Vercel/Render)`);
    return;
  }
  if (!config.s3.bucket) {
    record("s3 bucket", false, "S3_BUCKET is missing");
    return;
  }
  try {
    const s3 = await import("@aws-sdk/client-s3");
    const client = new s3.S3Client({
      region: config.s3.region,
      endpoint: config.s3.endpoint,
      forcePathStyle: config.s3.forcePathStyle,
    });
    const r = await client.send(new s3.ListObjectsV2Command({ Bucket: config.s3.bucket, MaxKeys: 1 }));
    record("s3 bucket", true, `${config.s3.bucket} reachable (${r.KeyCount ?? 0} keys sampled)`);
    client.destroy();
  } catch (e) {
    record("s3 bucket", false, message(e));
  }
}

async function checkMail() {
  try {
    const driver = config.mailDriver;
    const from = config.mailFrom;
    const key = process.env.RESEND_API_KEY;
    const configured = driver !== "resend" || Boolean(key);
    record(
      "mail",
      configured,
      `${driver} from ${from}${driver === "resend" && !key ? " (RESEND_API_KEY missing)" : " (send a test with npm run mail:test -- you@example.com)"}`,
    );
  } catch (e) {
    record("mail", false, message(e));
  }
}

async function checkKeys() {
  for (const name of ["FIELD_ENCRYPTION_KEY", "APP_HMAC_KEY", "STORAGE_ENCRYPTION_KEY"]) {
    const value = process.env[name];
    if (!value) {
      record(name, false, "missing");
      continue;
    }
    const bytes = Buffer.from(value, "base64").length;
    record(name, bytes === 32, bytes === 32 ? "32 bytes" : `${bytes} bytes (must be 32, base64 encoded)`);
  }
}

async function main() {
  console.log(`Env file: ${process.env.ENV_FILE ?? ".env"}`);
  console.log(`APP_ENV: ${process.env.APP_ENV ?? "(unset)"}`);
  console.log(`APP_URL: ${process.env.APP_URL ?? "(unset)"}`);
  console.log("");

  const appUrl = process.env.APP_URL ?? "";
  record(
    "APP_URL",
    Boolean(appUrl) && !appUrl.includes("REPLACE") && !appUrl.startsWith("http://localhost"),
    appUrl || "missing",
  );

  await checkKeys();
  await checkDatabase();
  await checkStorage();
  await checkMail();

  for (const c of checks) console.log(`${c.ok ? "OK  " : "FAIL"} ${c.name}: ${c.detail}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length ? `\n${failed.length} check(s) failed` : "\nAll checks passed");
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
