import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { baseCtx } from "../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { DomainError } from "@/server/errors";
import { reportForCurrentUser } from "@/server/incidents/subject";
import type { Ctx } from "@/server/context";

/** Live session + same-origin check shared by the upload endpoints. */
export async function uploadCtx(req: NextRequest): Promise<Ctx | NextResponse> {
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ ok: false, error: "Cross-origin upload refused." }, { status: 403 });
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: true });
  if (r.status !== "ok") return NextResponse.json({ ok: false, error: "Your session has ended. Sign in again.", expired: true }, { status: 401 });
  ctx.actor = { staffId: r.session.staffId, email: r.session.email, name: r.session.fullName, sessionId: r.session.sessionId, activeRole: r.session.activeRole };
  return ctx;
}

export async function uploadError(e: unknown, req: NextRequest) {
  if (e instanceof DomainError) {
    const status = e.code === "FORBIDDEN" ? 403 : e.code === "NOT_FOUND" ? 404 : e.code === "CONFLICT" ? 409 : e.code === "CONFIG" ? 500 : 400;
    return NextResponse.json({ ok: false, error: e.message }, { status });
  }
  const incident = await reportForCurrentUser({ source: "api", error: e, route: req.nextUrl.pathname });
  return NextResponse.json({ ok: false, error: "The upload hit a technical problem. Try again.", incident: { ...incident, retry: true } }, { status: 500 });
}
