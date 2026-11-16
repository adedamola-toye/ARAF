import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Car, Package, Store, Zap } from "lucide-react";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { PageHeader } from "@/components/PageHeader";
import { availability, originationSettings, visibleProducts } from "./catalogue";

export const metadata = { title: "New Financing Request" };

const ICONS: Record<string, React.ReactNode> = {
  WAKEELBOOST: <Store className="icon" aria-hidden="true" />,
  VENDOR_FINANCING: <Package className="icon" aria-hidden="true" />,
  ALT_DRIVE: <Car className="icon" aria-hidden="true" />,
  ALT_POWER: <Zap className="icon" aria-hidden="true" />,
};

export default async function NewRequest() {
  const { roles, session } = await requireUser();
  // The Delight Officer / Smile Associate workspace sells Altphones only.
  if (session.activeRole === "DELIGHT_OFFICER" || session.activeRole === "SMILE_ASSOCIATE") redirect("/altphones");
  const products = visibleProducts(roles, await originationSettings(db));
  if (!products.length) redirect("/forbidden");
  const now = new Date();
  const rows = await Promise.all(products.map(async (p) => ({ p, a: await availability(db, p, roles, now) })));
  return (
    <>
      <PageHeader eyebrow="Work" title="New Financing Request" intro="Choose the product. Each opens its own application, with that product's customer details, documents and checks." />
      <ul className="product-picker" data-tour="new-request" aria-label="Financing products">
        {rows.map(({ p, a }) => (
          <li key={p.code}>
            <Link href={`/requests/new/${p.slug}`} className="product-card" aria-describedby={`pd-${p.slug}`}>
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
    </>
  );
}
