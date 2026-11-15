import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { activeWorkflow } from "@/server/domain/approval-workflows";
import { WORKFLOW_PRODUCTS } from "@/lib/approval-workflow";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Approval workflows" };

export default async function Workflows() {
  await requireSuperAdmin();
  const rows = await Promise.all(WORKFLOW_PRODUCTS.map(async (p) => ({ p, w: await activeWorkflow(db, p.code) })));
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Approval Workflow Management"
        intro="Choose a product to view its approval workflow, change it, preview the effect and publish. Publishing needs a reason and takes effect immediately for requests submitted afterwards; requests already submitted keep the workflow they were submitted under."
      />
      <ul className="product-picker" aria-label="Products with managed approval workflows">
        {rows.map(({ p, w }) => (
          <li key={p.code}>
            <Link href={`/admin/workflows/${p.code}`} className="product-card">
              <span className="product-text">
                <strong>{p.name}</strong>
                <span>
                  Version {w.version} · published {formatLagos(w.published_at)}
                  {w.published_by_name ? ` by ${w.published_by_name}` : " (original routing)"}
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
