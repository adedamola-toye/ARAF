import { NextResponse, type NextRequest } from "next/server";
import { startUpload } from "@/server/uploads";
import { uploadCtx, uploadError } from "./_lib";

/** Start a resumable upload: permission and size are checked before any file data is sent. */
export async function POST(req: NextRequest) {
  const ctx = await uploadCtx(req);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const b = await req.json();
    const r = await startUpload(ctx, { target: b.target, targetId: String(b.targetId ?? ""), category: String(b.category ?? ""), filename: String(b.filename ?? ""), size: Number(b.size), fields: b.fields ?? {} });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return uploadError(e, req);
  }
}
