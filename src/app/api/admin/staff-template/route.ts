import { NextResponse } from "next/server";
import { requireRole } from "../../../_lib/auth";
import { STAFF_TEMPLATE_CSV } from "@/server/domain/admin";

export async function GET() {
  await requireRole(["SUPER_ADMIN"]);
  return new NextResponse("﻿" + STAFF_TEMPLATE_CSV, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="staff-bulk-upload-template.csv"', "Cache-Control": "no-store" },
  });
}
