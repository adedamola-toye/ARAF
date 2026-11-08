import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { baseCtx } from "../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { readDocumentForActor, verifyDocumentLink } from "@/server/domain/documents";
import { DomainError } from "@/server/errors";

/**
 * Authorised document preview/download. Requires BOTH a live session and an unexpired signed
 * link bound to that user and session; case-scoped access is re-checked on every request.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: true });
  if (r.status !== "ok") return new NextResponse("Session expired. Sign in again.", { status: 401 });
  const s = r.session;
  const mode = req.nextUrl.searchParams.get("mode") === "download" ? "download" : "view";
  const ok = verifyDocumentLink(id, s.staffId, s.sessionId, mode, req.nextUrl.searchParams.get("exp") ?? "", req.nextUrl.searchParams.get("sig") ?? "");
  if (!ok) return new NextResponse("This document link has expired. Reload the page to get a new link.", { status: 403 });
  ctx.actor = { staffId: s.staffId, email: s.email, name: s.fullName, sessionId: s.sessionId, activeRole: s.activeRole };
  try {
    const { doc, data } = await readDocumentForActor(ctx, id, mode);
    const disposition = mode === "download" ? "attachment" : "inline";
    const headers: Record<string, string> = {
      "Content-Type": doc.mime_type === "text/html" ? "text/html; charset=utf-8" : doc.mime_type,
      "Content-Disposition": `${disposition}; filename="${doc.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
    };
    // Generated offers are HTML: render them sandboxed (no scripts, no network) when previewed.
    if (doc.mime_type === "text/html") headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";
    return new NextResponse(new Uint8Array(data), { status: 200, headers });
  } catch (e) {
    if (e instanceof DomainError) return new NextResponse(e.message, { status: e.code === "NOT_FOUND" ? 404 : 403 });
    throw e;
  }
}
