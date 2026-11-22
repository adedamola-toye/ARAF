import { notFound } from "next/navigation";
import { requireRole } from "../../../_lib/auth";
import { db } from "@/server/db";
import { bouquetDetail, bouquetSettings, CONCURRENCE_ACK, EXCLUSION_ACTION_LABEL } from "@/server/domain/bouquet";
import { formatDuration, formatLagos } from "@/server/time";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { ConcurPanel, MemberTable, RefreshBouquet, SampleButton, type MemberView } from "../BouquetForms";

export const metadata = { title: "Bouquet" };

export default async function BouquetPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ concurred?: string }> }) {
  const { session } = await requireRole(["DIVISIONAL_HEAD", "SUPER_ADMIN"]);
  const { id } = await params;
  const sp = await searchParams;
  const d = await bouquetDetail(db, id, session.staffId);
  if (!d) notFound();
  const s = await bouquetSettings(db);
  const b = d.bouquet;
  const open = b.status === "OPEN" && b.divisional_head_id === session.staffId;
  const members: MemberView[] = d.members.map((m) => ({
    id: m.id,
    applicationId: m.application_id,
    ref: m.ref,
    customer: m.customer_name ?? m.ref,
    product: m.product_label ?? m.product_code ?? "—",
    amountKobo: m.amount_kobo,
    status: m.status,
    inspected: m.inspected_at ? formatLagos(m.inspected_at) : null,
    sampled: m.sampled,
    exclusion: m.exclusion_reason,
    exclusionAction: m.exclusion_action ? EXCLUSION_ACTION_LABEL[m.exclusion_action] : null,
    changed: m.changed,
    approvedBy: m.uh_name,
  }));
  const included = d.members.filter((m) => m.status === "INCLUDED").length;
  return (
    <>
      <PageHeader
        eyebrow="Facility Bouquet"
        title={b.ref}
        crumbs={[{ href: "/bouquets", label: "Concurrence" }, { label: b.ref }]}
        intro={
          b.status === "CONCURRED"
            ? `Concurred ${formatLagos(b.concurred_at!)} by ${b.dh_name}.`
            : "A bouquet aggregates approval decisions. Each facility keeps its own application, documents, approvals and audit trail."
        }
        actions={open ? <RefreshBouquet /> : undefined}
      />

      {sp.concurred && b.status === "CONCURRED" && (
        <div className="alert alert-success" role="status" style={{ marginBottom: "var(--space-5)" }}>
          Concurrence recorded for {b.concurred_count} facilit{b.concurred_count === 1 ? "y" : "ies"}. Each has its own Divisional Head decision and has moved to offer preparation; the originators have been notified.
          Excluded facilities are unchanged.
        </div>
      )}
      <section className="grid-3" style={{ marginBottom: "var(--space-6)" }} aria-label="Bouquet summary">
        <Money size="hero" label={b.status === "CONCURRED" ? "Concurred value" : "Combined facility value"} kobo={d.totalKobo} hint={`${d.included.length} facilit${d.included.length === 1 ? "y" : "ies"}`} />
        <div className="fig fig-lg">
          <span className="fig-label">Individually inspected</span>
          <span className="fig-value">{d.inspected}</span>
          <span className="fig-hint">Minimum {s.min_inspections}</span>
        </div>
        <div className="fig fig-lg">
          <span className="fig-label">Excluded</span>
          <span className="fig-value">{d.excluded.length}</span>
          {d.oldest && <span className="fig-hint">Oldest waiting {formatDuration(Date.now() - new Date(d.oldest).getTime())}</span>}
        </div>
      </section>

      {d.products.length > 0 && (
        <section aria-labelledby="h-prod" style={{ marginBottom: "var(--space-5)" }}>
          <h2 id="h-prod">By product</h2>
          <ul className="plain-list">
            {d.products.map((p) => (
              <li key={p.label} className="row" style={{ justifyContent: "space-between", maxWidth: 520 }}>
                <span>
                  {p.label} · {p.count}
                </span>
                <Money size="table" as="span" kobo={p.kobo} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.changed.length > 0 && open && (
        <div className="alert alert-warn" role="alert">
          {d.changed.length} facilit
          {d.changed.length === 1 ? "y has" : "ies have"} changed since being added. Select Refresh to update them (their inspection is cleared so you can review them again). Concurrence is refused until then.
        </div>
      )}

      {open && (
        <section className="card" aria-labelledby="h-insp" style={{ marginBottom: "var(--space-5)" }}>
          <div className="card-head">
            <h2 id="h-insp">Inspect</h2>
          </div>
          <p className="small">Random sample picks a genuinely random included facility, preferring ones not yet inspected. You can also open any facility below.</p>
          <SampleButton bouquetId={b.id} />
        </section>
      )}

      <section aria-labelledby="h-mem" style={{ marginBottom: "var(--space-6)" }}>
        <h2 id="h-mem">Facilities</h2>
        <MemberTable bouquetId={b.id} members={members} open={open} defaultExclusion={s.exclusion_default} />
      </section>

      {open && (
        <section className="card" aria-labelledby="h-concur">
          <div className="card-head">
            <h2 id="h-concur">Concurrence</h2>
          </div>
          <p className="small">
            Concurrence records your decision against every included facility and moves each to offer preparation. It never marks anything as disbursed. If any facility changed, nothing is concurred.
          </p>
          <ConcurPanel bouquetId={b.id} count={included} totalKobo={d.totalKobo} inspected={d.inspected} excluded={d.excluded.length} minInspections={s.min_inspections} ack={CONCURRENCE_ACK} />
        </section>
      )}
      {b.status === "CONCURRED" && b.acknowledgement && <p className="small muted">Acknowledgement recorded: “{b.acknowledgement}”</p>}
    </>
  );
}
