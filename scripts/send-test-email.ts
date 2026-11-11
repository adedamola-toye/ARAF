import { loadEnv } from "./load-env";
loadEnv();
import { config } from "../src/server/config";
import { mailTransport } from "../src/server/notify/transport";
import { closePool } from "../src/server/db";

/**
 * Send one real test email through the configured transport (MAIL_DRIVER).
 * Usage: npm run mail:test -- you@example.com
 */
async function main() {
  const to = process.argv[2]?.trim();
  if (!to || !to.includes("@")) {
    console.error("Usage: npm run mail:test -- you@example.com");
    process.exitCode = 1;
    return;
  }

  const driver = config.mailDriver;
  console.log(`[mail:test] driver=${driver}`);
  console.log(`[mail:test] from=${config.mailFrom}`);
  if (driver === "dev") console.warn("[mail:test] MAIL_DRIVER=dev captures the message in the test mailbox; no real email is sent. Set MAIL_DRIVER=resend to deliver.");
  if (driver === "resend" && !config.resend.apiKey) console.warn("[mail:test] RESEND_API_KEY is empty.");

  try {
    const r = await mailTransport().send({
      to: [to],
      cc: [],
      subject: "ARAF Retail Asset Factory mail test",
      text: [
        "ARAF Retail Asset Factory",
        "",
        `This is a test message sent at ${new Date().toISOString()} via ${driver}.`,
        "OTP sign-in codes, assignments, reminders, digests and closure packs use this same transport.",
        "",
        "A platform by The Alternative Bank. Internal use only.",
      ].join("\n"),
      attachments: [],
    });
    console.log(`[mail:test] sent (${r.messageId}). Check the inbox and the provider dashboard logs.`);
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    console.error(`[mail:test] failed: ${message}`);
    if (/403/.test(message) && /domain|verif/i.test(message)) {
      console.error("[mail:test] Resend has not verified the sending domain yet. Add its DNS records in Cloudflare (docs/EMAIL.md) and set MAIL_FROM to that domain.");
    } else if (/401/.test(message) || /API key/i.test(message)) {
      console.error("[mail:test] Check RESEND_API_KEY (it needs Sending access).");
    }
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
