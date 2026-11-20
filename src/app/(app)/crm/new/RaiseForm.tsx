"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { raiseComplaintAction } from "../actions";

interface Opt {
  code: string;
  name: string;
}
interface Cat {
  id: string;
  name: string;
}
interface Sub {
  id: string;
  category_id: string;
  name: string;
  product_code: string | null;
}
interface Dup {
  id: string;
  ref: string;
  subject: string;
  status: string;
  visible: boolean;
}

export function RaiseForm({ products, categories, subcategories, prefill }: { products: Opt[]; categories: Cat[]; subcategories: Sub[]; prefill: { applicationId: string; ref: string; productCode: string | null } | null }) {
  const [product, setProduct] = useState(prefill?.productCode ?? "");
  const [cat, setCat] = useState("");
  const [sub, setSub] = useState("");
  const forProduct = useMemo(() => subcategories.filter((s) => !s.product_code || s.product_code === product), [subcategories, product]);
  const cats = useMemo(() => categories.filter((c) => forProduct.some((s) => s.category_id === c.id)), [categories, forProduct]);
  const subs = forProduct.filter((s) => s.category_id === cat);
  const general = subs.filter((s) => !s.product_code);
  const specific = subs.filter((s) => s.product_code);
  const productName = products.find((p) => p.code === product)?.name ?? "";
  return (
    <ActionForm action={raiseComplaintAction} encType="multipart/form-data" className="stack">
      {(st) => {
        const dups = ((st.data as { duplicates?: Dup[] } | undefined)?.duplicates ?? []) as Dup[];
        return (
          <>
            {prefill && <input type="hidden" name="applicationId" value={prefill.applicationId} />}
            <div className="card stack">
              <h2 style={{ fontSize: 16 }}>1. What is affected?</h2>
              <div className="field">
                <label htmlFor="c-product">Product or platform area</label>
                <select
                  id="c-product"
                  name="productCode"
                  required
                  value={product}
                  onChange={(e) => {
                    setProduct(e.target.value);
                    setCat("");
                    setSub("");
                  }}
                >
                  <option value="">Choose…</option>
                  {products.map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {st.fields?.productCode && <span className="err">{st.fields.productCode}</span>}
              </div>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="c-cat">Category</label>
                  <select
                    id="c-cat"
                    name="categoryId"
                    required
                    disabled={!product}
                    value={cat}
                    onChange={(e) => {
                      setCat(e.target.value);
                      setSub("");
                    }}
                  >
                    <option value="">{product ? "Choose…" : "Choose the product first"}</option>
                    {cats.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {st.fields?.categoryId && <span className="err">{st.fields.categoryId}</span>}
                </div>
                <div className="field">
                  <label htmlFor="c-sub">Specific issue</label>
                  <select id="c-sub" name="subcategoryId" required disabled={!cat} value={sub} onChange={(e) => setSub(e.target.value)}>
                    <option value="">{cat ? "Choose…" : "Choose the category first"}</option>
                    {general.length > 0 && (
                      <optgroup label="General">
                        {general.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {specific.length > 0 && (
                      <optgroup label={productName}>
                        {specific.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  {st.fields?.subcategoryId && <span className="err">{st.fields.subcategoryId}</span>}
                </div>
              </div>
            </div>
            <div className="card stack">
              <h2 style={{ fontSize: 16 }}>2. Describe the complaint</h2>
              <div className="field">
                <label htmlFor="c-subject">Subject</label>
                <input id="c-subject" name="subject" required minLength={5} maxLength={150} placeholder="e.g. Request stuck with the Unit Head for two days" />
                {st.fields?.subject && <span className="err">{st.fields.subject}</span>}
              </div>
              <div className="field">
                <label htmlFor="c-desc">What happened?</label>
                <textarea id="c-desc" name="description" required minLength={10} maxLength={5000} rows={5} placeholder="What you were doing, what you expected, and what happened instead. Do not include passwords or full account numbers." />
                {st.fields?.description && <span className="err">{st.fields.description}</span>}
              </div>
              <div className="field">
                <label htmlFor="c-ref">Related financing request reference (optional)</label>
                {prefill ? (
                  <input id="c-ref" value={prefill.ref} readOnly aria-readonly="true" />
                ) : (
                  <input id="c-ref" name="requestRef" maxLength={40} placeholder="e.g. WB-2026-001074" autoComplete="off" />
                )}
                <span className="hint">A request you can open in ARAF is linked; other references are recorded as text.</span>
                {st.fields?.requestRef && <span className="err">{st.fields.requestRef}</span>}
              </div>
              <div className="field">
                <label htmlFor="c-files">Supporting evidence (optional, up to 5 files: PDF, PNG, JPG, DOCX, XLSX)</label>
                <input id="c-files" type="file" name="files" multiple accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx" />
              </div>
              <div>
                <label className="check">
                  <input type="checkbox" name="urgent" /> This is urgent for me
                </label>
                <p className="small muted" style={{ margin: "4px 0 0 28px" }}>
                  Recorded for the team. Priority is set by the bank&apos;s rules for the issue.
                </p>
              </div>
            </div>
            {dups.length > 0 && (
              <div className="alert alert-warn" role="alert">
                <div>
                  <strong>A similar complaint is already open.</strong>
                  <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
                    {dups.map((d) => (
                      <li key={d.id}>
                        {d.visible ? (
                          <Link href={`/crm/tickets/${d.id}`}>
                            {d.ref} — {d.subject}
                          </Link>
                        ) : (
                          <>{d.ref} (raised by a colleague for the same request)</>
                        )}
                      </li>
                    ))}
                  </ul>
                  <label className="check">
                    <input type="checkbox" name="confirmDuplicate" /> This is a different issue: raise a new complaint anyway
                  </label>
                </div>
              </div>
            )}
            <div className="row">
              <SubmitButton>Submit complaint</SubmitButton>
              <span className="small muted">You do not need to choose a team: ARAF routes it automatically.</span>
            </div>
          </>
        );
      }}
    </ActionForm>
  );
}
