import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { CHECKLIST_CANDIDATES, CHECKLIST_LABELS, checklistItems } from "@/server/domain/closing-checklist";
import { PageHeader } from "@/components/PageHeader";
import { ChecklistForm } from "./Form";

export const metadata = { title: "Closing checklists" };

export default async function ClosingChecklists() {
  await requireSuperAdmin();
  const products = (await db.query<{ code: string; name: string }>("SELECT code, name FROM products WHERE code <> 'WAKEELBOOST' ORDER BY name")).rows;
  const CATS: [string, string][] = [["BUSINESS_OWNER", "Business"], ["SALARY_EARNER", "Salaried"]];
  const all = [
    ...products.flatMap((p) => CATS.filter(([c]) => !(p.code === "VENDOR_FINANCING" && c === "SALARY_EARNER")).map(([c, l]) => ({ code: `${p.code}:${c}`, name: `${p.name} — ${l}` }))),
    { code: "WAKEELBOOST", name: "WakeelBoost" },
  ];
  const lists = await Promise.all(all.map(async (p) => ({ p, items: await checklistItems(db, p.code) })));
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Closing checklists"
        intro="Documents that must be on file, per product and customer category, before the initiator submits the offer pack. They are checked again before disbursement, together with the invoice confirmation. Evidence of delivery / acquisition is taken later, at the RM disbursement confirmation."
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
