import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { baseCtx } from "../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { db } from "@/server/db";
import { auditOutsideTx } from "@/server/audit";
import { caseAccess } from "@/server/domain/access";
import { readArchive } from "@/server/domain/facility-archive";
import { DomainError } from "@/server/errors";

/** Facility archive download: live session and case access, audited. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: true });
  if (r.status !== "ok") return new NextResponse("Session expired. Sign in again.", { status: 401 });
  const s = r.session;
  ctx.actor = { staffId: s.staffId, email: s.email, name: s.fullName, sessionId: s.sessionId, activeRole: s.activeRole };
  try {
    const appId = (await db.query<{ application_id: string }>("SELECT application_id FROM application_archives WHERE id = $1", [id])).rows[0]?.application_id;
    if (!appId) return new NextResponse("Not found.", { status: 404 });
    const access = await caseAccess(db, s.staffId, appId);
    if (!access.canView) {
      await auditOutsideTx(ctx, { action: "ARCHIVE_DOWNLOAD", outcome: "DENIED", applicationId: appId, details: { archiveId: id } });
      return new NextResponse("You do not have access to this archive.", { status: 403 });
    }
    const { archive, data } = await readArchive(db, id);
    await auditOutsideTx(ctx, { action: "ARCHIVE_DOWNLOAD", applicationId: appId, details: { archiveId: id, capacities: access.capacities } });
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${String(archive.filename).replace(/"/g, "")}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (e) {
    if (e instanceof DomainError) return new NextResponse(e.message, { status: e.code === "NOT_FOUND" ? 404 : 403 });
    throw e;
  }
}
