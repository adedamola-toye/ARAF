import { NextResponse, type NextRequest } from "next/server";
import { putChunk } from "@/server/uploads";
import { uploadCtx, uploadError } from "../../../_lib";

/** One piece of the file (raw bytes, below the platform's request limit). */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; n: string }> }) {
  const ctx = await uploadCtx(req);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { id, n } = await params;
    const data = Buffer.from(await req.arrayBuffer());
    await putChunk(ctx, id, Number(n), data);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return uploadError(e, req);
  }
}
