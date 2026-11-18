import Link from "next/link";
import { requireRole } from "../../../_lib/auth";
import { db } from "@/server/db";
import { formatKobo } from "@/server/money";
import { PageHeader } from "@/components/PageHeader";
import {
  ALT_DIMENSIONS, altActionsByPerformer, altphonesFacts, actionsByPerformer, DEFAULT_ORDER, FIN_DIMENSIONS, financingFacts, groupAlt, groupFacts, reportScope, REPORT_ROLES,
  type AltDim, type FinDim, type FinFilters,
} from "@/server/performance-report";

export const metadata = { title: "Performance reports" };

type SP = Record<string, string | undefined>;
const FILTER_KEYS = ["from", "to", "product", "category", "status", "creditException", "invoice", "sla", "disbursed"] as const;

function qs(sp: SP, patch: Record<string, string | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) p.set(k, v);
  return `?${p.toString()}`;
}
const hours = (h: number | null) => (h === null ? "—" : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`);
const k = (n: number) => formatKobo(n);

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
        title="Performance"
        intro={`Drill down by Unit Head, product, officer, location and facility, in any order. Each facility is counted once per row, credited to the officer who originated it; reviewers' work is in Actions by person.${scope.kind === "STAFF" ? ` Showing ${scope.label}.` : ""}`}
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
  const dateForm = (
    <form className="filters" method="get">
      <input type="hidden" name="view" value={view} />
      {sp.order && <input type="hidden" name="order" value={sp.order} />}
      <div className="field">
        <label htmlFor="pf-from">From</label>
        <input id="pf-from" type="date" name="from" defaultValue={sp.from ?? ""} />
      </div>
      <div className="field">
        <label htmlFor="pf-to">To</label>
        <input id="pf-to" type="date" name="to" defaultValue={sp.to ?? ""} />
      </div>
      {view === "financing" && (
        <>
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
        </>
      )}
      <div className="field">
        <span className="sr-only">Apply</span>
        <button className="btn" type="submit">
          Apply
        </button>
      </div>
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

  const order = (sp.order ?? DEFAULT_ORDER.join(",")).split(",").filter((d): d is FinDim => d in FIN_DIMENSIONS);
  const sel = (sp.sel ?? "").split("|").filter(Boolean);
  let facts = facts0;
  sel.forEach((v, i) => (facts = facts.filter((x) => String(x[order[i]]) === v)));
  const dim = order[sel.length];
  const groups = dim ? groupFacts(facts, dim) : [];
  const total = groupFacts(facts.map((x) => ({ ...x, product: "Total" })), "product")[0];
  const ORDERS: FinDim[][] = [DEFAULT_ORDER, ["product", "unitHead", "officer", "facility"], ["location", "product", "officer", "facility"], ["division", "unitHead", "product", "officer", "facility"], ["moHead", "moLead", "officer", "facility"]];
  return (
    <>
      {header}
      {dateForm}
      <Breadcrumb sp={sp} order={order} sel={sel} labels={FIN_DIMENSIONS} />
      <p className="small">
        <a href={`/api/reports/performance${qs(sp, { view: "financing", format: "csv" })}`}>Download CSV</a> · drill order:{" "}
        {ORDERS.map((o, i) => (
          <span key={o.join()}>
            {i > 0 && " · "}
            <Link href={qs(Object.fromEntries(FILTER_KEYS.map((x) => [x, sp[x]])), { view: "financing", order: o.join(",") })}>{o.map((d) => FIN_DIMENSIONS[d]).join(" → ")}</Link>
          </span>
        ))}
      </p>
      {total && (
        <div className="metric-grid" style={{ marginBottom: "var(--space-4)" }}>
          {(
            [
              ["Requests", String(total.requests)],
              ["Requested", k(total.requestedKobo)],
              ["Approved", `${total.approved} · ${k(total.approvedKobo)}`],
              ["Disbursed", `${total.disbursed} · ${k(total.disbursedKobo)}`],
              ["Completed / declined / pending", `${total.completed} / ${total.declined} / ${total.pending}`],
              ["Avg. approval turnaround", hours(total.avgTurnaroundHours)],
              ["SLA breaches", String(total.slaBreaches)],
              ["Invoice confirmations pending / done", `${total.invoicePending} / ${total.invoiceCompleted}`],
              ["SeedFi exceptions", String(total.creditExceptions)],
              ["Awaiting RM confirmation (missing evidence)", `${total.awaitingRmConfirmation} (${total.missingEvidence})`],
            ] as [string, string][]
          ).map(([l, v]) => (
            <div key={l} className="metric">
              <div className="k">{l}</div>
              <div className="v">{v}</div>
            </div>
          ))}
        </div>
      )}
      {dim && dim !== "facility" ? (
        <div className="table-wrap">
          <table className="data small">
            <thead>
              <tr>
                <th scope="col">{FIN_DIMENSIONS[dim]}</th>
                <th scope="col" className="num">Requests</th>
                <th scope="col" className="num">Requested</th>
                <th scope="col" className="num">Approved</th>
                <th scope="col" className="num">Disbursed</th>
                <th scope="col" className="num">Completed</th>
                <th scope="col" className="num">Declined</th>
                <th scope="col" className="num">Pending</th>
                <th scope="col" className="num">Turnaround</th>
                <th scope="col" className="num">SLA breaches</th>
                <th scope="col" className="num">Invoices pending</th>
                <th scope="col" className="num">SeedFi exceptions</th>
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
                  <td className="num">{k(g.requestedKobo)}</td>
                  <td className="num">{k(g.approvedKobo)}</td>
                  <td className="num">{k(g.disbursedKobo)}</td>
                  <td className="num">{g.completed}</td>
                  <td className="num">{g.declined}</td>
                  <td className="num">{g.pending}</td>
                  <td className="num">{hours(g.avgTurnaroundHours)}</td>
                  <td className="num">{g.slaBreaches}</td>
                  <td className="num">{g.invoicePending}</td>
                  <td className="num">{g.creditExceptions}</td>
                  <td className="num">
                    {g.awaitingRmConfirmation}
                    {g.missingEvidence ? ` (${g.missingEvidence} no evidence)` : ""}
                  </td>
                </tr>
              ))}
              {!groups.length && (
                <tr>
                  <td colSpan={13} className="muted">No facilities match.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data small">
            <thead>
              <tr><th scope="col">Facility</th><th scope="col">Product</th><th scope="col">Originated by</th><th scope="col">Unit Head</th><th scope="col">Location</th><th scope="col">Status</th><th scope="col" className="num">Requested</th><th scope="col" className="num">Disbursed</th></tr>
            </thead>
            <tbody>
              {facts.map((x) => (
                <tr key={x.id}>
                  <td><Link href={`/requests/${x.id}`}>{x.ref}</Link></td>
                  <td>{x.product}</td>
                  <td>{x.officer}</td>
                  <td>{x.unitHead}</td>
                  <td>{x.location}</td>
                  <td>{x.status}</td>
                  <td className="num">{k(x.requestedKobo)}</td>
                  <td className="num">{x.disbursed ? k(x.disbursedKobo) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Breadcrumb({ sp, order, sel, labels }: { sp: SP; order: string[]; sel: string[]; labels: Record<string, string> }) {
  return (
    <nav aria-label="Drill-down" className="small" style={{ margin: "8px 0" }}>
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
