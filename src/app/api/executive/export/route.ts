import { NextResponse } from "next/server";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { executiveAccess, executiveOverview } from "@/server/executive";
import { altphonesAccess } from "@/server/altphones/views";
import { auditOutsideTx } from "@/server/audit";
import { toCsv } from "@/lib/csv";
import { koboToNairaString } from "@/server/money";

/** CSV exports for the executive and Altphones operations views. No customer identifiers (BVN, NIN, account, phone) are exported. */
export async function GET(req: Request) {
  const { session, ctx } = await requireUser();
  const dataset = new URL(req.url).searchParams.get("dataset") ?? "";
  const exec = await executiveAccess(db, session.staffId);
  const alt = await altphonesAccess(db, session.staffId);
  const opsDatasets = ["locations", "bpm", "historical"];
  if (!exec && !(opsDatasets.includes(dataset) && (alt.pm || alt.admin || alt.reviewer))) return new NextResponse("Forbidden", { status: 403 });
  const naira = (k: number | string) => koboToNairaString(Number(k));
  let headers: string[] = [];
  let rows: (string | number | null)[][] = [];
  if (dataset === "historical") {
    const r = (
      await db.query(
        `SELECT h.ref, l.name AS location, h.source_sheet, h.application_status, h.repayment_status, h.repayment_evidence, h.units, h.tenor_months,
                h.total_obligation_kobo, h.amount_repaid_kobo, h.outstanding_kobo, h.arrears_kobo, to_char(h.as_at,'YYYY-MM-DD') AS as_at
           FROM altphones_historical_accounts h LEFT JOIN locations l ON l.id = h.location_id ORDER BY h.ref`,
      )
    ).rows;
    headers = ["Historical reference", "Location", "Source sheet", "Application status", "Repayment status", "Evidence", "Units", "Tenor (months)", "Total obligation (NGN)", "Repaid (NGN)", "Outstanding (NGN)", "Arrears (NGN)", "As at"];
    rows = r.map((x) => [x.ref, x.location, x.source_sheet, x.application_status, x.repayment_status, x.repayment_evidence, x.units, x.tenor_months, x.total_obligation_kobo === null ? "" : naira(x.total_obligation_kobo), naira(x.amount_repaid_kobo), naira(x.outstanding_kobo), naira(x.arrears_kobo), x.as_at]);
  } else {
    const o = await executiveOverview(db, ctx.now);
    if (dataset === "locations") {
      headers = ["Location", "State", "Type", "Altphones sales", "Altphones completed", "Retail requests", "Phones in stock", "Reserved"];
      rows = o.locations.map((l) => [l.name, l.state, l.type, l.alt_sales, l.alt_completed, l.retail, l.physical, l.reserved]);
    } else if (dataset === "bpm") {
      headers = ["BPM", "Decided", "Approved", "Returned", "Rejected", "Waiting now", "Average hours to decide"];
      rows = o.bpm.map((b) => [b.name, b.decided, b.approved, b.returned, b.rejected, b.waiting, b.avg_hours ?? ""]);
    } else if (dataset === "productivity") {
      headers = ["Staff", "Requests submitted (30 days)", "Decisions (30 days)", "Altphones sales (30 days)"];
      rows = o.productivity.map((p) => [p.name, p.submitted, p.decisions, p.alt_sales]);
    } else if (dataset === "kyc") {
      headers = ["Request", "Team Lead", "Reason given", "Skipped at (UTC)"];
      rows = o.kyc.map((k) => [k.ref, k.team_lead, k.reason, new Date(k.decided_at).toISOString()]);
    } else if (dataset === "queues") {
      headers = ["Stage", "Open", "Unassigned", "Oldest since (UTC)"];
      rows = o.queues.map((q) => [q.stage, q.n, q.unassigned, new Date(q.oldest).toISOString()]);
    } else return new NextResponse("Unknown dataset", { status: 404 });
  }
  await auditOutsideTx(ctx, { action: "REPORT_EXPORTED", details: { dataset, rows: rows.length, view: exec ? "EXECUTIVE" : "ALTPHONES_OPERATIONS" } });
  return new NextResponse(toCsv(headers, rows), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="araf-${dataset}-${ctx.now.toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" },
  });
}
