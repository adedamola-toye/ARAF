import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { baseCtx } from "../../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { readAttachment, verifyAttachmentLink } from "@/server/crm/attachments";
import { DomainError } from "@/server/errors";

/** CRM attachment view/download: live session + a link signed for this user and session; ticket access re-checked. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: true });
  if (r.status !== "ok") return new NextResponse("Session expired. Sign in again.", { status: 401 });
  const s = r.session;
  const mode = req.nextUrl.searchParams.get("mode") === "download" ? "download" : "view";
  if (!verifyAttachmentLink(id, s.staffId, s.sessionId, mode, req.nextUrl.searchParams.get("exp") ?? "", req.nextUrl.searchParams.get("sig") ?? "")) {
    return new NextResponse("This file link has expired. Reload the ticket to get a new link.", { status: 403 });
  }
  ctx.actor = { staffId: s.staffId, email: s.email, name: s.fullName, sessionId: s.sessionId, activeRole: s.activeRole };
  try {
    const { file, data } = await readAttachment(ctx, id, mode);
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": file.mime_type,
        "Content-Disposition": `${mode === "download" ? "attachment" : "inline"}; filename="${file.filename.replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      },
    });
  } catch (e) {
    if (e instanceof DomainError) return new NextResponse(e.message, { status: e.code === "NOT_FOUND" ? 404 : e.code === "GATE" ? 409 : 403 });
    throw e;
  }
}
