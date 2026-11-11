import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { baseCtx } from "../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { exportRetail } from "@/server/retail-reports";
import { DomainError } from "@/server/errors";
import { lagosDate } from "@/server/time";

export async function GET(req: NextRequest) {
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: true });
  if (r.status !== "ok") return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  ctx.actor = { staffId: r.session.staffId, email: r.session.email, name: r.session.fullName, sessionId: r.session.sessionId, activeRole: r.session.activeRole };
  const sp = req.nextUrl.searchParams;
  try {
    const csv = await exportRetail(ctx, { from: sp.get("from"), to: sp.get("to"), product: sp.get("product") });
    return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="retail-applications-${lagosDate(new Date())}.csv"`, "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof DomainError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
}
