import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { baseCtx } from "../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { uploadStaffDocument } from "@/server/staff/documents";
import { DomainError } from "@/server/errors";

/** Staff financing upload (progress-reporting control). Same-origin, live session; all rules live in the domain module. */
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
    const res = await uploadStaffDocument(ctx, { requestId: String(fd.get("requestId") ?? ""), category: String(fd.get("category") ?? ""), filename: file.name, data: Buffer.from(await file.arrayBuffer()) });
    if (res.scanStatus === "REJECTED") return NextResponse.json({ ok: false, error: "The file failed the malware scan and was quarantined. It will not be used." }, { status: 422 });
    return NextResponse.json({ ok: true, id: res.id, scanStatus: res.scanStatus });
  } catch (e) {
    if (e instanceof DomainError) return NextResponse.json({ ok: false, error: e.message }, { status: e.code === "FORBIDDEN" ? 403 : e.code === "CONFIG" ? 500 : 400 });
    console.error("[staff-requests/upload] unexpected failure", e);
    return NextResponse.json({ ok: false, error: "The upload failed unexpectedly. Try again, or contact an administrator if it keeps happening." }, { status: 500 });
  }
}
