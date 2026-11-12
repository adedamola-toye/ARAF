import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { baseCtx } from "../../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { readStaffDocument } from "@/server/staff/documents";
import { verifyStaffDocLink } from "@/server/staff/views";
import { DomainError } from "@/server/errors";

/** Staff financing document preview/download: live session + signed link bound to user and session; access re-checked. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: true });
  if (r.status !== "ok") return new NextResponse("Session expired. Sign in again.", { status: 401 });
  const s = r.session;
  const mode = req.nextUrl.searchParams.get("mode") === "download" ? "download" : "view";
  if (!verifyStaffDocLink(id, s.staffId, s.sessionId, mode, req.nextUrl.searchParams.get("exp") ?? "", req.nextUrl.searchParams.get("sig") ?? "")) {
    return new NextResponse("This document link has expired. Reload the page to get a new link.", { status: 403 });
  }
  ctx.actor = { staffId: s.staffId, email: s.email, name: s.fullName, sessionId: s.sessionId, activeRole: s.activeRole };
  try {
    const { doc, data } = await readStaffDocument(ctx, id, mode);
    const headers: Record<string, string> = {
      "Content-Type": doc.mime_type === "text/html" ? "text/html; charset=utf-8" : doc.mime_type,
      "Content-Disposition": `${mode === "download" ? "attachment" : "inline"}; filename="${doc.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
    };
    if (doc.mime_type === "text/html") headers["Content-Security-Policy"] = "sandbox allow-modals; default-src 'none'; img-src data:; style-src 'unsafe-inline'";
    return new NextResponse(new Uint8Array(data), { status: 200, headers });
  } catch (e) {
    if (e instanceof DomainError) return new NextResponse(e.message, { status: e.code === "NOT_FOUND" ? 404 : e.code === "GATE" ? 409 : 403 });
    throw e;
  }
}
