import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { baseCtx } from "../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";

/** Explicit user-activity heartbeat (keyboard/pointer input) - extends the inactivity window. */
export async function POST() {
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, await baseCtx(), { touch: true });
  const body = r.status === "ok" ? { status: "ok", idleExpiresAt: r.session.idleExpiresAt } : { status: r.status };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
