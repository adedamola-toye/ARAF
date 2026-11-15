import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { requireSuperAdmin } from "../../guard";
import { db } from "@/server/db";
import { activeWorkflow, workflowHistory, workflowVersionById } from "@/server/domain/approval-workflows";
import { effectiveConfig } from "@/server/domain/products";
import { auditReference, workflowProduct } from "@/lib/approval-workflow";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { WorkflowEditor, RestoreForm } from "../WorkflowEditor";

export async function generateMetadata({ params }: { params: Promise<{ code: string }> }) {
  return { title: `${workflowProduct((await params).code)?.name ?? "Product"} approval workflow` };
}

export default async function WorkflowPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ published?: string }> }) {
  await requireSuperAdmin();
  const product = workflowProduct((await params).code);
  if (!product) notFound();
  const [current, history] = await Promise.all([activeWorkflow(db, product.code), workflowHistory(db, product.code)]);
  const pid = (await searchParams).published;
  const published = pid && /^[0-9a-f-]{36}$/.test(pid) ? await workflowVersionById(db, pid) : null;
  const cfg = product.family === "RETAIL" ? await effectiveConfig(db, product.code, new Date()) : null;
  const productConfig = cfg ? { policy: cfg.config.approvalPolicy, headOfUnitDistinct: cfg.config.businessReview.headOfUnitStage === "DISTINCT", version: cfg.version } : null;
  return (
    <>
      <Link href="/admin/workflows" className="btn btn-ghost btn-sm" style={{ marginBottom: "var(--space-3)" }}>
        <ArrowLeft className="icon" aria-hidden="true" /> All products
      </Link>
      <PageHeader
        eyebrow="Approval Workflow Management"
        title={product.name}
        intro={`Version ${current.version}, published ${formatLagos(current.published_at)}${current.published_by_name ? ` by ${current.published_by_name}` : " (the original routing)"}.`}
      />
      {published && published.product_code === product.code && (
        <div className="alert alert-success wf-published" role="status">
          <CheckCircle2 className="icon" aria-hidden="true" />
          <div>
            <strong>Published.</strong> {product.name} approval workflow version {published.version} is active from {formatLagos(published.published_at)} for requests submitted from now on. Requests already submitted keep their workflow.
            <dl className="wf-meta">
              <div>
                <dt>Product</dt>
                <dd>{product.name}</dd>
              </div>
              <div>
                <dt>New version</dt>
                <dd>{published.version}</dd>
              </div>
              <div>
                <dt>Effective</dt>
                <dd>{formatLagos(published.published_at)}</dd>
              </div>
              <div>
                <dt>Audit reference</dt>
                <dd className="mono">{auditReference(product.code, published.version, published.id)}</dd>
              </div>
            </dl>
          </div>
        </div>
      )}
      <WorkflowEditor key={current.id} product={product} current={current.definition} version={current.version} productConfig={productConfig} />
      <section className="card" aria-labelledby="history" style={{ marginTop: "var(--space-5)" }}>
        <div className="card-head">
          <h2 id="history">Version history</h2>
        </div>
        <ol className="wf-history">
          {history.map((h) => (
            <li key={h.id}>
              <div className="wf-history-head">
                <strong>Version {h.version}</strong>
                {h.version === current.version && <span className="badge badge-green">Active</span>}
                <span className="small muted">
                  {formatLagos(h.published_at)} · {h.published_by_name ? `${h.published_by_name} (Super Admin)` : "System"}
                </span>
              </div>
              <p className="small" style={{ margin: "4px 0" }}>
                <span className="muted">Reason:</span> {h.reason}
              </p>
              {h.changes.length > 0 && (
                <ul className="small wf-changes">
                  {h.changes.map((c, i) => (
                    <li key={i}>{c.text}</li>
                  ))}
                </ul>
              )}
              {h.version !== current.version && <RestoreForm productCode={product.code} restoreFromId={h.id} restoreVersion={h.version} expectedVersion={current.version} />}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
