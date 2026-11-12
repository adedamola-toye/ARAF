import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { baseCtx } from "../../../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { readModelImage } from "@/server/altphones/catalogue";

/** Catalogue photo for signed-in staff (private object storage; never publicly addressable). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: false });
  if (r.status !== "ok") return new NextResponse("Sign in required", { status: 401 });
  const { id } = await params;
  const img = await readModelImage(id).catch(() => null);
  if (!img) return new NextResponse("Not found", { status: 404 });
  if ("staticPath" in img) return NextResponse.redirect(new URL(img.staticPath, req.nextUrl.origin), 302);
  if (req.headers.get("if-none-match") === `"${img.etag}"`) return new NextResponse(null, { status: 304 });
  return new NextResponse(new Uint8Array(img.data), {
    headers: { "content-type": img.mime, "cache-control": "private, max-age=300", etag: `"${img.etag}"`, "x-content-type-options": "nosniff" },
  });
}
