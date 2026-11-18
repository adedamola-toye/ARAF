import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { baseCtx } from "../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { db } from "@/server/db";
import { auditOutsideTx } from "@/server/audit";
import { activeRoles } from "@/server/domain/access";
import { ALT_DIMENSIONS, altphonesFacts, financingFacts, FIN_DIMENSIONS, reportScope, REPORT_ROLES, toCsv, type AltDim, type FinDim, type FinFilters } from "@/server/performance-report";

/** CSV export of the performance report; same scope and filters as the screen. */
export async function GET(req: NextRequest) {
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: true });
  if (r.status !== "ok") return new NextResponse("Session expired. Sign in again.", { status: 401 });
  const s = r.session;
  ctx.actor = { staffId: s.staffId, email: s.email, name: s.fullName, sessionId: s.sessionId, activeRole: s.activeRole };
  const roles = (await activeRoles(db, s.staffId)).map((x) => x.role);
  if (!roles.some((x) => (REPORT_ROLES as readonly string[]).includes(x))) return new NextResponse("Not permitted.", { status: 403 });
  const scope = await reportScope(db, s.staffId);
  const sp = req.nextUrl.searchParams;
  const view = sp.get("view") === "altphones" ? "altphones" : "financing";
  const order = (sp.get("order") ?? "").split(",");
  const sel = (sp.get("sel") ?? "").split("|").filter(Boolean);
  let rows: Record<string, unknown>[];
  if (view === "altphones") {
    let facts = await altphonesFacts(db, scope, { from: sp.get("from"), to: sp.get("to") });
    sel.forEach((v, i) => order[i] in ALT_DIMENSIONS && (facts = facts.filter((x) => String(x[order[i] as AltDim]) === v)));
    rows = facts.map((x) => ({ reference: x.ref, date: x.date, officer: x.officer, officer_role: x.officerRole, location: x.location, unit_head: x.unitHead, model: x.model, status: x.status, down_payment_naira: x.downPaymentKobo / 100, financing_naira: x.financedKobo / 100, completed: x.completed }));
  } else {
    const f = Object.fromEntries(["from", "to", "product", "category", "status", "creditException", "invoice", "sla", "disbursed"].map((k) => [k, sp.get(k)])) as FinFilters;
    let facts = await financingFacts(db, scope, f);
    sel.forEach((v, i) => order[i] in FIN_DIMENSIONS && (facts = facts.filter((x) => String(x[order[i] as FinDim]) === v)));
    rows = facts.map((x) => ({
      facility: x.ref, product: x.product, customer_category: x.category, originating_officer: x.officer, originator_role: x.officerRole, merchant_officer_lead: x.moLead, merchant_officer_head: x.moHead,
      unit_head: x.unitHead, divisional_head: x.division, location: x.location, status: x.status, submitted: x.submittedAt, requested_naira: x.requestedKobo / 100, approved: x.approved,
      approved_naira: x.approvedKobo / 100, disbursed_naira: x.disbursedKobo / 100, sla_breaches: x.slaBreaches, credit_exception: x.creditException, invoice_pending: x.invoicePending,
      invoice_completed: x.invoiceCompleted, awaiting_rm_confirmation: x.awaitingRmConfirmation, missing_acquisition_evidence: x.missingEvidence,
    }));
  }
  await auditOutsideTx(ctx, { action: "REPORT_EXPORTED", details: { report: `performance:${view}`, rows: rows.length, scope: scope.kind } });
  return new NextResponse(toCsv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="araf-performance-${view}.csv"`, "Cache-Control": "private, no-store" } });
}
