import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { config } from "../config";
import { hmac, randomOtp, safeEqualHex } from "../crypto";
import { DomainError } from "../errors";
import { maskEmail } from "../mask";
import { mailTransport } from "../notify/transport";
import { simpleEmail } from "../notify/templates";
import { rateLimit } from "./rateLimit";
import { createSession } from "./session";

export const GENERIC_OTP_MESSAGE = "If this email belongs to provisioned Retail Asset Factory staff, a one-time code has been sent to it.";

export function normaliseEmail(e: string) {
  return e.trim().toLowerCase();
}
const emailHash = (email: string) => hmac(`email:${normaliseEmail(email)}`);
const codeHash = (challengeId: string, code: string) => hmac(`otp:${challengeId}:${code}`);

/**
 * Issue a short-lived, single-use OTP. The response never reveals whether the email exists.
 * Codes are stored only as HMACs. The email body containing the code is sent directly through
 * the mail transport and is never persisted in the outbox.
 */
export async function requestOtp(ctx: Ctx, rawEmail: string): Promise<{ message: string }> {
  const email = normaliseEmail(rawEmail);
  const eh = emailHash(email);
  const okEmail = await rateLimit(db, `otp-issue:${eh}`, config.otpIssueLimit, 900, ctx.now);
  const okIp = await rateLimit(db, `otp-issue-ip:${ctx.ip ?? "unknown"}`, config.otpIssueLimit * 6, 900, ctx.now);
  if (!okEmail || !okIp) {
    await auditOutsideTx(ctx, { action: "OTP_REQUEST", outcome: "DENIED", reason: "rate_limited", actorEmail: maskEmail(email), actorId: null });
    throw new DomainError("RATE_LIMITED", "Too many sign-in attempts. Wait a few minutes and try again.");
  }
  const domainOk = email.endsWith(`@${config.staffEmailDomain}`);
  const staff = domainOk
    ? (
        await db.query<{ id: string; full_name: string }>(
          `SELECT s.id, s.full_name FROM staff s WHERE s.email = $1 AND s.status = 'ACTIVE'
             AND EXISTS (SELECT 1 FROM role_assignments ra WHERE ra.staff_id = s.id AND ra.active)`,
          [email],
        )
      ).rows[0]
    : undefined;
  if (!staff) {
    await auditOutsideTx(ctx, { action: "OTP_REQUEST", outcome: "DENIED", reason: "unknown_or_inactive", actorEmail: maskEmail(email), actorId: null });
    return { message: GENERIC_OTP_MESSAGE };
  }
  const code = randomOtp();
  const challenge = await withTx(async (tx) => {
    // Invalidate earlier unconsumed codes for this email.
    await tx.query("UPDATE otp_challenges SET consumed_at = $2 WHERE email_hash = $1 AND consumed_at IS NULL", [eh, ctx.now]);
    const c = await tx.query<{ id: string }>(
      `INSERT INTO otp_challenges (email_hash, staff_id, code_hash, ip, created_at, expires_at) VALUES ($1,$2,'pending',$3,$4,$5) RETURNING id`,
      [eh, staff.id, ctx.ip, ctx.now, new Date(ctx.now.getTime() + config.otpTtlSeconds * 1000)],
    );
    await tx.query("UPDATE otp_challenges SET code_hash = $2 WHERE id = $1", [c.rows[0].id, codeHash(c.rows[0].id, code)]);
    await audit(tx, ctx, { action: "OTP_REQUEST", actorId: staff.id, actorEmail: email, details: { challengeId: c.rows[0].id } });
    return c.rows[0].id;
  });
  try {
    await mailTransport().send({
      to: [email],
      cc: [],
      subject: "Your AltBank Retail Asset Factory sign-in code",
      text: simpleEmail([
        `Your one-time sign-in code is: ${code}`,
        `It expires in ${Math.round(config.otpTtlSeconds / 60)} minutes and can be used once.`,
        "If you did not request this code, contact Information Security.",
      ]),
      attachments: [],
    });
    await auditOutsideTx(ctx, { action: "EMAIL_SENT", actorId: staff.id, actorEmail: email, details: { kind: "OTP", challengeId: challenge } });
  } catch (err) {
    await auditOutsideTx(ctx, { action: "EMAIL_FAILED", outcome: "FAILURE", actorId: staff.id, actorEmail: email, details: { kind: "OTP", error: String(err).slice(0, 200) } });
  }
  return { message: GENERIC_OTP_MESSAGE };
}

export interface VerifiedLogin {
  token: string;
  sessionId: string;
  staffId: string;
  activeRole: string | null;
}

export async function verifyOtp(ctx: Ctx, rawEmail: string, code: string, preferredRole?: string | null): Promise<VerifiedLogin> {
  const email = normaliseEmail(rawEmail);
  const eh = emailHash(email);
  const fail = new DomainError("UNAUTHENTICATED", "The code is invalid or has expired. Request a new code.");
  const okIp = await rateLimit(db, `otp-verify-ip:${ctx.ip ?? "unknown"}`, 50, 900, ctx.now);
  if (!okIp) throw new DomainError("RATE_LIMITED", "Too many attempts. Wait a few minutes and try again.");
  if (!/^\d{6}$/.test(code.trim())) {
    await auditOutsideTx(ctx, { action: "LOGIN", outcome: "DENIED", reason: "malformed_code", actorEmail: maskEmail(email), actorId: null });
    throw fail;
  }
  const result = await withTx(async (tx) => {
    const c = (
      await tx.query<{ id: string; staff_id: string; code_hash: string; attempts: number; expires_at: Date }>(
        `SELECT * FROM otp_challenges WHERE email_hash = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [eh],
      )
    ).rows[0];
    if (!c || new Date(c.expires_at) <= ctx.now || c.attempts >= config.otpMaxAttempts) return { ok: false as const, reason: "no_valid_challenge", staffId: c?.staff_id ?? null };
    if (!safeEqualHex(c.code_hash, codeHash(c.id, code.trim()))) {
      await tx.query("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1", [c.id]);
      if (c.attempts + 1 >= config.otpMaxAttempts) await tx.query("UPDATE otp_challenges SET consumed_at = $2 WHERE id = $1", [c.id, ctx.now]);
      return { ok: false as const, reason: "wrong_code", staffId: c.staff_id };
    }
    await tx.query("UPDATE otp_challenges SET consumed_at = $2 WHERE id = $1", [c.id, ctx.now]);
    const staff = (await tx.query("SELECT * FROM staff WHERE id = $1 AND status = 'ACTIVE'", [c.staff_id])).rows[0];
    if (!staff) return { ok: false as const, reason: "inactive", staffId: c.staff_id };
    const s = await createSession(tx, ctx, staff.id, preferredRole ?? null);
    await audit(tx, { ...ctx, actor: { staffId: staff.id, email: staff.email, name: staff.full_name, sessionId: s.sessionId, activeRole: s.activeRole } }, {
      action: "LOGIN",
      actorRole: s.activeRole,
      details: { requestedWorkspace: preferredRole ?? null, grantedWorkspace: s.activeRole },
    });
    return { ok: true as const, login: { ...s, staffId: staff.id } };
  });
  if (!result.ok) {
    await auditOutsideTx(ctx, { action: "LOGIN", outcome: "DENIED", reason: result.reason, actorId: result.staffId, actorEmail: maskEmail(email) });
    throw fail;
  }
  return result.login;
}
