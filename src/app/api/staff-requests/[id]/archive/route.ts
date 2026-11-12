import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { baseCtx } from "../../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { readArchive } from "@/server/staff/pipeline";
import { DomainError } from "@/server/errors";

/** Documentation archive: Super Admins, Legal and Shariah reviewers only; integrity-checked; every download audited. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: true });
  if (r.status !== "ok") return new NextResponse("Session expired. Sign in again.", { status: 401 });
  const s = r.session;
  ctx.actor = { staffId: s.staffId, email: s.email, name: s.fullName, sessionId: s.sessionId, activeRole: s.activeRole };
  try {
    const { filename, data } = await readArchive(ctx, id);
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (e) {
    if (e instanceof DomainError) return new NextResponse(e.message, { status: e.code === "NOT_FOUND" ? 404 : e.code === "GATE" ? 409 : 403 });
    throw e;
  }
}
