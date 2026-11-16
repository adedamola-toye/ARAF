import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "../../../../_lib/auth";
import { db } from "@/server/db";
import { ROLE_LABELS } from "@/server/domain/roles";
import { originationProduct } from "@/lib/origination-products";
import { PageHeader } from "@/components/PageHeader";
import { NewRequestForm } from "../NewRequestForm";
import { NewRetailForm } from "../NewRetailForm";
import { availability, categoriesOffered, initiatorRolesFor, originationSettings, retailCatalogue, usesCustomerStep, visibleProducts } from "../catalogue";
import { categoryBySlug } from "@/lib/customer-types";

export async function generateMetadata({ params }: { params: Promise<{ product: string }> }) {
  return { title: `New ${originationProduct((await params).product)?.name ?? "Financing"} Request` };
}

export default async function NewProductRequest({ params, searchParams }: { params: Promise<{ product: string }>; searchParams: Promise<{ customer?: string }> }) {
  const p = originationProduct((await params).product);
  if (!p) notFound();
  const { roles, session } = await requireUser();
  if (session.activeRole === "DELIGHT_OFFICER" || session.activeRole === "SMILE_ASSOCIATE") redirect("/altphones");
  const mine = initiatorRolesFor(p, roles, (await originationSettings(db))[p.code]);
  if (!mine.length) redirect("/forbidden");
  const now = new Date();
  const settings = await originationSettings(db);
  // Retail originators choose the customer type first; it decides which products and profile apply.
  const step = usesCustomerStep(visibleProducts(roles, settings));
  const category = categoryBySlug((await searchParams).customer);
  if (step && !category && p.kind === "RETAIL") redirect("/requests/new");
  const a = await availability(db, p, roles, now);
  const def = mine.includes(session.activeRole as never) ? session.activeRole! : mine[0];
  const options = mine.map((r) => ({ value: r, label: ROLE_LABELS[r] }));
  const back = (
    <Link href={category ? `/requests/new?customer=${category.slug}` : "/requests/new"} className="btn btn-ghost btn-sm" style={{ marginBottom: "var(--space-3)" }}>
      <ArrowLeft className="icon" aria-hidden="true" /> {category ? `${category.title} products` : "All products"}
    </Link>
  );
  if (category && !(await categoriesOffered(db, p, now)).includes(category.code)) {
    return (
      <>
        {back}
        <PageHeader eyebrow="New Financing Request" title={p.name} intro={p.description} />
        <div className="card">
          <p style={{ margin: 0 }}>
            {p.name} is not offered to {category.title.toLowerCase()} customers. <Link href={`/requests/new?customer=${category.slug}`}>Choose another product</Link>.
          </p>
        </div>
      </>
    );
  }
  if (a.status !== "OPEN") {
    return (
      <>
        {back}
        <PageHeader eyebrow="New Financing Request" title={p.name} intro={p.description} />
        <div className="card">
          <p style={{ margin: 0 }}>{a.status === "UNAVAILABLE" ? a.reason : "You do not hold a role that can initiate this product."} Contact a Super Admin or the product owner.</p>
        </div>
      </>
    );
  }
  if (p.kind === "WAKEELBOOST") {
    return (
      <>
        {back}
        <PageHeader eyebrow="New Financing Request" title="WakeelBoost" intro="Merchant stock financing. Choose the applicant type to start the draft; it is saved on the server and can be resumed at any time." />
        <div className="card" style={{ maxWidth: 820 }}>
          <NewRequestForm roles={options} defaultRole={def} />
        </div>
      </>
    );
  }
  const full = await retailCatalogue(db, p.code, now);
  if (!full) notFound();
  const cat = category ? { ...full, profiles: full.profiles.filter((x) => x.code === category.code) } : full;
  return (
    <>
      {back}
      <PageHeader eyebrow="New Financing Request" title={p.name} intro={category ? "Choose the customer's legal form and the financing structure. Your draft is saved on the server and can be resumed at any time." : "Choose the customer profile and the financing structure. Your draft is saved on the server and can be resumed at any time."} />
      <NewRetailForm products={[cat]} roles={options} defaultRole={def} category={category ? { title: category.title, changeHref: `/requests/new?prefer=${category.slug}` } : null} />
    </>
  );
}
