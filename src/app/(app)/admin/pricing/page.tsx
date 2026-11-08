import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { e4ToPercent, pricingHistory, pricingSettingsAt } from "@/server/domain/pricing";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { PricingSettingsForm } from "../AdminForms";

export const metadata = { title: "Pricing settings" };

export default async function Pricing() {
  await requireSuperAdmin();
  const now = new Date();
  const current = await pricingSettingsAt(db, now);
  const history = await pricingHistory(db);
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="WakeelBoost pricing settings"
        intro="Flat markup by tenor band, applied once to the principal for the whole tenor. The tenor determines the band regardless of the amount. The maximum tenor can never exceed 6 months; the DSR threshold is fixed at 10%."
      />
      <div className="metric-grid" style={{ marginBottom: 16 }}>
        <div className="metric"><div className="k">In force · version</div><div className="v">v{current.version}</div></div>
        <div className="metric"><div className="k">1–2 months</div><div className="v">{e4ToPercent(current.shortRateE4)}%</div></div>
        <div className="metric"><div className="k">3–{current.maxTenorMonths} months</div><div className="v">{e4ToPercent(current.longRateE4)}%</div></div>
        <div className="metric"><div className="k">Maximum tenor</div><div className="v">{current.maxTenorMonths} months</div></div>
        <div className="metric"><div className="k">DSR threshold</div><div className="v">{e4ToPercent(current.thresholdE4)}%</div></div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Change settings</h2>
        <PricingSettingsForm current={{ maxTenorMonths: current.maxTenorMonths, shortRatePercent: e4ToPercent(current.shortRateE4), longRatePercent: e4ToPercent(current.longRateE4) }} />
      </div>
      <div className="card">
        <h2>History</h2>
        <div className="table-wrap">
          <table className="data responsive">
            <thead><tr><th>Version</th><th>Max tenor</th><th>1–2 months</th><th>3+ months</th><th>Effective from</th><th>Changed by</th><th>Reason</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td data-label="Version">v{h.version}{h.id === current.id && <span className="badge badge-green" style={{ marginLeft: 6 }}>In force</span>}{new Date(h.effective_from) > now && <span className="badge badge-warn" style={{ marginLeft: 6 }}>Scheduled</span>}</td>
                  <td data-label="Max tenor">{h.max_tenor_months} months</td>
                  <td className="tnum" data-label="1–2 months">{e4ToPercent(h.short_rate_e4)}%</td>
                  <td className="tnum" data-label="3+ months">{e4ToPercent(h.long_rate_e4)}%</td>
                  <td className="small" data-label="Effective from">{formatLagos(h.effective_from)}</td>
                  <td className="small" data-label="Changed by">{h.created_by_name ?? "System seed"}<div className="muted">{formatLagos(h.created_at)}</div></td>
                  <td className="small" data-label="Reason">{h.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
