import { NextResponse, type NextRequest } from "next/server";
import { completeUpload } from "@/server/uploads";
import { uploadCtx, uploadError } from "../../_lib";

// Reassembling and scanning a large statement can take longer than the default function limit.
export const maxDuration = 60;

/** Reassemble the pieces and apply the normal document rules (type, scan, versioning, audit). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await uploadCtx(req);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const r = await completeUpload(ctx, (await params).id);
    if (r.scanStatus === "REJECTED") return NextResponse.json({ ok: false, error: "The file failed the malware scan and was quarantined. It will not be used." }, { status: 422 });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return uploadError(e, req);
  }
}
