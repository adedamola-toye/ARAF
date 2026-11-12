"use client";
import { useMemo, useState } from "react";
import { computeTerms, formatNaira, formatRateE4, type MarkupBasis } from "@/lib/altphones";

/** Tenure picker with the live repayment breakdown (the server recalculates everything on save). */
export function TenureCalculator({
  priceKobo,
  downKobo,
  rates,
  basis,
  tenures,
  defaultTenure,
  name = "tenure",
  readOnly = false,
}: {
  priceKobo: number;
  downKobo: number;
  rates: Record<string, number>;
  basis: MarkupBasis | null;
  tenures: number[];
  defaultTenure?: number | null;
  name?: string;
  readOnly?: boolean;
}) {
  const configured = tenures.filter((t) => rates[String(t)] !== undefined && basis);
  const [tenure, setTenure] = useState<number | null>(defaultTenure && configured.includes(defaultTenure) ? defaultTenure : null);
  const t = useMemo(() => (tenure && basis ? computeTerms({ priceKobo, downPaymentKobo: downKobo, tenureMonths: tenure, rateE4: rates[String(tenure)], basis }) : null), [tenure, basis, priceKobo, downKobo, rates]);
  return (
    <div className="alt-calc">
      <fieldset className="alt-tenures" disabled={readOnly}>
        <legend>Tenure</legend>
        {tenures.map((m) => {
          const ok = configured.includes(m);
          return (
            <label key={m} className={`alt-tenure ${tenure === m ? "is-on" : ""} ${ok ? "" : "is-off"}`}>
              <input type="radio" name={name} value={m} checked={tenure === m} disabled={!ok} onChange={() => setTenure(m)} />
              <span className="alt-tenure-m">{m}</span>
              <span className="alt-tenure-l">months</span>
              {ok && basis ? <span className="alt-tenure-i">{formatNaira(computeTerms({ priceKobo, downPaymentKobo: downKobo, tenureMonths: m, rateE4: rates[String(m)], basis }).instalmentKobo)}/mo</span> : <span className="alt-tenure-i">Not configured</span>}
            </label>
          );
        })}
      </fieldset>
      <dl className="alt-breakdown" aria-live="polite">
        <div>
          <dt>Phone price</dt>
          <dd>{formatNaira(priceKobo)}</dd>
        </div>
        <div>
          <dt>Down payment (fixed)</dt>
          <dd>{formatNaira(downKobo)}</dd>
        </div>
        <div>
          <dt>Amount financed</dt>
          <dd>{formatNaira(priceKobo - downKobo)}</dd>
        </div>
        <div>
          <dt>Markup{t ? ` (${formatRateE4(t.effectiveRateE4)})` : ""}</dt>
          <dd>{t ? formatNaira(t.markupKobo) : "—"}</dd>
        </div>
        <div className="alt-breakdown-total">
          <dt>Total repayment</dt>
          <dd>{t ? formatNaira(t.totalRepaymentKobo) : "—"}</dd>
        </div>
        <div className="alt-breakdown-hero">
          <dt>Monthly instalment</dt>
          <dd>
            {t ? formatNaira(t.instalmentKobo) : "Choose a tenure"}
            {t && t.finalInstalmentKobo !== t.instalmentKobo && <span className="small muted"> · final {formatNaira(t.finalInstalmentKobo)}</span>}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** Copy-to-clipboard for payment links (falls back to selecting the text). */
export function CopyLink({ url }: { url: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="alt-copy">
      <input readOnly value={url} aria-label="Payment link" onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        className="btn btn-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setDone(true);
            setTimeout(() => setDone(false), 2000);
          } catch {
            /* clipboard unavailable: the field is selectable */
          }
        }}
      >
        {done ? "Copied" : "Copy link"}
      </button>
      <a className="btn btn-sm btn-ghost" href={url} target="_blank" rel="noopener noreferrer">
        Open
      </a>
    </div>
  );
}
