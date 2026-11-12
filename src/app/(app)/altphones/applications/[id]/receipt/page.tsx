import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../../../../_lib/auth";
import { db } from "@/server/db";
import { DomainError } from "@/server/errors";
import { formatLagos } from "@/server/time";
import { viewableApp, type AltApp } from "@/server/altphones/core";
import { formatNaira } from "@/lib/altphones";
import { ScheduleTable, TermsTable } from "../../../ui";
import { PrintButton } from "./PrintButton";

export const metadata = { title: "Altphones record" };

/** Printable outright receipt or credit completion record. */
export default async function Receipt({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requireUser();
  let app: AltApp;
  try {
    ({ app } = await viewableApp(ctx, db, id));
  } catch (e) {
    if (e instanceof DomainError) redirect("/forbidden");
    throw e;
  }
  if (!["COMPLETED", "DISBURSED"].includes(app.status)) redirect(`/altphones/applications/${id}`);
  const [pay, locs, officer, schedule] = await Promise.all([
    db.query("SELECT reference, amount_kobo, verified_at FROM altphones_payments WHERE application_id = $1 AND status = 'SUCCESS'", [app.id]).then((r) => r.rows[0]),
    db.query<{ id: string; name: string }>("SELECT id, name FROM locations WHERE id = ANY($1)", [[app.origin_location_id, app.supply_location_id].filter(Boolean)]).then((r) => new Map(r.rows.map((x) => [x.id, x.name]))),
    app.originator_id ? db.query<{ full_name: string }>("SELECT full_name FROM staff WHERE id = $1", [app.originator_id]).then((r) => r.rows[0]?.full_name) : null,
    db.query("SELECT seq, to_char(due_date, 'YYYY-MM-DD') AS due_date, amount_kobo, basis FROM altphones_schedule WHERE application_id = $1 ORDER BY seq", [app.id]).then((r) => r.rows),
  ]);
  const outright = app.kind === "OUTRIGHT";
  const rows: [string, string][] = [
    [outright ? "Receipt number" : "Facility reference", outright ? (app.receipt_number ?? "—") : app.ref],
    ["Sale reference", app.ref],
    ["Date", formatLagos(app.completed_at)],
    ["Customer", app.customer_name ?? "—"],
    ["Phone", app.model_name ?? "—"],
    ["IMEI", app.imei ?? "—"],
    [outright ? "Amount paid" : "Down payment", pay ? formatNaira(pay.amount_kobo) : app.legacy ? "Legacy record" : "—"],
    ["Payment reference", pay?.reference ?? "—"],
    ["Originating location", locs.get(app.origin_location_id) ?? "—"],
    ["Supplied from", locs.get(app.supply_location_id) ?? "—"],
    ["Officer", officer ?? app.legacy_officer ?? "—"],
  ];
  return (
    <div className="alt-receipt">
      <div className="row no-print" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <Link href={`/altphones/applications/${app.id}`}>← Back to the application</Link>
        <PrintButton />
      </div>
      <article className="card alt-receipt-card">
        <p className="eyebrow">The Alternative Bank · Altphones</p>
        <h1>{outright ? "Sales receipt" : "Facility completion record"}</h1>
        <dl className="alt-kv">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className={k === "IMEI" || k.includes("reference") || k.includes("number") ? "mono" : undefined}>{v}</dd>
            </div>
          ))}
        </dl>
        {!outright && (
          <>
            <h2 className="alt-side-h">Financing terms</h2>
            <TermsTable app={app} />
            <h2 className="alt-side-h">Repayment schedule</h2>
            <ScheduleTable rows={schedule} />
            <p className="small muted">
              Repayment mandates: Paystack Direct Debit {app.dd_reference ?? "—"} ({app.dd_status === "ACTIVE" ? "verified" : app.dd_status.toLowerCase()}); Alternative Bank account {app.ab_account_number ?? "—"} internal mandate{" "}
              {app.internal_mandate_confirmed_at ? "Officer Confirmed" : "not recorded"}.
            </p>
          </>
        )}
        {app.legacy && <p className="small muted">Legacy / Imported record ({app.legacy_ref}).</p>}
      </article>
    </div>
  );
}
