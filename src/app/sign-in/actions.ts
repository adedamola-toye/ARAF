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

export async function requestOtpAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const email = String(fd.get("email") ?? "").trim();
  const as = String(fd.get("as") ?? "");
  const next = safeNext(String(fd.get("next") ?? ""));
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return { ok: false, error: "Enter your work email address.", fields: { email: "Required." } };
  try {
    await requestOtp(await baseCtx(), email);
  } catch (e) {
    return toActionError(e);
  }
  (await cookies()).set(PENDING_COOKIE, JSON.stringify({ email, as }), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/sign-in",
    maxAge: config.otpTtlSeconds,
  });
  redirect(`/sign-in/verify?as=${encodeURIComponent(as)}&next=${encodeURIComponent(next)}`);
}

export async function verifyOtpAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const jar = await cookies();
  const pending = jar.get(PENDING_COOKIE)?.value;
  if (!pending) return { ok: false, error: "Your sign-in attempt expired. Request a new code." };
  const { email, as } = JSON.parse(pending) as { email: string; as: string };
  const code = String(fd.get("code") ?? "").replace(/\s/g, "");
  const next = safeNext(String(fd.get("next") ?? ""));
  let token: string;
  try {
    const login = await verifyOtp(await baseCtx(), email, code, isInitiatorRole(as) ? as : null);
    token = login.token;
  } catch (e) {
    return toActionError(e);
  }
  jar.delete({ name: PENDING_COOKIE, path: "/sign-in" });
  jar.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: "/" });
  redirect(next);
}
