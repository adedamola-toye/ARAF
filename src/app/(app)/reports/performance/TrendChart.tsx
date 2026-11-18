"use client";
import { useEffect, useId, useRef, useState } from "react";

export interface TrendDatum {
  label: string;
  requested: number;
  approved: number;
  disbursed: number;
}

const SERIES = [
  { key: "requested", label: "Requested", cls: "po-s1" },
  { key: "approved", label: "Approved", cls: "po-s2" },
  { key: "disbursed", label: "Disbursed", cls: "po-s3" },
] as const;

/** Compact naira for axis ticks and tooltips (values are naira, not kobo). */
export function compactNaira(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e12) return `₦${(n / 1e12).toFixed(a >= 1e13 ? 0 : 1)}tn`;
  if (a >= 1e9) return `₦${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}bn`;
  if (a >= 1e6) return `₦${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}m`;
  if (a >= 1e3) return `₦${(n / 1e3).toFixed(0)}k`;
  return `₦${n.toFixed(0)}`;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** Requested, approved and disbursed amounts over time: one axis, thin lines, crosshair tooltip, table view. */
export function TrendChart({ data, grain }: { data: TrendDatum[]; grain: "day" | "week" | "month" }) {
  const uid = useId();
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the container's real width so text and strokes keep their size at every screen width.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 260;
  const maxRaw = Math.max(0, ...data.flatMap((d) => [d.requested, d.approved, d.disbursed]));
  // Left margin sized to the widest y-axis label so tick text never overlaps the plot.
  const m = { t: 12, r: 16, b: 28, l: 14 + 7 * compactNaira(niceMax(maxRaw)).length };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const max = niceMax(maxRaw);
  const x = (i: number) => m.l + (data.length <= 1 ? iw / 2 : (i * iw) / (data.length - 1));
  const y = (v: number) => m.t + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(W / 90))));
  const markers = data.length <= 16;
  const empty = data.every((d) => !d.requested && !d.approved && !d.disbursed);
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * iw;
    setHover(data.length <= 1 ? 0 : Math.max(0, Math.min(data.length - 1, Math.round((px / iw) * (data.length - 1)))));
  };
  const h = hover !== null ? data[hover] : null;
  return (
    <figure className="po-chart" aria-labelledby={`${uid}-cap`}>
      <figcaption id={`${uid}-cap`} className="po-chart-head">
        <span className="po-h3">Financing trend</span>
        <span className="po-legend" aria-hidden="true">
          {SERIES.map((s) => (
            <span key={s.key} className="po-legend-item">
              <span className={`po-swatch ${s.cls}`} />
              {s.label}
            </span>
          ))}
        </span>
      </figcaption>
      <div className="po-chart-body" ref={box}>
        {empty ? (
          <p className="muted small po-empty">No financing activity in the selected period.</p>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Requested, approved and disbursed amounts by ${grain}`} className="po-svg">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} className={t === 0 ? "po-axis" : "po-grid"} />
                <text x={m.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="po-tick">
                  {compactNaira(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) =>
              i % every === 0 || (i === data.length - 1 && i % every >= every / 2) ? (
                <text key={d.label} x={x(i)} y={H - 8} textAnchor="middle" className="po-tick">
                  {d.label}
                </text>
              ) : null,
            )}
            {SERIES.map((s) => (
              <polyline key={s.key} className={`po-line ${s.cls}`} points={data.map((d, i) => `${x(i)},${y(d[s.key])}`).join(" ")} />
            ))}
            {markers &&
              SERIES.map((s) => data.map((d, i) => <circle key={`${s.key}-${i}`} cx={x(i)} cy={y(d[s.key])} r={3} className={`po-dot ${s.cls}`} />))}
            {h && hover !== null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + ih} className="po-cross" />
                {SERIES.map((s) => (
                  <circle key={s.key} cx={x(hover)} cy={y(h[s.key])} r={4.5} className={`po-dot ${s.cls}`} />
                ))}
              </g>
            )}
            <rect x={m.l} y={m.t} width={iw} height={ih} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
          </svg>
        )}
        {h && hover !== null && (
          <div className={`po-tip ${x(hover) > W / 2 ? "po-tip-left" : "po-tip-right"}`} style={{ left: `${x(hover)}px` }} role="status">
            <strong>{h.label}</strong>
            {SERIES.map((s) => (
              <span key={s.key} className="po-tip-row">
                <span className={`po-swatch ${s.cls}`} aria-hidden="true" />
                {s.label}
                <span className="num">{compactNaira(h[s.key])}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <details className="po-table-view">
        <summary className="small">View as table</summary>
        <div className="table-wrap">
          <table className="data small">
            <thead>
              <tr>
                <th scope="col">{grain === "month" ? "Month" : grain === "week" ? "Week of" : "Day"}</th>
                {SERIES.map((s) => (
                  <th key={s.key} scope="col" className="num">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.label}>
                  <td>{d.label}</td>
                  {SERIES.map((s) => (
                    <td key={s.key} className="num">
                      {compactNaira(d[s.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
