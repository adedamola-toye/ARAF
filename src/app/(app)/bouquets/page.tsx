import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { requireRole } from "../../_lib/auth";
import { db } from "@/server/db";
import { isEnabled } from "@/server/domain/switches";
import { bouquetSettings, candidates, dhFigures, myBouquets } from "@/server/domain/bouquet";
import { formatDuration, formatLagos } from "@/server/time";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { BuildBouquet } from "./BouquetForms";

export const metadata = { title: "Concurrence" };

/** Divisional Head concurrence workspace: individual queue always; Facility Bouquet only when switched on. */
export default async function Bouquets() {
  const { session } = await requireRole(["DIVISIONAL_HEAD", "SUPER_ADMIN"]);
  const me = session.staffId;
  const on = await isEnabled(db, "BOUQUET_APPROVALS");
  const s = await bouquetSettings(db);
  const f = await dhFigures(db, me);
  const c = await candidates(db, me);
  const list = await myBouquets(db, me);
  const open = list.find((b) => b.status === "OPEN");
  const now = Date.now();
  const eligibleKobo = c.eligible.reduce((t, x) => t + BigInt(x.amount_kobo), 0n).toString();
  return (
    <>
      <PageHeader eyebrow="Divisional Head" title="Concurrence" intro="Facilities approved by every preceding officer and awaiting your concurrence. Every figure comes from records." />

      <section className="grid-3" style={{ marginBottom: "var(--space-6)" }} aria-label="Awaiting concurrence">
        <Money
          size="hero"
          label="Awaiting your concurrence"
          kobo={f.awaitingKobo}
          hint={`${f.awaiting} facilit${f.awaiting === 1 ? "y" : "ies"}${f.oldest ? ` · oldest waiting ${formatDuration(now - new Date(f.oldest).getTime())}` : ""}`}
        />
        <div className="fig fig-lg">
          <span className="fig-label">Open bouquets</span>
          <span className="fig-value">{f.openBouquets}</span>
        </div>
        <div className="fig fig-lg">
          <span className="fig-label">Need individual review</span>
          <span className="fig-value">{c.individual.length}</span>
        </div>
      </section>

      {!on ? (
        <div className="alert" role="status">
          <strong>Facility Bouquet is switched off.</strong> Each facility needs its own Divisional Head decision from <Link href="/queue">My Action Queue</Link>. A Super Admin can switch it on in Feature controls once
          the bank&apos;s risk governance has approved bouquet concurrence.
        </div>
      ) : !s.eligible_products.length ? (
        <div className="alert" role="status">
          <strong>No product is eligible yet.</strong> A Super Admin names the eligible products in Bouquet settings. Until then every facility is reviewed individually.
        </div>
      ) : (
        <section className="card" aria-labelledby="h-bq" style={{ marginBottom: "var(--space-6)" }}>
          <div className="card-head">
            <h2 id="h-bq">Facility Bouquet</h2>
          </div>
          <Money
            size="lg"
            label="Ready for a bouquet"
            kobo={eligibleKobo}
            hint={`${c.eligible.length} eligible facilit${c.eligible.length === 1 ? "y" : "ies"} not yet in a bouquet · maximum ${s.max_size} per bouquet · at least ${s.min_inspections} inspected`}
          />
          <div className="row" style={{ marginTop: "var(--space-4)" }}>
            {open ? (
              <Link className="btn btn-primary" href={`/bouquets/${open.id}`}>
                Review bouquet {open.ref} <ArrowRight className="icon" aria-hidden="true" />
              </Link>
            ) : (
              <BuildBouquet disabled={!c.eligible.length} />
            )}
          </div>
        </section>
      )}

      {c.individual.length > 0 && (
        <section aria-labelledby="h-ind" style={{ marginBottom: "var(--space-6)" }}>
          <h2 id="h-ind">Individual review</h2>
          <p className="small muted">These facilities are never included in a bouquet automatically. Decide each one from the request page.</p>
          <ul className="home-list">
            {c.individual.map((x) => (
              <li key={x.task_id}>
                <Link className="home-row" href={`/requests/${x.application_id}?task=${x.task_id}`}>
                  <span className="home-main">
                    <strong>{x.customer_name ?? x.ref}</strong>
                    <span className="small muted">
                      {x.ref} · {x.product_label ?? "—"} · {x.reasons.join("; ")}
                    </span>
                  </span>
                  <Money size="table" as="span" kobo={x.amount_kobo} />
                  <ArrowRight className="icon" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="h-hist">
        <h2 id="h-hist">Recent bouquets</h2>
        {list.length ? (
          <div className="table-wrap">
            <table className="data responsive">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Status</th>
                  <th className="num">Facilities</th>
                  <th className="num">Value</th>
                  <th>Created</th>
                  <th>Concurred</th>
                </tr>
              </thead>
              <tbody>
                {list.map((b) => (
                  <tr key={b.id}>
                    <td data-label="Reference">
                      <Link href={`/bouquets/${b.id}`}>{b.ref}</Link>
                    </td>
                    <td data-label="Status">
                      <span className={`badge ${b.status === "CONCURRED" ? "badge-green" : "badge-blue"}`}>{b.status === "OPEN" ? "Open" : b.status === "CONCURRED" ? "Concurred" : "Closed"}</span>
                    </td>
                    <td data-label="Facilities" className="num tnum">
                      {b.included}
                    </td>
                    <td className="num" data-label="Amount">
                      <Money size="table" as="span" kobo={b.total_kobo} />
                    </td>
                    <td data-label="Created">{formatLagos(b.created_at)}</td>
                    <td data-label="Concurred">{b.concurred_at ? formatLagos(b.concurred_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No bouquets yet.</p>
        )}
      </section>
    </>
  );
}
