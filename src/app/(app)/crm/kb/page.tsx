import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { crmCatalogue, crmPrincipal, isOperator } from "@/server/crm/core";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { KbEditor } from "./KbEditor";

export const metadata = { title: "Knowledge base" };

export default async function KnowledgeBase({ searchParams }: { searchParams: Promise<{ q?: string; edit?: string }> }) {
  const { session } = await requireUser();
  const p = await crmPrincipal(db, session.staffId);
  if (!isOperator(p)) redirect("/crm");
  const sp = await searchParams;
  const canPublish = p.isCxHead || p.isAdmin;
  const q = sp.q?.trim().slice(0, 60) ?? "";
  const rows = (
    await db.query<{ id: string; title: string; body: string; category_id: string | null; category: string | null; status: string; updated_at: Date; author: string }>(
      `SELECT k.id, k.title, k.body, k.category_id, c.name AS category, k.status, k.updated_at, s.full_name AS author
         FROM crm_kb_articles k LEFT JOIN crm_categories c ON c.id = k.category_id JOIN staff s ON s.id = k.updated_by
        WHERE ($1 OR k.status = 'PUBLISHED') AND ($2 = '' OR k.title ILIKE '%' || $2 || '%' OR k.body ILIKE '%' || $2 || '%')
        ORDER BY c.sort_order NULLS LAST, k.title`,
      [canPublish, q.replace(/[%_]/g, "")],
    )
  ).rows;
  const { categories } = await crmCatalogue(db);
  const editing = canPublish && sp.edit ? rows.find((r) => r.id === sp.edit) ?? null : null;
  return (
    <>
      <PageHeader eyebrow="CRM" title="Knowledge base" intro="Approved resolution guidance for recurring issues. Only the CX Head and Super Admin publish or change articles." />
      <form className="row" role="search" style={{ marginBottom: "var(--space-4)" }}>
        <label className="sr-only" htmlFor="kb-q">
          Search guidance
        </label>
        <input id="kb-q" name="q" defaultValue={q} placeholder="Search guidance" style={{ maxWidth: 360 }} />
        <button className="btn">Search</button>
      </form>
      <div className="split">
        <section className="stack" style={{ minWidth: 0 }}>
          {rows.map((r) => (
            <details key={r.id} className="card">
              <summary>
                <strong>{r.title}</strong>
                <span className="small muted">
                  {" "}
                  · {r.category ?? "General"} · {r.status === "PUBLISHED" ? `updated ${formatLagos(r.updated_at)}` : r.status.toLowerCase()}
                </span>
              </summary>
              <p style={{ whiteSpace: "pre-wrap" }}>{r.body}</p>
              {canPublish && (
                <a className="btn btn-sm" href={`/crm/kb?edit=${r.id}`}>
                  Edit
                </a>
              )}
            </details>
          ))}
          {!rows.length && <p className="muted">No guidance published yet.</p>}
        </section>
        {canPublish && (
          <aside className="split-right">
            <KbEditor key={editing?.id ?? "new"} categories={categories.map((c) => ({ id: c.id, name: c.name }))} article={editing ? { id: editing.id, title: editing.title, body: editing.body, categoryId: editing.category_id, status: editing.status } : null} />
          </aside>
        )}
      </div>
    </>
  );
}
