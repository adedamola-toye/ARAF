import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { baseCtx } from "../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";

/** Background polling: reports session state WITHOUT extending the inactivity window. */
export async function GET() {
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, await baseCtx(), { touch: false });
  const body = r.status === "ok" ? { status: "ok", idleExpiresAt: r.session.idleExpiresAt } : { status: r.status };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
