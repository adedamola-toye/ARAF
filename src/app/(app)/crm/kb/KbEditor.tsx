"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { kbAction } from "../actions";

export function KbEditor({ categories, article }: { categories: { id: string; name: string }[]; article: { id: string; title: string; body: string; categoryId: string | null; status: string } | null }) {
  return (
    <div className="card">
      <h2 style={{ fontSize: 15 }}>{article ? "Edit guidance" : "New guidance"}</h2>
      <ActionForm action={kbAction} resetOnSuccess={!article}>
        {article && <input type="hidden" name="id" value={article.id} />}
        <div className="field">
          <label htmlFor="kb-t">Title</label>
          <input id="kb-t" name="title" required minLength={5} maxLength={150} defaultValue={article?.title} />
        </div>
        <div className="field">
          <label htmlFor="kb-c">Category</label>
          <select id="kb-c" name="categoryId" defaultValue={article?.categoryId ?? ""}>
            <option value="">General</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="kb-b">Guidance</label>
          <textarea id="kb-b" name="body" rows={8} required minLength={10} defaultValue={article?.body} />
        </div>
        <div className="field">
          <label htmlFor="kb-s">Status</label>
          <select id="kb-s" name="status" defaultValue={article?.status ?? "DRAFT"}>
            <option value="DRAFT">Draft (only CX Head and Super Admin see it)</option>
            <option value="PUBLISHED">Published</option>
            <option value="RETIRED">Retired</option>
          </select>
        </div>
        <div>
          <SubmitButton>Save</SubmitButton>
        </div>
      </ActionForm>
    </div>
  );
}
