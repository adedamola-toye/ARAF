"use client";
import { useMemo, useRef, useState } from "react";
import { CONTRACT_PLACEHOLDER_KEYS, CONTRACT_PLACEHOLDERS, renderContract, SAMPLE_CONTRACT_VALUES, unknownPlaceholders } from "@/lib/altphones-contract";
import { computeTerms, formatNaira, formatRateE4, type MarkupBasis } from "@/lib/altphones";

/** Tenure picker with the live repayment breakdown (the server recalculates everything on save). */
export function TenureCalculator({
  priceKobo,
  downKobo,
  rates,
  basis,
  tenures,
  defaultTenure,
  name = "tenure",
  readOnly = false,
}: {
  priceKobo: number;
  downKobo: number;
  rates: Record<string, number>;
  basis: MarkupBasis | null;
  tenures: number[];
  defaultTenure?: number | null;
  name?: string;
  readOnly?: boolean;
}) {
  const configured = tenures.filter((t) => rates[String(t)] !== undefined && basis);
  const [tenure, setTenure] = useState<number | null>(defaultTenure && configured.includes(defaultTenure) ? defaultTenure : null);
  const t = useMemo(() => (tenure && basis ? computeTerms({ priceKobo, downPaymentKobo: downKobo, tenureMonths: tenure, rateE4: rates[String(tenure)], basis }) : null), [tenure, basis, priceKobo, downKobo, rates]);
  return (
    <div className="alt-calc">
      <fieldset className="alt-tenures" disabled={readOnly}>
        <legend>Tenure</legend>
        {tenures.map((m) => {
          const ok = configured.includes(m);
          return (
            <label key={m} className={`alt-tenure ${tenure === m ? "is-on" : ""} ${ok ? "" : "is-off"}`}>
              <input type="radio" name={name} value={m} checked={tenure === m} disabled={!ok} onChange={() => setTenure(m)} />
              <span className="alt-tenure-m">{m}</span>
              <span className="alt-tenure-l">months</span>
              {ok && basis ? <span className="alt-tenure-i">{formatNaira(computeTerms({ priceKobo, downPaymentKobo: downKobo, tenureMonths: m, rateE4: rates[String(m)], basis }).instalmentKobo)}/mo</span> : <span className="alt-tenure-i">Not configured</span>}
            </label>
          );
        })}
      </fieldset>
      <dl className="alt-breakdown" aria-live="polite">
        <div>
          <dt>Phone price</dt>
          <dd>{formatNaira(priceKobo)}</dd>
        </div>
        <div>
          <dt>Down payment (fixed)</dt>
          <dd>{formatNaira(downKobo)}</dd>
        </div>
        <div>
          <dt>Amount financed</dt>
          <dd>{formatNaira(priceKobo - downKobo)}</dd>
        </div>
        <div>
          <dt>Markup{t ? ` (${formatRateE4(t.effectiveRateE4)})` : ""}</dt>
          <dd>{t ? formatNaira(t.markupKobo) : "—"}</dd>
        </div>
        <div className="alt-breakdown-total">
          <dt>Total repayment</dt>
          <dd>{t ? formatNaira(t.totalRepaymentKobo) : "—"}</dd>
        </div>
        <div className="alt-breakdown-hero">
          <dt>Monthly instalment</dt>
          <dd>
            {t ? formatNaira(t.instalmentKobo) : "Choose a tenure"}
            {t && t.finalInstalmentKobo !== t.instalmentKobo && <span className="small muted"> · final {formatNaira(t.finalInstalmentKobo)}</span>}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** Copy-to-clipboard for payment links (falls back to selecting the text). */
export function CopyLink({ url }: { url: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="alt-copy">
      <input readOnly value={url} aria-label="Payment link" onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        className="btn btn-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setDone(true);
            setTimeout(() => setDone(false), 2000);
          } catch {
            /* clipboard unavailable: the field is selectable */
          }
        }}
      >
        {done ? "Copied" : "Copy link"}
      </button>
      <a className="btn btn-sm btn-ghost" href={url} target="_blank" rel="noopener noreferrer">
        Open
      </a>
    </div>
  );
}

/**
 * Contract wording editor: plain textarea plus a live preview with example figures and a placeholder
 * reference (click to insert at the cursor). Unknown placeholders are highlighted before saving.
 */
export function ContractEditor({ initial, isDraft }: { initial: string; isDraft: boolean }) {
  const [text, setText] = useState(initial);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const ref = useRef<HTMLTextAreaElement>(null);
  const unknown = unknownPlaceholders(text);
  const insert = (k: string) => {
    const el = ref.current;
    const token = `{{${k}}}`;
    if (!el) return setText((t) => t + token);
    const s = el.selectionStart ?? text.length;
    const e = el.selectionEnd ?? s;
    const next = text.slice(0, s) + token + text.slice(e);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + token.length, s + token.length);
    });
  };
  return (
    <div className="alt-contract-editor">
      <div className="tabs" role="tablist" aria-label="Contract view">
        <button type="button" role="tab" className={`tab alt-tab-btn ${view === "edit" ? "is-on" : ""}`} aria-selected={view === "edit"} onClick={() => setView("edit")}>
          Edit wording
        </button>
        <button type="button" role="tab" className={`tab alt-tab-btn ${view === "preview" ? "is-on" : ""}`} aria-selected={view === "preview"} onClick={() => setView("preview")}>
          Preview with example figures
        </button>
      </div>
      {isDraft && <p className="small alt-draft-note">This is the standard starting draft. Complete the bracketed notes with Legal and Shariah and remove the draft line before saving — saving puts it in force for new contracts.</p>}
      <div className="alt-contract-grid">
        <div>
          <input type="hidden" name="template" value={text} />
          {view === "edit" ? (
            <>
              <label htmlFor="template" className="sr-only">
                Contract wording
              </label>
              <textarea id="template" ref={ref} value={text} onChange={(e) => setText(e.target.value)} rows={28} className="alt-contract-text" spellCheck />
            </>
          ) : (
            <pre className="alt-contract-body alt-contract-preview" aria-label="Preview with example figures">
              {renderContract(text, SAMPLE_CONTRACT_VALUES)}
            </pre>
          )}
          {unknown.length > 0 && (
            <p className="err" role="alert">
              Unknown placeholders: {unknown.map((u) => `{{${u}}}`).join(", ")}
            </p>
          )}
          <p className="small muted">
            {text.length.toLocaleString()} characters · {(text.match(/\{\{\s*[a-z_]+\s*\}\}/g) ?? []).length} placeholders
          </p>
        </div>
        <aside className="alt-placeholders" aria-label="Placeholders">
          <p className="small" style={{ marginTop: 0 }}>
            <strong>Placeholders</strong> — filled in for each customer. Click to insert.
          </p>
          <ul>
            {CONTRACT_PLACEHOLDER_KEYS.map((k) => (
              <li key={k}>
                <button type="button" className="alt-ph" onClick={() => insert(k)} disabled={view !== "edit"}>
                  <code>{`{{${k}}}`}</code>
                  <span>{CONTRACT_PLACEHOLDERS[k]}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
