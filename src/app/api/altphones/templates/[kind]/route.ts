import { NextResponse } from "next/server";
import { requireUser } from "../../../../_lib/auth";
import { TEMPLATES, type ImportKind } from "@/server/altphones/imports";

export async function GET(_req: Request, { params }: { params: Promise<{ kind: string }> }) {
  await requireUser();
  const kind = (await params).kind.toUpperCase() as ImportKind;
  const csv = TEMPLATES[kind];
  if (!csv) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="altphones-${kind.toLowerCase()}-template.csv"` } });
}
