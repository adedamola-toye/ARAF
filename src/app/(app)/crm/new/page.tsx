import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { crmCatalogue, crmProducts } from "@/server/crm/core";
import { caseAccess } from "@/server/domain/access";
import { PageHeader } from "@/components/PageHeader";
import { RaiseForm } from "./RaiseForm";

export const metadata = { title: "Raise a complaint" };

export default async function RaiseComplaint({ searchParams }: { searchParams: Promise<{ app?: string }> }) {
  const { session } = await requireUser();
  const sp = await searchParams;
  const products = await crmProducts(db);
  const { categories, subcategories } = await crmCatalogue(db);
  let prefill: { applicationId: string; ref: string; productCode: string | null } | null = null;
  // Raised from a request page: prefill the reference only if the user can already open that request.
  if (sp.app && /^[0-9a-f-]{36}$/i.test(sp.app) && (await caseAccess(db, session.staffId, sp.app)).canView) {
    const a = (await db.query<{ ref: string; product_code: string | null }>("SELECT ref, product_code FROM applications WHERE id = $1", [sp.app])).rows[0];
    if (a) prefill = { applicationId: sp.app, ref: a.ref, productCode: products.some((p) => p.code === (a.product_code ?? "WAKEELBOOST")) ? (a.product_code ?? "WAKEELBOOST") : null };
  }
  return (
    <>
      <PageHeader eyebrow="CRM" title="Raise a complaint" intro="Tell us what went wrong. You get a ticket reference straight away and can follow it under My Tickets." crumbs={[{ href: "/crm", label: "CRM" }, { label: "Raise a complaint" }]} />
      <div style={{ maxWidth: 820 }}>
        <RaiseForm products={products} categories={categories.map((c) => ({ id: c.id, name: c.name }))} subcategories={subcategories.map((s) => ({ id: s.id, category_id: s.category_id, name: s.name, product_code: s.product_code }))} prefill={prefill} />
      </div>
    </>
  );
}
