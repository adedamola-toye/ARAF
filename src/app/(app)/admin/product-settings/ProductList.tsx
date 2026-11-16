"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { STATUS, type SettingsStatusKey } from "@/lib/product-settings";

export interface ListRow {
  code: string;
  name: string;
  status: SettingsStatusKey;
  detail: string;
  proposals: number;
}


export function ProductList({ rows }: { rows: ListRow[] }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? rows.filter((r) => r.name.toLowerCase().includes(t) || r.code.toLowerCase().includes(t) || STATUS[r.status].label.toLowerCase().includes(t)) : rows;
  }, [q, rows]);
  return (
    <section className="card" aria-labelledby="ps-list">
      <div className="card-head ps-list-head">
        <h2 id="ps-list">Products</h2>
        <div className="ps-search">
          <Search className="icon" aria-hidden="true" />
          <input type="search" aria-label="Search products" placeholder="Search products or status" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <ul className="ps-products">
        {shown.map((r) => (
          <li key={r.code}>
            <Link href={`/admin/product-settings/${r.code}`} className="ps-product">
              <span className="ps-product-main">
                <strong>{r.name}</strong>
                <span className="small muted">{r.detail}</span>
                {r.proposals > 0 && <span className="small ps-note">{r.proposals} earlier proposal{r.proposals === 1 ? "" : "s"} to load or dismiss</span>}
              </span>
              <span className={STATUS[r.status].cls}>{STATUS[r.status].label}</span>
              <ChevronRight className="icon" aria-hidden="true" />
            </Link>
          </li>
        ))}
        {shown.length === 0 && <li className="muted small" style={{ padding: "var(--space-3)" }}>No product matches “{q}”.</li>}
      </ul>
    </section>
  );
}
