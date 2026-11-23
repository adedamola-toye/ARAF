import { NextResponse, type NextRequest } from "next/server";
import { abortUpload, uploadStatus } from "@/server/uploads";
import { uploadCtx, uploadError } from "../_lib";

/** Which pieces have arrived (to resume after a dropped connection). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await uploadCtx(req);
  if (ctx instanceof NextResponse) return ctx;
  try {
    return NextResponse.json({ ok: true, ...(await uploadStatus(ctx, (await params).id)) });
  } catch (e) {
    return uploadError(e, req);
  }
}

/** Cancel: the pieces already sent are deleted. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await uploadCtx(req);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await abortUpload(ctx, (await params).id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return uploadError(e, req);
  }
}
