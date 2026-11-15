import { NextResponse } from "next/server";
import { requireUser } from "../../../../../_lib/auth";
import { db } from "@/server/db";
import { importErrorReport } from "@/server/altphones/imports";
import { DomainError } from "@/server/errors";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireUser();
  try {
    const r = await importErrorReport(db, ctx, (await params).id);
    return new NextResponse(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${r.filename.replace(/[^\w.-]+/g, "_")}"`, "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof DomainError) return new NextResponse(e.message, { status: e.code === "FORBIDDEN" ? 403 : 404 });
    throw e;
  }
}
