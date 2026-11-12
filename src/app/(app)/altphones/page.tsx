import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, CreditCard, ShoppingBag } from "lucide-react";
import { requireUser } from "../../_lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { db } from "@/server/db";
import { listModels } from "@/server/altphones/catalogue";
import { creditReadiness, currentSettings } from "@/server/altphones/core";
import { altphonesAccess, BUCKETS, myBucketCounts, type Bucket } from "@/server/altphones/views";
import { termsFor } from "@/server/altphones/origination";
import { formatNaira } from "@/lib/altphones";
import { PhoneImage } from "./ui";
import { startSaleAction } from "./actions";

export const metadata = { title: "Altphones" };

export default async function AltphonesHome({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { session } = await requireUser();
  const access = await altphonesAccess(db, session.staffId);
  if (!access.originator) {
    if (access.reviewer) redirect("/altphones/reviews");
    if (access.inventory) redirect("/altphones/inventory");
    redirect("/forbidden");
  }
  const [models, s, counts] = await Promise.all([listModels(db, { activeOnly: true }), currentSettings(db), myBucketCounts(db, session.staffId)]);
  const stock = new Map(
    (await db.query<{ model_id: string; available: number; locations: number }>(
      `SELECT model_id, sum(physical - reserved)::int AS available, count(*) FILTER (WHERE physical - reserved > 0)::int AS locations
         FROM altphones_stock s JOIN locations l ON l.id = s.location_id WHERE l.active GROUP BY model_id`,
    )).rows.map((r) => [r.model_id, r]),
  );
  const creditMissing = creditReadiness(s);
  const fromMonthly = s.tenures
    .map((t) => termsFor(s, t))
    .filter(Boolean)
    .map((t) => t!.instalmentKobo);
  const lowest = fromMonthly.length ? Math.min(...fromMonthly) : null;
  const order: Bucket[] = ["payment", "preparing", "approval", "approved", "drafts", "completed"];
  return (
    <>
      <PageHeader eyebrow="Delight Officer / Smile Associate" title="Altphones" intro="Sell a phone outright or on credit. Choose the phone to begin." />
      {sp.error && (
        <div className="alert alert-error" role="alert">
          <span>{sp.error}</span>
        </div>
      )}
      <nav className="alt-buckets" aria-label="My sales">
        {order.map((b) => (
          <Link key={b} href={`/altphones/sales?bucket=${b}`} className={`alt-bucket ${counts[b] ? "has" : ""} ${b === "approved" && counts[b] ? "is-hot" : ""}`}>
            <span className="alt-bucket-n">{counts[b]}</span>
            <span className="alt-bucket-l">{BUCKETS[b].label}</span>
          </Link>
        ))}
      </nav>

      <section aria-labelledby="catalogue-h" className="alt-section">
        <div className="alt-section-head">
          <h2 id="catalogue-h">Choose a phone</h2>
          <span className="small muted">
            {formatNaira(s.outright_price_kobo)} outright · {formatNaira(s.down_payment_kobo)} down on credit
          </span>
        </div>
        {models.length === 0 ? (
          <div className="card">
            <p className="muted" style={{ margin: 0 }}>
              The Altphones catalogue is empty. The Altphones Product Manager adds the approved phones, photos and specifications.
            </p>
          </div>
        ) : (
          <div className="alt-phone-grid">
            {models.map((m) => {
              const st = stock.get(m.id);
              const available = st?.available ?? 0;
              return (
                <article key={m.id} className="alt-phone">
                  <PhoneImage modelId={m.id} hasImage={!!m.image_key} name={m.name} />
                  <div className="alt-phone-body">
                    <h3>{m.name}</h3>
                    <ul className="alt-specs">
                      {m.specifications
                        .split("\n")
                        .map((x) => x.trim())
                        .filter(Boolean)
                        .slice(0, 8)
                        .map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                    </ul>
                    <div className="alt-price">
                      <span className="alt-price-v">{formatNaira(s.outright_price_kobo)}</span>
                      <span className="small muted">outright</span>
                    </div>
                    <p className="alt-finance small">
                      {creditMissing.length ? (
                        <span className="muted">Financing not available yet</span>
                      ) : (
                        <>
                          <strong>{formatNaira(s.down_payment_kobo)} down</strong>, then {s.tenures.join(", ").replace(/, (\d+)$/, " or $1")} months{lowest ? ` · from ${formatNaira(lowest)}/month` : ""}
                        </>
                      )}
                    </p>
                    <p className={`alt-stock small ${available ? "" : "is-out"}`}>{available ? `${available} available across ${st!.locations} location${st!.locations === 1 ? "" : "s"}` : "Out of stock"}</p>
                    <div className="alt-phone-actions">
                      <form action={startSaleAction}>
                        <input type="hidden" name="kind" value="OUTRIGHT" />
                        <input type="hidden" name="modelId" value={m.id} />
                        <button className="btn" disabled={!available}>
                          <ShoppingBag className="icon" aria-hidden="true" /> Buy Outright
                        </button>
                      </form>
                      <form action={startSaleAction}>
                        <input type="hidden" name="kind" value="CREDIT" />
                        <input type="hidden" name="modelId" value={m.id} />
                        <button className="btn btn-primary" disabled={!available || creditMissing.length > 0}>
                          <CreditCard className="icon" aria-hidden="true" /> Buy on Credit
                        </button>
                      </form>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {creditMissing.length > 0 && (
          <details className="alt-note">
            <summary className="small">Why is Buy on Credit unavailable?</summary>
            <ul className="small">
              {creditMissing.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
      <p className="small">
        <Link href="/altphones/sales">
          All my Altphones sales <ArrowRight className="icon" aria-hidden="true" />
        </Link>
      </p>
    </>
  );
}
