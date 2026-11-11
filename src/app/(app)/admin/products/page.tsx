import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { BLOCKED_ACTION_LABELS, configGaps, configHistory, effectiveConfig, listProducts, type BlockedAction } from "@/server/domain/products";
import { ROLES, ROLE_LABELS } from "@/server/domain/roles";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { ConfigEditor, DecideConfig, ProductToggle } from "./ConfigEditor";

export const metadata = { title: "Products and rules" };

export default async function ProductsAdmin() {
  const { roles, session } = await requireUser();
  const isAdmin = roles.includes("SUPER_ADMIN");
  const isApprover = roles.includes("PRODUCT_CONFIG_APPROVER");
  if (!isAdmin && !isApprover) redirect("/forbidden");
  const products = await listProducts(db, { retailOnly: true });
  const now = new Date();
  const roleOpts = ROLES.filter((r) => !["SUPER_ADMIN", "REPORTING_ADMIN", "LEGAL_REVIEWER", "SHARIAH_REVIEWER", "RM", "DELIGHT_OFFICER", "ANM", "MERCHANT_OFFICER"].includes(r)).map((r) => [r, ROLE_LABELS[r]] as [string, string]);
  const all = await listProducts(db);
  const loaded = await Promise.all(products.map(async (p) => ({ p, cfg: await effectiveConfig(db, p.code, now), hist: await configHistory(db, p.code) })));
  return (
    <>
      <PageHeader eyebrow="Administration" title="Products and rules" intro="Each product's rules are versioned. Unsupplied parameters stay unset and visibly block the affected action. Changes take effect from their effective date after approval by a second person; applications keep the version they were submitted under." />
      <div className="stack">
        {loaded.map(({ p, cfg, hist }) => {
          const pending = hist.find((h) => h.status === "PROPOSED");
          const gaps = cfg ? configGaps(cfg.config) : [];
          const grouped = new Map<BlockedAction, string[]>();
          for (const g of gaps) grouped.set(g.blocks, [...(grouped.get(g.blocks) ?? []), g.label]);
          return (
            <section key={p.code} className="card" aria-labelledby={`h-${p.code}`}>
              <div className="card-head">
                <h2 id={`h-${p.code}`}>
                  {p.name} <span className="badge">{p.active ? "open" : "closed to new applications"}</span>
                </h2>
                {isAdmin && <ProductToggle code={p.code} active={p.active} />}
              </div>
              <p className="small muted" style={{ marginTop: 0 }}>In force: version {cfg?.version ?? "—"}{cfg ? `, effective ${formatLagos(cfg.effective_from)}` : ""}.</p>
              {gaps.length === 0 ? (
                <p className="small"><span className="badge badge-green">Complete</span> No configuration gaps.</p>
              ) : (
                <div className="alert alert-warn">
                  <div>
                    <strong>Configuration required</strong>
                    <ul className="small">
                      {[...grouped].map(([k, v]) => <li key={k}><strong>{BLOCKED_ACTION_LABELS[k]}</strong> is blocked until: {v.join("; ")}</li>)}
                    </ul>
                  </div>
                </div>
              )}
              {pending && (
                <div className="summary-box">
                  <p className="eyebrow">Proposed version {pending.version} · effective {formatLagos(pending.effective_from)}</p>
                  <p className="small" style={{ marginTop: 0 }}>By {pending.proposed_by_name} on {formatLagos(pending.proposed_at)}: {pending.reason}</p>
                  <details>
                    <summary className="small">Configuration gaps in the proposal</summary>
                    <ul className="small">{configGaps(pending.config).map((g) => <li key={g.key}>{g.label} ({BLOCKED_ACTION_LABELS[g.blocks]})</li>)}</ul>
                  </details>
                  <DecideConfig configId={pending.id} mine={pending.proposed_by === session.staffId} canApprove={isApprover} />
                </div>
              )}
              {isAdmin && cfg && !pending && (
                <details>
                  <summary style={{ cursor: "pointer", fontWeight: 700 }}>Propose a change</summary>
                  <div style={{ marginTop: 10 }}>
                    <ConfigEditor productCode={p.code} initial={cfg.config} roles={roleOpts} canPropose={isAdmin} />
                  </div>
                </details>
              )}
              <details>
                <summary className="small" style={{ cursor: "pointer" }}>History ({hist.length} versions)</summary>
                <table className="data small">
                  <thead><tr><th>Version</th><th>Status</th><th>Effective</th><th>Proposed</th><th>Decided</th><th>Reason</th></tr></thead>
                  <tbody>
                    {hist.map((h) => (
                      <tr key={h.id}>
                        <td>v{h.version}</td>
                        <td>{h.status.toLowerCase()}</td>
                        <td>{formatLagos(h.effective_from)}</td>
                        <td>{h.proposed_by_name ?? "system"}</td>
                        <td>{h.decided_by_name ?? (h.decided_at ? "system" : "—")}{h.decision_note ? `: ${h.decision_note}` : ""}</td>
                        <td>{h.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </section>
          );
        })}
        {all.filter((p) => p.workflow === "WAKEELBOOST").map((p) => (
          <section key={p.code} className="card">
            <div className="card-head">
              <h2>{p.name} (legacy) <span className="badge">{p.active ? "open" : "closed to new applications"}</span></h2>
              {isAdmin && <ProductToggle code={p.code} active={p.active} />}
            </div>
            <p className="small muted" style={{ margin: 0 }}>Historical WakeelBoost cases keep their label and workflow. Its pricing is managed under WakeelBoost pricing.</p>
          </section>
        ))}
      </div>
    </>
  );
}
