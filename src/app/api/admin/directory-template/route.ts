import { NextResponse } from "next/server";
import { requireRole } from "../../../_lib/auth";
import { DIRECTORY_TEMPLATE_CSV } from "@/server/domain/directory";

export async function GET() {
  await requireRole(["SUPER_ADMIN"]);
  return new NextResponse("﻿" + DIRECTORY_TEMPLATE_CSV, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="bank-directory-template.csv"', "Cache-Control": "no-store" },
  });
}
