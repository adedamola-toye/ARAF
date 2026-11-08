import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Ctx } from "@/server/context";
import { clientIpFromHeaders } from "@/server/context";
import { lookupSession, SESSION_COOKIE, type SessionInfo } from "@/server/auth/session";
import type { Role } from "@/server/domain/roles";

export async function baseCtx(): Promise<Ctx> {
  const h = await headers();
  return {
    actor: null,
    now: new Date(),
    correlationId: h.get("x-correlation-id") ?? crypto.randomUUID(),
    ip: clientIpFromHeaders((n) => h.get(n)),
    userAgent: h.get("user-agent"),
  };
}

export interface Authed {
  session: SessionInfo;
  ctx: Ctx;
  roles: Role[];
}

async function currentPath() {
  const h = await headers();
  return h.get("x-pathname") ?? "/queue";
}

/**
 * Validate the session for a user-initiated request (extends the inactivity window).
 * Redirects to sign-in when there is no session, or to the expired-session screen.
 */
export async function requireUser(opts: { touch?: boolean; next?: string } = {}): Promise<Authed> {
  const ctx = await baseCtx();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const r = await lookupSession(token, ctx, { touch: opts.touch ?? true });
  const next = opts.next ?? (await currentPath());
  if (r.status === "none") redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  if (r.status === "expired") redirect(`/session-expired?reason=${r.reason}&next=${encodeURIComponent(next)}`);
  const s = r.session;
  ctx.actor = { staffId: s.staffId, email: s.email, name: s.fullName, sessionId: s.sessionId, activeRole: s.activeRole };
  return { session: s, ctx, roles: [...new Set(s.roles.map((x) => x.role))] };
}

export async function requireRole(roles: Role[]): Promise<Authed> {
  const a = await requireUser();
  if (!a.roles.some((r) => roles.includes(r))) redirect("/forbidden");
  return a;
}
