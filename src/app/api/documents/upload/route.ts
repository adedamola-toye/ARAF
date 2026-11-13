import { cookies } from "next/headers";
import { reportForCurrentUser } from "@/server/incidents/subject";
import { NextResponse, type NextRequest } from "next/server";
import { baseCtx } from "../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { uploadDocument } from "@/server/domain/documents";
import { DomainError } from "@/server/errors";

/**
 * Document upload endpoint (used by the progress-reporting upload control). Same rules as the
 * server action: live session, stage/assignee/category checks, type sniffing, quarantine and scan,
 * all inside the documents domain module. Same-origin only.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ ok: false, error: "Cross-origin upload refused." }, { status: 403 });
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: true });
  if (r.status !== "ok") return NextResponse.json({ ok: false, error: "Your session has ended. Sign in again.", expired: true }, { status: 401 });
  ctx.actor = { staffId: r.session.staffId, email: r.session.email, name: r.session.fullName, sessionId: r.session.sessionId, activeRole: r.session.activeRole };
  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "The upload could not be read. Try again." }, { status: 400 });
  }
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ ok: false, error: "Choose a file to upload." }, { status: 400 });
  try {
    const res = await uploadDocument(ctx, {
      applicationId: String(fd.get("applicationId") ?? ""),
      category: String(fd.get("category") ?? ""),
      filename: file.name,
      data: Buffer.from(await file.arrayBuffer()),
      replacesDocumentId: String(fd.get("replacesDocumentId") ?? "") || null,
      meta: {
        photoCategory: String(fd.get("photoCategory") ?? ""),
        coverageFrom: String(fd.get("coverageFrom") ?? ""),
        coverageTo: String(fd.get("coverageTo") ?? ""),
      },
    });
    if (res.scanStatus === "REJECTED") return NextResponse.json({ ok: false, error: "The file failed the malware scan and was quarantined. It will not be used." }, { status: 422 });
    return NextResponse.json({ ok: true, version: res.version, scanStatus: res.scanStatus });
  } catch (e) {
    if (e instanceof DomainError) {
      const status = e.code === "FORBIDDEN" ? 403 : e.code === "CONFIG" ? 500 : 400;
      return NextResponse.json({ ok: false, error: e.message }, { status });
    }
    // A technical failure: recorded as an incident (sanitised); the uploader shows the incident panel.
    const incident = await reportForCurrentUser({ source: "api", error: e, route: req.nextUrl.pathname });
    return NextResponse.json({ ok: false, error: "The upload hit a technical problem. Your file was not stored; try again.", incident: { ...incident, retry: true } }, { status: 500 });
  }
}
