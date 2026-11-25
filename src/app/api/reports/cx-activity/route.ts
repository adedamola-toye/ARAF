import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { baseCtx } from "../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { db } from "@/server/db";
import { cxActivityCsv, cxReviewerActivity, requireCxActivityAccess } from "@/server/cx-activity";
import { DomainError } from "@/server/errors";
import { lagosDate } from "@/server/time";

/** CSV export of CX reviewer activity, with the same permission check as the on-screen report. */
export async function GET(req: NextRequest) {
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: true });
  if (r.status !== "ok") return new NextResponse("Session expired. Sign in again.", { status: 401 });
  ctx.actor = { staffId: r.session.staffId, email: r.session.email, name: r.session.fullName, sessionId: r.session.sessionId, activeRole: r.session.activeRole };
  const sp = req.nextUrl.searchParams;
  try {
    await requireCxActivityAccess(db, ctx.actor.staffId);
    const data = await cxReviewerActivity(db, {
      from: sp.get("from"),
      to: sp.get("to"),
      reviewer: sp.get("reviewer"),
      action: sp.get("action"),
    });
    return new NextResponse(cxActivityCsv(data), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="cx-reviewer-activity-${lagosDate(new Date())}.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof DomainError) return new NextResponse(e.message, { status: 403 });
    throw e;
  }
}
