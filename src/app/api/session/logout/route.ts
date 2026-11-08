import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { baseCtx } from "../../../_lib/auth";
import { lookupSession, revokeSession, SESSION_COOKIE } from "@/server/auth/session";
import { db } from "@/server/db";

export async function POST() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const ctx = await baseCtx();
  const r = await lookupSession(token, ctx, { touch: false });
  if (r.status === "ok") {
    ctx.actor = { staffId: r.session.staffId, email: r.session.email, name: r.session.fullName, sessionId: r.session.sessionId, activeRole: r.session.activeRole };
    await revokeSession(db, ctx, r.session.sessionId, "LOGOUT", "LOGOUT");
  }
  jar.delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}
