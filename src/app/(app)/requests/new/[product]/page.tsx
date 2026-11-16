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
import { availability, initiatorRolesFor, originationSettings, retailCatalogue } from "../catalogue";

export async function generateMetadata({ params }: { params: Promise<{ product: string }> }) {
  return { title: `New ${originationProduct((await params).product)?.name ?? "Financing"} Request` };
}

export default async function NewProductRequest({ params }: { params: Promise<{ product: string }> }) {
  const p = originationProduct((await params).product);
  if (!p) notFound();
  const { roles, session } = await requireUser();
  if (session.activeRole === "DELIGHT_OFFICER" || session.activeRole === "SMILE_ASSOCIATE") redirect("/altphones");
  const mine = initiatorRolesFor(p, roles, (await originationSettings(db))[p.code]);
  if (!mine.length) redirect("/forbidden");
  const now = new Date();
  const a = await availability(db, p, roles, now);
  const def = mine.includes(session.activeRole as never) ? session.activeRole! : mine[0];
  const options = mine.map((r) => ({ value: r, label: ROLE_LABELS[r] }));
  const back = (
    <Link href="/requests/new" className="btn btn-ghost btn-sm" style={{ marginBottom: "var(--space-3)" }}>
      <ArrowLeft className="icon" aria-hidden="true" /> All products
    </Link>
  );
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
  const cat = await retailCatalogue(db, p.code, now);
  if (!cat) notFound();
  return (
    <>
      {back}
      <PageHeader eyebrow="New Financing Request" title={p.name} intro="Choose the customer profile and the financing structure. Your draft is saved on the server and can be resumed at any time." />
      <NewRetailForm products={[cat]} roles={options} defaultRole={def} />
    </>
  );
}
