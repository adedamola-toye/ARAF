import Link from "next/link";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { bouquetSettings } from "@/server/domain/bouquet";
import { isEnabled } from "@/server/domain/switches";
import { listProducts } from "@/server/domain/products";
import { koboToNairaString } from "@/server/money";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "./SettingsForm";

export const metadata = { title: "Bouquet settings" };

export default async function BouquetSettingsPage() {
  await requireSuperAdmin();
  const s = await bouquetSettings(db);
  const on = await isEnabled(db, "BOUQUET_APPROVALS");
  const products = await listProducts(db);
  const history = (
    await db.query<{ occurred_at: Date; actor: string | null; reason: string | null }>(
      "SELECT e.occurred_at, st.full_name AS actor, e.reason FROM audit_events e LEFT JOIN staff st ON st.id = e.actor_id WHERE e.action = 'BOUQUET_SETTINGS_CHANGED' ORDER BY e.occurred_at DESC LIMIT 20",
    )
  ).rows;
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Bouquet settings"
        intro="Governance for Divisional Head bouquet concurrence. Facilities with material exceptions (credit score exceptions, DSR or policy exceptions, skipped business photographs, suspensions, open corrections) are always kept for individual review, whatever these settings say."
      />
      <div className={`alert ${on ? "alert-warn" : "alert-info"}`} role="status" style={{ marginBottom: "var(--space-5)" }}>
        Facility Bouquet is <strong>{on ? "ON" : "OFF"}</strong>. Switch it in <Link href="/admin/feature-controls">Feature controls</Link> only after the bank&apos;s risk governance has approved it.
      </div>
      <section className="card">
        <SettingsForm
          v={{
            products: products.map((p) => ({ code: p.code, name: p.name, selected: s.eligible_products.includes(p.code) })),
            maxSize: s.max_size,
            minInspections: s.min_inspections,
            individualReviewAbove: s.individual_review_above_kobo ? koboToNairaString(Number(s.individual_review_above_kobo)) : "",
            maxTotal: s.max_total_kobo ? koboToNairaString(Number(s.max_total_kobo)) : "",
            exclusionDefault: s.exclusion_default,
          }}
        />
      </section>
      <details style={{ marginTop: "var(--space-4)" }}>
        <summary className="small">Change history ({history.length})</summary>
        {history.length ? (
          <ul className="plain-list small">
            {history.map((h, i) => (
              <li key={i}>
                {formatLagos(h.occurred_at)} · {h.actor ?? "system"} · {h.reason}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">Not changed since it was introduced.</p>
        )}
      </details>
    </>
  );
}
