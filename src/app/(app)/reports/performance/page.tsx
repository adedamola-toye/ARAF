import Link from "next/link";
import { requireRole } from "../../../_lib/auth";
import { db } from "@/server/db";
import { formatKobo } from "@/server/money";
import { PageHeader } from "@/components/PageHeader";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { TrendChart } from "./TrendChart";
import { OfficerTable } from "./OfficerTable";
import {
  ALT_DIMENSIONS, altActionsByPerformer, altphonesFacts, actionsByPerformer, DEFAULT_ORDER, FIN_DIMENSIONS, financingFacts, groupAlt, groupFacts, officerPerformance, reportScope, REPORT_ROLES, trend,
  type AltDim, type FinDim, type FinFilters,
} from "@/server/performance-report";

export const metadata = { title: "Performance Overview" };

type SP = Record<string, string | undefined>;
const FILTER_KEYS = ["from", "to", "product", "category", "status", "creditException", "invoice", "sla", "disbursed"] as const;
/** Default drill-down: Overall → business line → Unit Head / RBE → product → officer → location → facility. */
const BUSINESS_LINE_ORDER: FinDim[] = ["segment", "reportingHead", "product", "officer", "location", "facility"];
/** Dimension filters: the first four are always shown, the rest under "More filters". */
const DIM_FILTERS = [
  ["segment", "Business line"],
  ["region", "Region"],
  ["product", "Product"],
  ["reportingHead", "Unit Head / RBE"],
  ["businessUnit", "Business unit"],
  ["unitHead", "Unit Head (reporting line)"],
  ["rbe", "RBE"],
  ["officer", "Officer"],
  ["location", "Location"],
  ["status", "Status"],
] as const satisfies readonly (readonly [FinDim, string])[];

