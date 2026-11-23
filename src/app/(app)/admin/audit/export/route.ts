import type { NextRequest } from "next/server";
import { requireRole } from "../../../../_lib/auth";
import { db } from "@/server/db";
import { auditRows } from "@/server/audit-query";
import { auditOutsideTx } from "@/server/audit";
import { auditContext, auditLabel, redactDetails } from "@/lib/audit-events";
import { csvCell } from "@/lib/csv";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { formatLagos } from "@/server/time";

/** Readable audit export (same filters as the page), secrets and sensitive identifiers redacted. */
export async function GET(req: NextRequest) {
  const { ctx } = await requireRole(["SUPER_ADMIN", "REPORTING_ADMIN"]);
  const f = Object.fromEntries(req.nextUrl.searchParams.entries());
  const rows = await auditRows(db, f, 20000);
  const stage = (x: string) => STAGE_LABELS[x as Stage] ?? x;
  const head = ["Time (WAT)", "Actor", "Role", "What happened", "Category", "Event code", "Outcome", "Request", "Stage", "Previous → new state and references", "Comment", "Details (redacted)"];
  const lines = [head.map(csvCell).join(",")];
  for (const e of rows) {
    const l = auditLabel(e.action);
    lines.push(
      [
        formatLagos(e.occurred_at),
        e.actor_name ?? e.actor_email ?? "system",
        e.actor_role ? (ROLE_LABELS[e.actor_role as Role] ?? e.actor_role) : "",
        l.label,
        l.category,
        e.action,
        e.outcome,
        e.ref ?? "",
        e.stage ? stage(e.stage) : "",
        auditContext(e.details, stage).join(" · "),
        e.reason ?? "",
        JSON.stringify(redactDetails(e.details)),
      ]
        .map((v) => csvCell(String(v)))
        .join(","),
    );
  }
  await auditOutsideTx(ctx, { action: "REPORT_EXPORT", details: { report: "AUDIT_TRAIL", filters: f, rows: rows.length } });
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="araf-audit-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" },
  });
}
