"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { baseCtx } from "../_lib/auth";
import { toActionError, type ActionState } from "../_lib/action";
import { requestOtp, verifyOtp } from "@/server/auth/otp";
import { SESSION_COOKIE } from "@/server/auth/session";
import { config } from "@/server/config";
import { safeNext } from "@/lib/paths";
import { isInitiatorRole } from "@/server/domain/roles";

const PENDING_COOKIE = "wb-otp-pending";

async function setPending(email: string, as: string) {
  (await cookies()).set(PENDING_COOKIE, JSON.stringify({ email, as, at: Date.now() }), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/sign-in",
    maxAge: config.otpTtlSeconds,
  });
}

export async function readPending(): Promise<{ email: string; as: string; at: number } | null> {
  const v = (await cookies()).get(PENDING_COOKIE)?.value;
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export async function requestOtpAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const email = String(fd.get("email") ?? "").trim();
  const as = String(fd.get("as") ?? "");
  const next = safeNext(String(fd.get("next") ?? ""));
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return { ok: false, error: "Enter your work email.", fields: { email: "Required." } };
  if (!email.toLowerCase().endsWith(`@${config.staffEmailDomain}`)) return { ok: false, error: `Use your @${config.staffEmailDomain} email.`, fields: { email: "Invalid domain." } };
  try {
    await requestOtp(await baseCtx(), email);
  } catch (e) {
    return toActionError(e);
  }
  await setPending(email, as);
  redirect(`/sign-in/verify?next=${encodeURIComponent(next)}`);
}

export async function resendOtpAction(_prev: ActionState): Promise<ActionState> {
  const p = await readPending();
  if (!p) return { ok: false, error: "Your sign-in attempt expired. Start again with your work email." };
  try {
    await requestOtp(await baseCtx(), p.email);
  } catch (e) {
    return toActionError(e);
  }
  await setPending(p.email, p.as);
  return { ok: true, message: "If the email is provisioned, a new code has been sent. Earlier codes no longer work.", nonce: Date.now() };
}

export async function verifyOtpAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const jar = await cookies();
  const p = await readPending();
  if (!p) return { ok: false, error: "Your sign-in attempt expired. Start again with your work email." };
  const code = String(fd.get("code") ?? "").replace(/\s/g, "");
  const workspace = String(fd.get("workspace") ?? p.as ?? "");
  const next = safeNext(String(fd.get("next") ?? ""));
  let token: string;
  try {
    const login = await verifyOtp(await baseCtx(), p.email, code, isInitiatorRole(workspace) ? workspace : null);
    token = login.token;
  } catch (e) {
    return toActionError(e);
  }
  jar.delete({ name: PENDING_COOKIE, path: "/sign-in" });
  jar.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: "/" });
  redirect(next);
}
