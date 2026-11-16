import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ArrowRight, Briefcase, Car, Package, Store, Zap } from "lucide-react";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { PageHeader } from "@/components/PageHeader";
import { CUSTOMER_CATEGORIES, categoryBySlug } from "@/lib/customer-types";
import { availability, categoriesOffered, originationSettings, usesCustomerStep, visibleProducts } from "./catalogue";

export const metadata = { title: "New Financing Request" };

const ICONS: Record<string, React.ReactNode> = {
  WAKEELBOOST: <Store className="icon" aria-hidden="true" />,
  VENDOR_FINANCING: <Package className="icon" aria-hidden="true" />,
  ALT_DRIVE: <Car className="icon" aria-hidden="true" />,
  ALT_POWER: <Zap className="icon" aria-hidden="true" />,
};
const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  business: <Store className="icon" aria-hidden="true" />,
  salaried: <Briefcase className="icon" aria-hidden="true" />,
};

export default async function NewRequest({ searchParams }: { searchParams: Promise<{ customer?: string; prefer?: string }> }) {
  const { roles, session } = await requireUser();
  // The Delight Officer / Smile Associate workspace sells Altphones only.
  if (session.activeRole === "DELIGHT_OFFICER" || session.activeRole === "SMILE_ASSOCIATE") redirect("/altphones");
  const all = visibleProducts(roles, await originationSettings(db));
  if (!all.length) redirect("/forbidden");
  const now = new Date();
  const step = usesCustomerStep(all);
  const sp = await searchParams;
  const requested = sp.customer;
  const category = step ? categoryBySlug(requested) : null;

  // Step 1: customer type (retail originators only; WakeelBoost-only roles serve business owners).
  if (step && !category) {
    return (
      <>
        <PageHeader eyebrow="Work" title="New Financing Request" intro="Who is the customer? This decides which products and documents apply." />
        <form method="get" className="customer-step" data-tour="new-request">
          <fieldset>
            <legend className="step-title">
              <span className="step-no">1</span> Customer type
            </legend>
            <div className="customer-types">
              {CUSTOMER_CATEGORIES.map((c, i) => (
                <label key={c.slug} className="customer-card">
                  <input type="radio" name="customer" value={c.slug} defaultChecked={sp.prefer ? sp.prefer === c.slug : i === 0} required />
                  <span className="customer-icon">{CATEGORY_ICONS[c.slug]}</span>
                  <span className="customer-text">
                    <strong>{c.title}</strong>
                    <span>{c.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="customer-actions">
            <button type="submit" className="btn btn-primary">
              Continue <ArrowRight className="icon" aria-hidden="true" />
            </button>
          </div>
        </form>
      </>
    );
  }

  // Step 2: products for that customer type.
  const offered = await Promise.all(all.map(async (p) => ({ p, cats: await categoriesOffered(db, p, now) })));
  const products = category ? offered.filter((x) => x.cats.includes(category.code)).map((x) => x.p) : all;
  const rows = await Promise.all(products.map(async (p) => ({ p, a: await availability(db, p, roles, now) })));
  const q = category ? `?customer=${category.slug}` : "";
  return (
    <>
      <PageHeader
        eyebrow="Work"
        title="New Financing Request"
        intro={category ? `Choose the product for this ${category.title.toLowerCase()}. Each opens its own application, with the details, documents and checks that apply.` : "Choose the product. Each opens its own application, with that product's customer details, documents and checks."}
      />
      {category && (
        <div className="category-summary" style={{ marginBottom: "var(--space-4)" }}>
          <span className="customer-icon">{CATEGORY_ICONS[category.slug]}</span>
          <span className="small muted">Customer type</span>
          <strong>{category.title}</strong>
          <Link href={`/requests/new?prefer=${category.slug}`} className="btn btn-ghost btn-sm">
            <ArrowLeft className="icon" aria-hidden="true" /> Change
          </Link>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>No product you can originate is offered to this customer type. Choose another customer type or contact a Super Admin.</p>
        </div>
      ) : (
        <ul className="product-picker" data-tour={category ? undefined : "new-request"} aria-label="Financing products">
          {rows.map(({ p, a }) => (
            <li key={p.code}>
              <Link href={`/requests/new/${p.slug}${q}`} className="product-card" aria-describedby={`pd-${p.slug}`}>
                <span className="product-icon">{ICONS[p.code]}</span>
                <span className="product-text">
                  <strong>{p.name}</strong>
                  <span id={`pd-${p.slug}`}>
                    {p.description}
                    {a.status === "UNAVAILABLE" && <span className="product-note">{a.reason}</span>}
                  </span>
                </span>
                <ArrowRight className="icon product-go" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