function qs(sp: SP, patch: Record<string, string | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) p.set(k, v);
  return `?${p.toString()}`;
}
const hours = (h: number | null) => (h === null ? "—" : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`);
const k = (n: number) => formatKobo(n).replace(/\.00$/, "");

export default async function Performance({ searchParams }: { searchParams: Promise<SP> }) {
  const { session } = await requireRole([...REPORT_ROLES]);
  const sp = await searchParams;
  const scope = await reportScope(db, session.staffId);
  const view = sp.view === "altphones" ? "altphones" : sp.view === "actions" ? "actions" : "financing";
  const tabs: [string, string][] = [["financing", "Financing products"], ["altphones", "AltPhones (by person)"], ["actions", "Actions by person"]];
  const header = (
    <>
      <PageHeader
        eyebrow="Reports"
        title="Performance Overview"
        intro={`Monitor financing activity, approval efficiency and portfolio performance across ARAF.${scope.kind === "STAFF" ? ` Showing ${scope.label}.` : ""}`}
      />
      <nav className="tabs" aria-label="Report">
        {tabs.map(([v, l]) => (
          <Link key={v} className="tab" href={qs({ from: sp.from, to: sp.to }, { view: v })} aria-current={view === v ? "page" : undefined}>
            {l}
          </Link>
        ))}
      </nav>
    </>
  );
  if (scope.kind === "NONE") {
    return (
      <>
        {header}
        <div className="alert alert-info">{scope.reason}</div>
      </>
    );
  }
  const filters: FinFilters = Object.fromEntries(FILTER_KEYS.map((key) => [key, sp[key] || null])) as FinFilters;
  filters.dims = Object.fromEntries(DIM_FILTERS.map(([d]) => [d, sp[`d_${d}`] || null]).filter(([, v]) => v));
  // Filter options come from the facilities in scope for the period (before the other filters apply).
  const optionFacts = view === "altphones" ? [] : await financingFacts(db, scope, { from: sp.from, to: sp.to });
  const opts = (d: FinDim) => [...new Set(optionFacts.map((x) => String(x[d])))].filter((v) => v && v !== "—").sort();
  const activeMore = [...DIM_FILTERS.slice(4).map(([d]) => sp[`d_${d}`]), sp.creditException, sp.invoice, sp.sla, sp.disbursed].filter(Boolean).length;
  const dimSelect = ([d, label]: readonly [FinDim, string]) => (
    <div className="field" key={d}>
      <label htmlFor={`pf-${d}`}>{label}</label>
      <select id={`pf-${d}`} name={`d_${d}`} defaultValue={sp[`d_${d}`] ?? ""}>
        <option value="">All</option>
        {opts(d).map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </div>
  );
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const presets: [string, string, string][] = [
    ["30 days", daysAgo(29), today],
    ["90 days", daysAgo(89), today],
    ["This year", `${today.slice(0, 4)}-01-01`, today],
  ];
  const dateForm = (
    <form className="po-filters" method="get" aria-label="Filters">
      <input type="hidden" name="view" value={view} />
      {sp.order && <input type="hidden" name="order" value={sp.order} />}
      <div className="po-filter-row">
        <fieldset className="po-range">
          <legend>Date range</legend>
          <input type="date" name="from" defaultValue={sp.from ?? ""} aria-label="From" />
          <span aria-hidden="true">–</span>
          <input type="date" name="to" defaultValue={sp.to ?? ""} aria-label="To" />
          <span className="po-presets">
            {presets.map(([l, f, t]) => (
              <Link key={l} href={qs(sp, { from: f, to: t, sel: null })} aria-current={sp.from === f && sp.to === t ? "true" : undefined}>
                {l}
              </Link>
            ))}
          </span>
        </fieldset>
        {view === "financing" && DIM_FILTERS.slice(0, 4).map(dimSelect)}
        <div className="po-filter-actions">
          <button className="btn" type="submit">
            Apply
          </button>
          <Link className="btn btn-ghost" href={qs({}, { view })}>
            Reset
          </Link>
        </div>
      </div>
      {view === "financing" && (
        <details className="po-more" open={activeMore > 0}>
          <summary>More filters{activeMore ? ` (${activeMore})` : ""}</summary>
          <div className="po-filter-row">
            {DIM_FILTERS.slice(4).map(dimSelect)}
            <div className="field">
              <label htmlFor="pf-ce">Credit exception</label>
              <select id="pf-ce" name="creditException" defaultValue={sp.creditException ?? ""}>
                <option value="">Any</option>
                <option value="yes">With exception</option>
                <option value="no">Without</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="pf-inv">Invoice confirmation</label>
              <select id="pf-inv" name="invoice" defaultValue={sp.invoice ?? ""}>
                <option value="">Any</option>
                <option value="pending">Pending</option>
                <option value="completed">Completed</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="pf-sla">SLA</label>
              <select id="pf-sla" name="sla" defaultValue={sp.sla ?? ""}>
                <option value="">Any</option>
                <option value="breached">Breached</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="pf-d">Disbursement</label>
              <select id="pf-d" name="disbursed" defaultValue={sp.disbursed ?? ""}>
                <option value="">Any</option>
                <option value="yes">Disbursed</option>
                <option value="no">Not disbursed</option>
              </select>
            </div>
          </div>
        </details>
      )}
    </form>
  );

  if (view === "altphones") {
    const order = (sp.order ?? "unitHead,location,officer,model").split(",").filter((d): d is AltDim => d in ALT_DIMENSIONS);
    const sel = (sp.sel ?? "").split("|").filter(Boolean);
    let facts = await altphonesFacts(db, scope, { from: sp.from, to: sp.to });
    sel.forEach((v, i) => (facts = facts.filter((x) => String(x[order[i]]) === v)));
    const dim = order[sel.length];
    const performers = await altActionsByPerformer(db, facts.map((x) => x.id));
    return (
      <>
        {header}
        {dateForm}
        <Breadcrumb sp={sp} order={order} sel={sel} labels={ALT_DIMENSIONS} />
        <p className="small">
          <a href={`/api/reports/performance${qs(sp, { view: "altphones", format: "csv" })}`}>Download CSV</a> · drill order:{" "}
          {(["unitHead,location,officer,model", "location,officer,model", "officer,model", "model,location,officer"] as const).map((o, i) => (
            <span key={o}>
              {i > 0 && " · "}
              <Link href={qs({ view: "altphones", from: sp.from, to: sp.to }, { order: o })}>{o.split(",").map((d) => ALT_DIMENSIONS[d as AltDim]).join(" → ")}</Link>
            </span>
          ))}
        </p>
        {dim ? (
          <div className="table-wrap">
            <table className="data small">
              <thead>
                <tr>
                  <th scope="col">{ALT_DIMENSIONS[dim]}</th>
                  <th scope="col" className="num">Transactions</th>
                  <th scope="col" className="num">Completed sales</th>
                  <th scope="col" className="num">Pending</th>
                  <th scope="col" className="num">Down payments</th>
                  <th scope="col" className="num">Financing value</th>
                  <th scope="col" className="num">Stock reserved</th>
                  <th scope="col" className="num">Stock out</th>
                </tr>
              </thead>
              <tbody>
                {groupAlt(facts, dim).map((g) => (
                  <tr key={g.key}>
                    <td>{sel.length + 1 < order.length ? <Link href={qs(sp, { sel: [...sel, g.key].join("|") })}>{g.key}</Link> : g.key}</td>
                    <td className="num">{g.transactions}</td>
                    <td className="num">{g.completed}</td>
                    <td className="num">{g.pending}</td>
                    <td className="num">{k(g.downPaymentKobo)}</td>
                    <td className="num">{k(g.financedKobo)}</td>
                    <td className="num">{g.reserved}</td>
                    <td className="num">{g.stockOut}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data small">
              <thead>
                <tr><th scope="col">Reference</th><th scope="col">Date</th><th scope="col">Officer</th><th scope="col">Location</th><th scope="col">Model</th><th scope="col">Status</th><th scope="col" className="num">Financing</th></tr>
              </thead>
              <tbody>
                {facts.map((x) => (
                  <tr key={x.id}><td>{x.ref}</td><td>{x.date ? new Date(x.date).toISOString().slice(0, 10) : "—"}</td><td>{x.officer}</td><td>{x.location}</td><td>{x.model}</td><td>{x.status}</td><td className="num">{k(x.financedKobo)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h2 style={{ marginTop: "var(--space-5)" }}>Who did what</h2>
        <PerformerTable rows={performers.map((p) => ({ performer: p.performer, what: p.action, n: p.n }))} />
      </>
    );
  }

  const facts0 = await financingFacts(db, scope, filters);
  if (view === "actions") {
    const rows = await actionsByPerformer(db, facts0.map((x) => x.id));
    return (
      <>
        {header}
        {dateForm}
        <p className="small muted">Every review, approval, return, decline, confirmation and booking on the facilities in scope, credited to the person who performed it.</p>
        <PerformerTable rows={rows.map((r) => ({ performer: r.performer, what: `${r.action.replace(/_/g, " ").toLowerCase()} · ${r.stage}`, n: r.n }))} />
      </>
    );
  }

  const order = (sp.order ?? BUSINESS_LINE_ORDER.join(",")).split(",").filter((d): d is FinDim => d in FIN_DIMENSIONS);
  const sel = (sp.sel ?? "").split("|").filter(Boolean);
  let facts = facts0;
  sel.forEach((v, i) => (facts = facts.filter((x) => String(x[order[i]]) === v)));
  const dim = order[sel.length];
  const groups = dim ? groupFacts(facts, dim) : [];
  const total = groupFacts(facts.map((x) => ({ ...x, product: "Total" })), "product")[0];
  const tr = trend(facts, sp.from, sp.to);
  const officers = officerPerformance(facts, (r) => ROLE_LABELS[r as Role] ?? r);
  const maxGroup = Math.max(1, ...groups.map((g) => g.requestedKobo));
  const decided = total ? total.approved + total.declined : 0;
  const ORDERS: { label: string; order: FinDim[] }[] = [
    { label: "Business line", order: BUSINESS_LINE_ORDER },
    { label: "Unit Head", order: DEFAULT_ORDER },
    { label: "RBE", order: ["rbe", "officer", "product", "facility"] },
    { label: "Product", order: ["product", "segment", "officer", "facility"] },
    { label: "Location", order: ["location", "product", "officer", "facility"] },
    { label: "Business unit", order: ["businessUnit", "reportingHead", "officer", "facility"] },
    { label: "Merchant Officers", order: ["moHead", "moLead", "officer", "facility"] },
  ];
  const activeOrder = order.join(",");
  const kpis: { label: string; value: string; note: string; tone?: "warn" }[] = total
    ? [
        { label: "Total requested", value: k(total.requestedKobo), note: `${total.requests} request${total.requests === 1 ? "" : "s"}` },
        { label: "Total approved", value: k(total.approvedKobo), note: `${total.approved} facilit${total.approved === 1 ? "y" : "ies"}${total.requestedKobo ? ` · ${Math.round((100 * total.approvedKobo) / total.requestedKobo)}% of requested` : ""}` },
        { label: "Total disbursed", value: k(total.disbursedKobo), note: `${total.disbursed} facilit${total.disbursed === 1 ? "y" : "ies"}` },
        { label: "Pending requests", value: String(total.pending), note: "In approval, documentation or disbursement" },
        { label: "Declined requests", value: String(total.declined), note: decided ? `${Math.round((100 * total.declined) / decided)}% of decisions` : "No decisions yet" },
        { label: "Avg. approval turnaround", value: hours(total.avgTurnaroundHours), note: "Submission to final approval" },
        { label: "SLA breaches", value: String(total.slaBreaches), note: "Overdue-task reminders sent", tone: total.slaBreaches ? "warn" : undefined },
        { label: "Pending disbursement confirmations", value: String(total.awaitingRmConfirmation), note: total.missingEvidence ? `${total.missingEvidence} without evidence of delivery` : "Awaiting RM confirmation", tone: total.missingEvidence ? "warn" : undefined },
      ]
    : [];
  return (
    <>
      {header}
      {dateForm}
      {kpis.length > 0 ? (
        <section className="po-kpis" aria-label="Executive summary">
          {kpis.map((x) => (
            <div key={x.label} className={`po-kpi${x.value.startsWith("₦") ? " po-kpi-money" : ""}`}>
              <div className="po-kpi-label">{x.label}</div>
              <div className="po-kpi-value">{x.value}</div>
              <div className={`po-kpi-note${x.tone ? " po-warn" : ""}`}>{x.note}</div>
            </div>
          ))}
        </section>
      ) : (
        <div className="alert alert-info">No facilities match the selected filters.</div>
      )}
      <section className="po-panel">
        <TrendChart grain={tr.grain} data={tr.points.map((p) => ({ label: p.label, requested: p.requestedKobo / 100, approved: p.approvedKobo / 100, disbursed: p.disbursedKobo / 100 }))} />
      </section>

      <section className="po-panel" aria-labelledby="po-org">
        <div className="po-panel-head">
          <h2 id="po-org" className="po-h3">Organisational performance</h2>
          <a className="po-link small" href={`/api/reports/performance${qs(sp, { view: "financing", format: "csv" })}`}>Download CSV</a>
        </div>
        <nav className="po-seg" aria-label="Group by">
          {ORDERS.map((o) => (
            <Link key={o.label} href={qs(sp, { view: "financing", order: o.order.join(","), sel: null })} aria-current={activeOrder === o.order.join(",") ? "true" : undefined}>
              {o.label}
            </Link>
          ))}
        </nav>
        <Breadcrumb sp={sp} order={order} sel={sel} labels={FIN_DIMENSIONS} />
        {dim && dim !== "facility" ? (
          <div className="table-wrap">
            <table className="data small po-table">
              <thead>
                <tr>
                  <th scope="col">{FIN_DIMENSIONS[dim]}</th>
                  <th scope="col" className="num">Requests</th>
                  <th scope="col" className="po-share-col">Requested</th>
                  <th scope="col" className="num">Approved</th>
                  <th scope="col" className="num">Disbursed</th>
                  <th scope="col" className="num">Pending</th>
                  <th scope="col" className="num">Declined</th>
                  <th scope="col" className="num">Turnaround</th>
                  <th scope="col" className="num">SLA breaches</th>
                  <th scope="col" className="num">Exceptions</th>
                  <th scope="col" className="num">Invoices pending</th>
                  <th scope="col" className="num">Awaiting RM confirmation</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key}>
                    <td>
                      <Link href={qs(sp, { sel: [...sel, g.key].join("|") })}>{g.key}</Link>
                    </td>
                    <td className="num">{g.requests}</td>
                    <td className="po-share-col">
                      <span className="po-share">
                        <span className="po-share-track" aria-hidden="true">
                          <span className="po-share-bar" style={{ width: `${Math.max(3, (100 * g.requestedKobo) / maxGroup)}%` }} />
                        </span>
                        <span className="num">{k(g.requestedKobo)}</span>
                      </span>
                    </td>
                    <td className="num">{k(g.approvedKobo)}</td>
                    <td className="num">{k(g.disbursedKobo)}</td>
                    <td className="num">{g.pending}</td>
                    <td className="num">{g.declined}</td>
                    <td className="num">{hours(g.avgTurnaroundHours)}</td>
                    <td className="num">{g.slaBreaches || "—"}</td>
                    <td className="num">{g.creditExceptions || "—"}</td>
                    <td className="num">{g.invoicePending || "—"}</td>
                    <td className="num">
                      {g.awaitingRmConfirmation || "—"}
                      {g.missingEvidence ? <span className="po-warn"> ({g.missingEvidence} no evidence)</span> : null}
                    </td>
                  </tr>
                ))}
                {!groups.length && (
                  <tr>
                    <td colSpan={12} className="muted">No facilities match.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data small po-table">
              <thead>
                <tr><th scope="col">Facility</th><th scope="col">Product</th><th scope="col">Business line</th><th scope="col">Originated by</th><th scope="col">Reporting head</th><th scope="col">Location</th><th scope="col">Status</th><th scope="col" className="num">Requested</th><th scope="col" className="num">Disbursed</th></tr>
              </thead>
              <tbody>
                {facts.map((x) => (
                  <tr key={x.id}>
                    <td><Link href={`/requests/${x.id}`}>{x.ref}</Link></td>
                    <td>{x.product}</td>
                    <td>{x.segment}</td>
                    <td>{x.officer}</td>
                    <td>{x.reportingHead}</td>
                    <td>{x.location}</td>
                    <td>{x.status}</td>
                    <td className="num">{k(x.requestedKobo)}</td>
                    <td className="num">{x.disbursed ? k(x.disbursedKobo) : "—"}</td>
                  </tr>
                ))}
                {!facts.length && (
                  <tr><td colSpan={9} className="muted">No facilities match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <OfficerTable
        rows={officers.map((o) => ({
          officer: o.officer, role: o.role, segment: o.segment, businessUnit: o.businessUnit, reportingHead: o.reportingHead, products: o.products, locations: o.locations,
          requests: o.requests, requested: o.requestedKobo / 100, approved: o.approvedKobo / 100, disbursed: o.disbursedKobo / 100, pending: o.pending,
          turnaroundHours: o.avgTurnaroundHours, slaOnTimePercent: o.slaOnTimePercent,
          href: qs(sp, { view: "financing", order: "officer,facility", sel: o.officer }),
        }))}
      />
    </>
  );
}

function Breadcrumb({ sp, order, sel, labels }: { sp: SP; order: string[]; sel: string[]; labels: Record<string, string> }) {
  return (
    <nav aria-label="Drill-down" className="po-crumbs">
      <Link href={qs(sp, { sel: null })}>All</Link>
      {sel.map((v, i) => (
        <span key={i}>
          {" › "}
          <Link href={qs(sp, { sel: sel.slice(0, i + 1).join("|") })}>
            {labels[order[i]]}: {v}
          </Link>
        </span>
      ))}
      {order[sel.length] && <span className="muted"> › by {labels[order[sel.length]].toLowerCase()}</span>}
    </nav>
  );
}

function PerformerTable({ rows }: { rows: { performer: string; what: string; n: number }[] }) {
  return (
    <div className="table-wrap">
      <table className="data small">
        <thead>
          <tr><th scope="col">Person</th><th scope="col">Action</th><th scope="col" className="num">Count</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}><td>{r.performer}</td><td>{r.what}</td><td className="num">{r.n}</td></tr>
          ))}
          {!rows.length && (
            <tr><td colSpan={3} className="muted">No actions recorded.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
