"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { saveChecklistAction } from "./actions";

export function ChecklistForm({ product, items }: { product: string; items: { code: string; label: string; state: "REQUIRED" | "OPTIONAL" | "OFF" }[] }) {
  return (
    <ActionForm action={saveChecklistAction} className="stack">
      {(st) => (
        <>
          <input type="hidden" name="product" value={product} />
          <div className="table-wrap">
            <table className="data small">
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">Required</th>
                  <th scope="col">Optional</th>
                  <th scope="col">Not used</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.code}>
                    <td>{i.label}</td>
                    {(["REQUIRED", "OPTIONAL", "OFF"] as const).map((v) => (
                      <td key={v}>
                        <input type="radio" name={`item_${i.code}`} value={v} defaultChecked={i.state === v} aria-label={`${i.label}: ${v.toLowerCase()}`} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="field">
            <label htmlFor={`r-${product}`}>Reason for the change</label>
            <input id={`r-${product}`} name="reason" required minLength={20} />
            {st.fields?.reason && <span className="err">{st.fields.reason}</span>}
          </div>
          <div>
            <SubmitButton className="btn btn-sm btn-primary">Save checklist</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
