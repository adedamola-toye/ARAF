"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { compactNaira } from "./TrendChart";

export interface OfficerTableRow {
  officer: string;
  role: string;
  segment: string;
  businessUnit: string;
  reportingHead: string;
  products: string;
  locations: string;
  requests: number;
  requested: number;
  approved: number;
  disbursed: number;
  pending: number;
  turnaroundHours: number | null;
  slaOnTimePercent: number;
  href: string;
}

type Key = keyof Omit<OfficerTableRow, "href">;
const COLS: { key: Key; label: string; num?: boolean }[] = [
  { key: "officer", label: "Officer" },
  { key: "role", label: "Role" },
  { key: "businessUnit", label: "Business unit" },
  { key: "reportingHead", label: "Reporting head" },
  { key: "products", label: "Product" },
  { key: "locations", label: "Location" },
  { key: "requests", label: "Requests", num: true },
  { key: "requested", label: "Requested", num: true },
  { key: "approved", label: "Approved", num: true },
  { key: "disbursed", label: "Disbursed", num: true },
  { key: "pending", label: "Pending", num: true },
  { key: "turnaroundHours", label: "Turnaround", num: true },
  { key: "slaOnTimePercent", label: "SLA on time", num: true },
];
const hours = (h: number | null) => (h === null ? "—" : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`);

/** Officer performance: searchable and sortable; each officer opens their facilities. */
export function OfficerTable({ rows }: { rows: OfficerTableRow[] }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: "requested", dir: -1 });
  const view = useMemo(() => {
    const t = q.trim().toLowerCase();
    const xs = t ? rows.filter((r) => [r.officer, r.role, r.businessUnit, r.reportingHead, r.products, r.locations, r.segment].join(" ").toLowerCase().includes(t)) : rows;
    return [...xs].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
  }, [rows, q, sort]);
  return (
    <section className="po-panel" aria-labelledby="po-officers">
      <div className="po-panel-head">
        <h2 id="po-officers" className="po-h3">
          Officer performance <span className="muted po-count">{view.length}</span>
        </h2>
        <input type="search" className="po-search" placeholder="Search officer, unit, head, product, location" aria-label="Search officers" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="table-wrap">
        <table className="data small po-table">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} scope="col" className={c.num ? "num" : undefined} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                  <button type="button" className="po-sort" onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (s.dir === 1 ? -1 : 1) : c.num ? -1 : 1 }))}>
                    {c.label}
                    <span aria-hidden="true" className="po-sort-ind">
                      {sort.key === c.key ? (sort.dir === 1 ? "▲" : "▼") : ""}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map((r) => (
              <tr key={r.officer}>
                <td>
                  <Link href={r.href}>{r.officer}</Link>
                  <div className="muted po-sub">{r.segment}</div>
                </td>
                <td>{r.role}</td>
                <td>{r.businessUnit}</td>
                <td>{r.reportingHead}</td>
                <td>{r.products}</td>
                <td>{r.locations || "—"}</td>
                <td className="num">{r.requests}</td>
                <td className="num">{compactNaira(r.requested)}</td>
                <td className="num">{compactNaira(r.approved)}</td>
                <td className="num">{compactNaira(r.disbursed)}</td>
                <td className="num">{r.pending}</td>
                <td className="num">{hours(r.turnaroundHours)}</td>
                <td className="num">
                  <span className={r.slaOnTimePercent < 80 ? "po-sla-low" : undefined}>{r.slaOnTimePercent}%</span>
                </td>
              </tr>
            ))}
            {!view.length && (
              <tr>
                <td colSpan={COLS.length} className="muted">
                  No officers match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
