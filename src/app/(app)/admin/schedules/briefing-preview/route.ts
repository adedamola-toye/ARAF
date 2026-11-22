import type { NextRequest } from "next/server";
import { requireRole } from "../../../../_lib/auth";
import { db } from "@/server/db";
import { previewBriefing } from "@/server/jobs/briefing";

/** Super Admin preview of an officer's Weekly Performance Briefing, rendered exactly as emailed. Not sent. */
export async function GET(req: NextRequest) {
  await requireRole(["SUPER_ADMIN"]);
  const id = req.nextUrl.searchParams.get("staff") ?? "";
  const pv = /^[0-9a-f-]{36}$/i.test(id) ? await previewBriefing(db, id, new Date()) : null;
  if (!pv) return new Response("Choose a member of staff.", { status: 404 });
  return new Response(pv.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:" } });
}
