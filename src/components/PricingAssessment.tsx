import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { formatKobo } from "@/server/money";
import { formatLagos } from "@/server/time";
import type { PricingResult } from "@/server/domain/pricing";

export function pricingOf(outputs: unknown): { pricing: PricingResult; explanation: string; apr: { aprPercent: string; formula: string; takafulKobo: number; stampDutyKobo: number; costOfFacilityKobo: number; facilityType: string } } | null {
  const o = outputs as { pricing?: PricingResult; explanation?: string; apr?: never };
  return o?.pricing ? { pricing: o.pricing, explanation: o.explanation ?? "", apr: (o as { apr: never }).apr } : null;
}

export function ThresholdChip({ result, excessKobo }: { result: string; excessKobo: number }) {
  return result === "EXCEEDS_THRESHOLD" ? (
    <span className="badge badge-red">
      <AlertTriangle className="icon" aria-hidden="true" />
      Exceeds threshold by {formatKobo(excessKobo)}
    </span>
  ) : (
    <span className="badge badge-green">
      <CheckCircle2 className="icon" aria-hidden="true" />
      Within threshold
    </span>
  );
}

/**
 * WakeelBoost assessment display in three sections, rendered from the stored snapshot only
 * (no client-side arithmetic). `monthlyEquivalent` labels the repayment when the booked schedule
 * uses a different frequency.
 */
