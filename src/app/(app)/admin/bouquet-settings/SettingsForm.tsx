"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { saveBouquetSettingsAction } from "./actions";

export interface SettingsView {
  products: { code: string; name: string; selected: boolean }[];
  maxSize: number;
  minInspections: number;
  individualReviewAbove: string;
  maxTotal: string;
  exclusionDefault: string;
}

export function SettingsForm({ v }: { v: SettingsView }) {
  return (
    <ActionForm action={saveBouquetSettingsAction}>
      {(st) => (
        <>
          <fieldset className="field">
            <legend>Eligible products</legend>
            <p className="small muted">Only these products can take part. None selected means no facility is ever added to a bouquet.</p>
            {v.products.map((p) => (
              <label key={p.code} className="check">
                <input type="checkbox" name="products" value={p.code} defaultChecked={p.selected} /> {p.name}
              </label>
            ))}
          </fieldset>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="maxSize">Maximum facilities per bouquet</label>
              <input id="maxSize" name="maxSize" type="number" min={2} max={200} defaultValue={v.maxSize} aria-invalid={!!st.fields?.maxSize} />
              {st.fields?.maxSize && <p className="err">{st.fields.maxSize}</p>}
            </div>
            <div className="field">
              <label htmlFor="minInspections">Minimum facilities inspected before concurrence</label>
              <input id="minInspections" name="minInspections" type="number" min={0} defaultValue={v.minInspections} aria-invalid={!!st.fields?.minInspections} />
              {st.fields?.minInspections && <p className="err">{st.fields.minInspections}</p>}
            </div>
            <div className="field">
              <label htmlFor="individualReviewAbove">Individual review above (₦), blank for none</label>
              <input id="individualReviewAbove" name="individualReviewAbove" inputMode="decimal" defaultValue={v.individualReviewAbove} aria-invalid={!!st.fields?.individualReviewAboveKobo} />
              {st.fields?.individualReviewAboveKobo && <p className="err">{st.fields.individualReviewAboveKobo}</p>}
            </div>
            <div className="field">
              <label htmlFor="maxTotal">Aggregate limit per bouquet (₦), blank for none</label>
              <input id="maxTotal" name="maxTotal" inputMode="decimal" defaultValue={v.maxTotal} aria-invalid={!!st.fields?.maxTotalKobo} />
              {st.fields?.maxTotalKobo && <p className="err">{st.fields.maxTotalKobo}</p>}
            </div>
          </div>
          <div className="field">
            <label htmlFor="exclusionDefault">Default for an excluded facility</label>
            <select id="exclusionDefault" name="exclusionDefault" defaultValue={v.exclusionDefault}>
              <option value="INDIVIDUAL_REVIEW">Hold for individual Divisional Head review</option>
              <option value="RETURN_FOR_CORRECTION">Return for credit correction</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="reason">Reason for the change</label>
            <input id="reason" name="reason" placeholder="e.g. Risk committee approval, minute 14/2026" aria-invalid={!!st.fields?.reason} />
            {st.fields?.reason && <p className="err">{st.fields.reason}</p>}
          </div>
          <div>
            <SubmitButton>Save settings</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
