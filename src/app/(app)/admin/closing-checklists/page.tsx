import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { CHECKLIST_CANDIDATES, CHECKLIST_LABELS, checklistItems } from "@/server/domain/closing-checklist";
import { PageHeader } from "@/components/PageHeader";
import { ChecklistForm } from "./Form";

export const metadata = { title: "Closing checklists" };

export default async function ClosingChecklists() {
  await requireSuperAdmin();
  const products = (await db.query<{ code: string; name: string }>("SELECT code, name FROM products WHERE code <> 'WAKEELBOOST' ORDER BY name")).rows;
  const all = [...products, { code: "WAKEELBOOST", name: "WakeelBoost" }];
  const lists = await Promise.all(all.map(async (p) => ({ p, items: await checklistItems(db, p.code) })));
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Closing checklists"
        intro="Documents that must be on file before the initiator submits the offer and contract pack. They are checked again before disbursement, together with the invoice confirmation. Contracting evidence is added automatically for structures with a contract sequence."
      />
      {lists.map(({ p, items }) => (
        <details key={p.code} className="card" style={{ marginBottom: "var(--space-3)" }}>
          <summary>
            <strong>{p.name}</strong> <span className="small muted">· {items.filter((i) => i.required).length} required</span>
          </summary>
          <div style={{ marginTop: 12 }}>
            <ChecklistForm
              product={p.code}
              items={CHECKLIST_CANDIDATES.map((code) => {
                const it = items.find((i) => i.code === code);
                return { code, label: CHECKLIST_LABELS[code] ?? code, state: it ? (it.required ? "REQUIRED" : "OPTIONAL") : "OFF" };
              })}
            />
          </div>
        </details>
      ))}
    </>
  );
}
