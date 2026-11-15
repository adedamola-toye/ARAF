import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { ageing, collections, groupBy, inventoryAgainstOpening, migrationProgress, portfolioAccess, portfolioFacilities, type GroupRow } from "@/server/altphones/portfolio";
import { formatNaira } from "@/lib/altphones";
import { lagosDate } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Altphones portfolio" };

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 1000) / 10}%` : "—");
const Export = ({ dataset }: { dataset: string }) => (
  <a className="btn btn-ghost btn-sm" href={`/api/altphones/portfolio/export?dataset=${dataset}`}>
    Export CSV
  </a>
);

function GroupTable({ rows, label, caption }: { rows: GroupRow[]; label: string; caption: string }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{label}</th>
            <th scope="col" className="num">Facilities</th>
            <th scope="col" className="num">Units</th>
            <th scope="col" className="num">Financed</th>
            <th scope="col" className="num">Outstanding</th>
            <th scope="col" className="num">In arrears</th>
            <th scope="col" className="num">Arrears rate</th>
            <th scope="col" className="num">Fully repaid</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.key}</th>
              <td className="num">{r.facilities}</td>
              <td className="num">{r.units}</td>
              <td className="num">{formatNaira(r.financedKobo)}</td>
              <td className="num">{formatNaira(r.outstandingKobo)}</td>
              <td className="num">{r.inArrears ? `${r.inArrears} · ${formatNaira(r.arrearsKobo)}` : "0"}</td>
              <td className="num">{pct(r.inArrears, r.facilities - r.fullyRepaid)}</td>
              <td className="num">{r.fullyRepaid}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={8} className="muted">
                No facilities yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default async function Portfolio({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { session } = await requireUser();
  if (!(await portfolioAccess(db, session.staffId))) redirect("/forbidden");
  const view = (await searchParams).view === "location" || (await searchParams).view === "officer" ? (await searchParams).view! : "channel";
  const today = lagosDate(new Date());
  const [list, months, stock, migration] = await Promise.all([portfolioFacilities(db, today), collections(db, today), inventoryAgainstOpening(db), migrationProgress(db)]);
  const open = list.filter((f) => f.bucket !== "CANCELLED" && f.bucket !== "FULLY_REPAID");
  const arrearsList = list.filter((f) => f.arrearsKobo > 0).sort((a, b) => b.overdueInstalments - a.overdueInstalments || b.arrearsKobo - a.arrearsKobo);
  const thisMonth = months[months.length - 1];
  const last = months.filter((m) => m.expectedKobo > 0);
  const total = (k: "opening" | "received" | "issued" | "adjusted" | "physical" | "reserved") => stock.reduce((s, r) => s + r[k], 0);
  const groups = groupBy(list, (f) => (view === "location" ? f.location : view === "officer" ? f.officer : f.channel));
  return (
    <>
      <PageHeader
        eyebrow="Altphones"
        title="Portfolio and collections"
        intro={`Facilities sold through ARAF, positioned today (${today}) from their schedules and the repayments recorded, together with the verified historical register (figures as at each account's last reconciliation). Exports carry facility references only.`}
      />
      <div className="metric-grid" style={{ marginBottom: "var(--space-5)" }}>
        <div className="metric">
          <div className="k">Open facilities</div>
          <div className="v">{open.length}</div>
          <span className="small muted">
            {open.filter((f) => f.source === "ARAF").length} ARAF · {open.filter((f) => f.source === "HISTORICAL").length} historical
          </span>
        </div>
        <div className="metric">
          <div className="k">Outstanding</div>
          <div className="v">{formatNaira(open.reduce((s, f) => s + f.outstandingKobo, 0))}</div>
        </div>
        <div className="metric">
          <div className="k">In arrears</div>
          <div className="v">{arrearsList.length}</div>
          <span className="small muted">{formatNaira(arrearsList.reduce((s, f) => s + f.arrearsKobo, 0))} overdue</span>
        </div>
        <div className="metric">
          <div className="k">Collected this month</div>
          <div className="v">{thisMonth.rate === null ? "—" : `${thisMonth.rate}%`}</div>
          <span className="small muted">
            {formatNaira(thisMonth.collectedKobo)} of {formatNaira(thisMonth.expectedKobo)} due
          </span>
        </div>
      </div>

      <div className="stack">
        <section className="card" aria-labelledby="h-age">
          <div className="card-head">
            <h2 id="h-age">Portfolio by repayment status</h2>
            <Export dataset="facilities" />
          </div>
          <div className="table-wrap">
            <table className="data">
              <caption className="sr-only">Facilities by repayment status and arrears ageing</caption>
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">ARAF</th>
                  <th scope="col" className="num">Historical</th>
                  <th scope="col" className="num">Total</th>
                  <th scope="col" className="num">Outstanding</th>
                  <th scope="col" className="num">Arrears</th>
                </tr>
              </thead>
              <tbody>
                {ageing(list).map((a) => (
                  <tr key={a.bucket}>
                    <th scope="row">{a.label}</th>
                    <td className="num">{a.araf}</td>
                    <td className="num">{a.historical}</td>
                    <td className="num">{a.total}</td>
                    <td className="num">{formatNaira(a.outstandingKobo)}</td>
                    <td className="num">{formatNaira(a.arrearsKobo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" aria-labelledby="h-arr">
          <div className="card-head">
            <h2 id="h-arr">Facilities in arrears ({arrearsList.length})</h2>
            <Export dataset="arrears" />
          </div>
          <p className="small muted" style={{ marginTop: 0 }}>
            Oldest arrears first. Open an ARAF facility to record a repayment; historical accounts are updated through the repayments file.
          </p>
          <div className="table-wrap">
            <table className="data">
              <caption className="sr-only">Facilities in arrears</caption>
              <thead>
                <tr>
                  <th scope="col">Facility</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Location</th>
                  <th scope="col">Officer</th>
                  <th scope="col" className="num">Overdue</th>
                  <th scope="col" className="num">Arrears</th>
                  <th scope="col" className="num">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {arrearsList.slice(0, 100).map((f) => (
                  <tr key={f.id}>
                    <th scope="row">{f.source === "ARAF" ? <Link href={`/altphones/applications/${f.id}`}>{f.ref}</Link> : f.ref}</th>
                    <td>{f.customer ?? "—"}</td>
                    <td>{f.location}</td>
                    <td>{f.officer}</td>
                    <td className="num">
                      {f.overdueInstalments} instalment{f.overdueInstalments === 1 ? "" : "s"}
                      {f.daysOverdue ? ` · ${f.daysOverdue} days` : ""}
                    </td>
                    <td className="num">{formatNaira(f.arrearsKobo)}</td>
                    <td className="num">{formatNaira(f.outstandingKobo)}</td>
                  </tr>
                ))}
                {!arrearsList.length && (
                  <tr>
                    <td colSpan={7} className="muted">
                      No facility is in arrears.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {arrearsList.length > 100 && <p className="small muted">Showing the 100 oldest. Export the CSV for the full list.</p>}
        </section>

        <section className="card" aria-labelledby="h-col">
          <div className="card-head">
            <h2 id="h-col">Monthly collections</h2>
            <Export dataset="collections" />
          </div>
          <p className="small muted" style={{ marginTop: 0 }}>
            Instalments due in each month against repayments received in it. {last.length ? `Average collection rate over the months shown: ${pct(last.reduce((s, m) => s + m.collectedKobo, 0), last.reduce((s, m) => s + m.expectedKobo, 0))}.` : ""}
          </p>
          <div className="table-wrap">
            <table className="data">
              <caption className="sr-only">Expected and collected repayments by month</caption>
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col" className="num">Due</th>
                  <th scope="col" className="num">Collected</th>
                  <th scope="col" className="num">Collection rate</th>
                </tr>
              </thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m.month}>
                    <th scope="row">{m.month}</th>
                    <td className="num">{formatNaira(m.expectedKobo)}</td>
                    <td className="num">{formatNaira(m.collectedKobo)}</td>
                    <td className="num">{m.rate === null ? "—" : `${m.rate}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" aria-labelledby="h-perf">
          <div className="card-head">
            <h2 id="h-perf">Performance</h2>
            <Export dataset={`performance-${view}`} />
          </div>
          <nav className="tabs" aria-label="Group by">
            {(["channel", "location", "officer"] as const).map((v) => (
              <Link key={v} href={`/altphones/portfolio?view=${v}`} className="tab" aria-current={view === v ? "page" : undefined}>
                By {v}
              </Link>
            ))}
          </nav>
          <GroupTable rows={groups} label={view === "location" ? "Location" : view === "officer" ? "Officer" : "Channel"} caption={`Performance by ${view}`} />
        </section>

        <section className="card" aria-labelledby="h-inv">
          <div className="card-head">
            <h2 id="h-inv">Inventory against the opening count</h2>
            <Export dataset="inventory" />
          </div>
          <p className="small muted" style={{ marginTop: 0 }}>
            Opening {total("opening")} + received {total("received")} − issued {total("issued")} {total("adjusted") >= 0 ? "+" : "−"} adjustments {Math.abs(total("adjusted"))} = {total("physical")} on hand ({total("reserved")} reserved). Zero-stock locations are included.
          </p>
          <div className="table-wrap">
            <table className="data">
              <caption className="sr-only">Stock by location against the opening count</caption>
              <thead>
                <tr>
                  <th scope="col">Location</th>
                  <th scope="col">State</th>
                  <th scope="col" className="num">Opening</th>
                  <th scope="col" className="num">Received</th>
                  <th scope="col" className="num">Issued</th>
                  <th scope="col" className="num">Adjusted</th>
                  <th scope="col" className="num">On hand</th>
                  <th scope="col" className="num">Reserved</th>
                </tr>
              </thead>
              <tbody>
                {stock.map((r) => (
                  <tr key={`${r.state}-${r.location}`}>
                    <th scope="row">{r.location}</th>
                    <td>{r.state}</td>
                    <td className="num">{r.opening}</td>
                    <td className="num">{r.received}</td>
                    <td className="num">{r.issued}</td>
                    <td className="num">{r.adjusted}</td>
                    <td className="num">{r.physical}</td>
                    <td className="num">{r.reserved}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" aria-labelledby="h-mig">
          <div className="card-head">
            <h2 id="h-mig">Historical migration</h2>
          </div>
          <p style={{ margin: 0 }}>
            {migration.publishedAccounts} verified historical accounts published; {migration.pendingRecords} of {migration.totalRecords} register records still in batches awaiting review or approval.{" "}
            {migration.batches.length > 0 && `Batches: ${migration.batches.map((b) => `${b.n} ${b.status.toLowerCase()}`).join(", ")}.`} Unverified records are not counted in this report.
          </p>
        </section>
      </div>
    </>
  );
}
