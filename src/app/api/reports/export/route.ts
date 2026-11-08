import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { baseCtx } from "../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { exportReport } from "@/server/reports";
import { DomainError } from "@/server/errors";
import { lagosDate } from "@/server/time";

/** CSV/XLSX export: same filters and permission checks as the on-screen report; audited. */
export async function GET(req: NextRequest) {
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: true });
  if (r.status !== "ok") return new NextResponse("Session expired. Sign in again.", { status: 401 });
  ctx.actor = { staffId: r.session.staffId, email: r.session.email, name: r.session.fullName, sessionId: r.session.sessionId, activeRole: r.session.activeRole };
  const params = Object.fromEntries(req.nextUrl.searchParams.entries());
  const format = params.format === "xlsx" ? "xlsx" : "csv";
  delete params.format;
  try {
    const { body } = await exportReport(ctx, params, format);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="wakeelboost-report-${lagosDate(new Date())}.${format}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof DomainError) return new NextResponse(e.message, { status: 403 });
    throw e;
  }
}
