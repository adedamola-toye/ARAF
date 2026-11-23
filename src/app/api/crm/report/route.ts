import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { baseCtx } from "../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { db } from "@/server/db";
import { audit } from "@/server/audit";
import { crmPrincipal, isOversight } from "@/server/crm/core";
import { buildCxReport, reportCsv, reportPdf } from "@/server/crm/reports";
import { addDaysToDateString, isValidDateString, lagosDate } from "@/server/time";

/** CX report export (CSV or PDF). CX Head and Super Admin only; every export is audited. */
export async function GET(req: NextRequest) {
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: true });
  if (r.status !== "ok") return new NextResponse("Session expired. Sign in again.", { status: 401 });
  const s = r.session;
  ctx.actor = { staffId: s.staffId, email: s.email, name: s.fullName, sessionId: s.sessionId, activeRole: s.activeRole };
  if (!isOversight(await crmPrincipal(db, s.staffId))) {
    await audit(db, ctx, { action: "CRM_REPORT_EXPORTED", outcome: "DENIED", details: {} });
    return new NextResponse("Only the CX Head or Super Admin can export CX reports.", { status: 403 });
  }
  const sp = req.nextUrl.searchParams;
  const today = lagosDate(new Date());
  let from = sp.get("from") ?? "";
  let to = sp.get("to") ?? "";
  if (!isValidDateString(to)) to = today;
  if (!isValidDateString(from)) from = addDaysToDateString(to, -29);
  if (from > to) [from, to] = [to, from];
  const title = sp.get("title");
  const freq = title === "DAILY" || title === "WEEKLY" || title === "MONTHLY" ? title : "ON_DEMAND";
  const report = await buildCxReport(db, freq, new Date(), { from, to });
  const format = sp.get("format") === "pdf" ? "pdf" : "csv";
  await audit(db, ctx, { action: "CRM_REPORT_EXPORTED", details: { format, from, to } });
  const name = `araf-cx-report-${from}-to-${to}.${format}`;
  if (format === "pdf")
    return new NextResponse(new Uint8Array(await reportPdf(report)), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" } });
  return new NextResponse(reportCsv(report), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" } });
}