export function PricingAssessment({ outputs, monthlyEquivalent = false, compact = false }: { outputs: unknown; monthlyEquivalent?: boolean; compact?: boolean }) {
  const p = pricingOf(outputs);
  if (!p) return null;
  const { turnover: t, facility: f, capacity: c, settings: s } = p.pricing;
  const weekly = f.repaymentFrequency === "WEEKLY";
  const repaymentLabel = `Proposed monthly repayment${monthlyEquivalent || weekly ? " (monthly equivalent)" : ""}`;
  if (compact)
    return (
      <div className="stack" style={{ gap: 8 }}>
        <table className="kv">
          <tbody>
            <tr><th>Turnover used</th><td className="tnum">{formatKobo(t.monthlyTurnoverUsedKobo)} / month <span className="muted small">({t.basis === "VERIFIED_MONTHLY" ? "verified monthly" : "annual ÷ 12"})</span></td></tr>
            <tr><th>{repaymentLabel}</th><td className="tnum">{formatKobo(f.monthlyRepaymentKobo)}{weekly && <div className="small muted">weekly {formatKobo(f.instalmentKobo)} × {f.numberOfInstalments}</div>}</td></tr>
            <tr><th>Total DSR</th><td className="tnum"><strong>{c.totalDsrPercent}%</strong> <span className="muted small">threshold {c.thresholdPercent}%</span></td></tr>
            <tr><th>Flat markup</th><td className="tnum">{f.flatMarkupRatePercent}% · {formatKobo(f.markupKobo)}</td></tr>
          </tbody>
        </table>
        <ThresholdChip result={c.result} excessKobo={c.excessKobo} />
      </div>
    );
  return (
    <div className="stack">
      <section aria-labelledby="ta-h">
        <h3 id="ta-h">Turnover assessment</h3>
        <table className="kv">
          <tbody>
            <tr><th>Verified annual business turnover</th><td className="tnum">{formatKobo(t.annualTurnoverKobo)}</td></tr>
            <tr><th>Annual turnover ÷ 12</th><td className="tnum">{formatKobo(t.derivedMonthlyTurnoverKobo)}</td></tr>
            {t.verifiedMonthlyTurnoverKobo !== null && (
              <tr><th>Verified monthly turnover (reviewer)</th><td className="tnum">{formatKobo(t.verifiedMonthlyTurnoverKobo)}<div className="small muted">Reason: {t.overrideReason}</div></td></tr>
            )}
            <tr>
              <th>Turnover used by the calculator</th>
              <td className="tnum"><strong>{formatKobo(t.monthlyTurnoverUsedKobo)}</strong> per month <span className="badge">{t.basis === "VERIFIED_MONTHLY" ? "Verified monthly figure" : "Annual ÷ 12"}</span></td>
            </tr>
          </tbody>
        </table>
      </section>
      <section aria-labelledby="pf-h">
        <h3 id="pf-h">Proposed facility breakdown</h3>
        <table className="kv">
          <tbody>
            <tr><th>Principal</th><td className="tnum">{formatKobo(f.principalKobo)}</td></tr>
            <tr><th>Tenor</th><td>{f.tenorMonths} month{f.tenorMonths === 1 ? "" : "s"}</td></tr>
            <tr><th>Flat markup ({f.bandLabel} band, applied once for the tenor)</th><td className="tnum">{f.flatMarkupRatePercent}% · {formatKobo(f.markupKobo)}</td></tr>
            <tr><th>Total repayment (principal + markup)</th><td className="tnum">{formatKobo(f.totalRepaymentKobo)}</td></tr>
            <tr><th>{repaymentLabel}</th><td className="tnum"><strong>{formatKobo(f.monthlyRepaymentKobo)}</strong></td></tr>
            {weekly && <tr><th>Weekly instalment</th><td className="tnum">{formatKobo(f.instalmentKobo)} × {f.numberOfInstalments} weeks (4 per month)</td></tr>}
          </tbody>
        </table>
      </section>
      <section aria-labelledby="rc-h">
        <h3 id="rc-h">Repayment capacity assessment</h3>
        <table className="kv">
          <tbody>
            <tr><th>Existing monthly obligations</th><td className="tnum">{c.obligationsConfirmedNone ? "None (confirmed ₦0.00)" : formatKobo(c.existingObligationsKobo)}</td></tr>
            <tr><th>Facility DSR</th><td className="tnum">{c.facilityDsrPercent}%</td></tr>
            <tr><th>Total DSR (drives the result)</th><td className="tnum"><strong>{c.totalDsrPercent}%</strong></td></tr>
            <tr><th>Obligation threshold</th><td className="tnum">{c.thresholdPercent}% = {formatKobo(c.thresholdAmountKobo)} per month</td></tr>
            <tr><th>Result</th><td><ThresholdChip result={c.result} excessKobo={c.excessKobo} /></td></tr>
            <tr>
              <th>Indicative maximum affordable principal</th>
              <td className="tnum">
                {formatKobo(c.maxAffordablePrincipalKobo)}
                <div className="small muted">At {f.flatMarkupRatePercent}% over {f.tenorMonths} months, rounded down to the kobo.</div>
                {c.maxPrincipalWithinLimitKobo !== undefined && c.maxPrincipalWithinLimitKobo < c.maxAffordablePrincipalKobo && (
                  <div className="small">Within the ₦50,000,000 single obligation limit: <strong>{formatKobo(c.maxPrincipalWithinLimitKobo)}</strong></div>
                )}
              </td>
            </tr>
          </tbody>
        </table>
        <p className={c.result === "EXCEEDS_THRESHOLD" ? "blocked" : "highlight small"} style={{ margin: "8px 0 0" }}>
          {c.result === "EXCEEDS_THRESHOLD" && <AlertTriangle className="icon" aria-hidden="true" />}
          {p.explanation}
        </p>
        {c.result === "EXCEEDS_THRESHOLD" && <p className="small muted" style={{ margin: "6px 0 0" }}>Outside the threshold: approval needs a written justification backed by evidence (for example a second bank statement), or a recalculation within the threshold.</p>}
      </section>
      {p.apr && (
        <section aria-labelledby="apr-h">
          <h3 id="apr-h">APR disclosure (separate from the flat markup and DSR)</h3>
          <table className="kv">
            <tbody>
              <tr><th>Annual Percentage Rate</th><td className="tnum">{p.apr.aprPercent}%</td></tr>
              <tr><th>Cost of facility (markup + Takaful + stamp duty)</th><td className="tnum">{formatKobo(p.apr.costOfFacilityKobo)}</td></tr>
              <tr><th>Formula</th><td className="small">{p.apr.formula}</td></tr>
            </tbody>
          </table>
        </section>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        Pricing settings v{s.version}: {s.shortBandLabel ?? "1–2 months"} {s.shortRatePercent}%, {s.longBandLabel ?? `3–${s.maxTenorMonths} months`} {s.longRatePercent}%, maximum tenor {s.maxTenorMonths} months, threshold {s.thresholdPercent}% · effective {formatLagos(s.effectiveFrom)}
      </p>
    </div>
  );
}
