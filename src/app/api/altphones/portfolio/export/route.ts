import { NextResponse } from "next/server";
import { requireUser } from "../../../../_lib/auth";
import { db } from "@/server/db";
import { auditOutsideTx } from "@/server/audit";
import { toCsv } from "@/lib/csv";
import { koboToNairaString } from "@/server/money";
import { lagosDate } from "@/server/time";
import { ageing, collections, groupBy, inventoryAgainstOpening, portfolioAccess, portfolioFacilities } from "@/server/altphones/portfolio";

/** Altphones portfolio exports. Facility references only: no names, BVN, NIN, phone or account numbers. */
export async function GET(req: Request) {
  const { session, ctx } = await requireUser();
  if (!(await portfolioAccess(db, session.staffId))) return new NextResponse("Forbidden", { status: 403 });
  const dataset = new URL(req.url).searchParams.get("dataset") ?? "";
  const today = lagosDate(ctx.now);
  const naira = (k: number) => koboToNairaString(k);
  let headers: string[] = [];
  let rows: (string | number | null)[][] = [];
  if (dataset === "facilities" || dataset === "arrears") {
    let list = await portfolioFacilities(db, today);
    if (dataset === "arrears") list = list.filter((f) => f.arrearsKobo > 0);
    headers = ["Facility", "Source", "Location", "Officer", "Channel", "Units", "Total repayable (NGN)", "Repaid (NGN)", "Outstanding (NGN)", "Arrears (NGN)", "Instalments overdue", "Days overdue", "Status", "Next due"];
    rows = list.map((f) => [f.ref, f.source === "ARAF" ? "ARAF" : "Historical register", f.location, f.officer, f.channel, f.units, naira(f.totalKobo), naira(f.repaidKobo), naira(f.outstandingKobo), naira(f.arrearsKobo), f.overdueInstalments, f.daysOverdue ?? "", f.bucket, f.nextDue ?? ""]);
  } else if (dataset === "ageing") {
    headers = ["Status", "ARAF", "Historical", "Total", "Outstanding (NGN)", "Arrears (NGN)"];
    rows = ageing(await portfolioFacilities(db, today)).map((a) => [a.label, a.araf, a.historical, a.total, naira(a.outstandingKobo), naira(a.arrearsKobo)]);
  } else if (dataset === "collections") {
    headers = ["Month", "Due (NGN)", "Collected (NGN)", "Collection rate (%)"];
    rows = (await collections(db, today)).map((m) => [m.month, naira(m.expectedKobo), naira(m.collectedKobo), m.rate ?? ""]);
  } else if (dataset.startsWith("performance-")) {
    const by = dataset.slice("performance-".length);
    if (!["channel", "location", "officer"].includes(by)) return new NextResponse("Unknown dataset", { status: 400 });
    const g = groupBy(await portfolioFacilities(db, today), (f) => (by === "location" ? f.location : by === "officer" ? f.officer : f.channel));
    headers = [by[0].toUpperCase() + by.slice(1), "Facilities", "Units", "Financed (NGN)", "Outstanding (NGN)", "In arrears", "Arrears (NGN)", "Fully repaid"];
    rows = g.map((r) => [r.key, r.facilities, r.units, naira(r.financedKobo), naira(r.outstandingKobo), r.inArrears, naira(r.arrearsKobo), r.fullyRepaid]);
  } else if (dataset === "inventory") {
    headers = ["Location", "State", "Type", "Opening", "Received", "Issued", "Adjusted", "On hand", "Reserved"];
    rows = (await inventoryAgainstOpening(db)).map((r) => [r.location, r.state, r.type, r.opening, r.received, r.issued, r.adjusted, r.physical, r.reserved]);
  } else return new NextResponse("Unknown dataset", { status: 400 });
  await auditOutsideTx(ctx, { action: "ALTPHONES_PORTFOLIO_EXPORTED", details: { dataset, rows: rows.length } });
  return new NextResponse(toCsv(headers, rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="altphones-${dataset}-${today}.csv"` } });
}
