"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";
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
          <dt>Markup{t ? ` (${formatRateE4(t.effectiveRateE4)} of the price)` : ""}</dt>
          <dd>{t ? formatNaira(t.markupKobo) : "—"}</dd>
        </div>
        <div>
          <dt>Price with markup</dt>
          <dd>{t ? formatNaira(priceKobo + t.markupKobo) : "—"}</dd>
        </div>
        <div>
          <dt>Down payment (fixed)</dt>
          <dd>−{formatNaira(downKobo)}</dd>
        </div>
        <div className="alt-breakdown-total">
          <dt>Balance in instalments</dt>
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

type Lookup = { state: "idle" } | { state: "busy" } | { state: "found"; name: string } | { state: "missing" } | { state: "error"; message: string };

function useAccountLookup(account: string, bank: string, enabled: boolean): Lookup {
  const [r, setR] = useState<Lookup>({ state: "idle" });
  useEffect(() => {
    if (!enabled || !/^\d{10}$/.test(account) || !bank) {
      setR({ state: "idle" });
      return;
    }
    let live = true;
    setR({ state: "busy" });
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/altphones/resolve-account?account=${account}&bank=${encodeURIComponent(bank)}`, { cache: "no-store" });
        const body = await res.json();
        if (!live) return;
        if (body.status === "FOUND") setR({ state: "found", name: body.accountName });
        else if (body.status === "NOT_FOUND") setR({ state: "missing" });
        else setR({ state: "error", message: body.message ?? "Lookup unavailable." });
      } catch {
        if (live) setR({ state: "error", message: "Lookup unavailable." });
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [account, bank, enabled]);
  return r;
}

function LookupNote({ r }: { r: Lookup }) {
  if (r.state === "busy") return <span className="hint">Looking up the account name…</span>;
  if (r.state === "found")
    return (
      <span className="acct-name" role="status">
        <CheckCircle2 className="icon" aria-hidden="true" /> {r.name}
      </span>
    );
  if (r.state === "missing") return <span className="err">No account with this number at this bank.</span>;
  if (r.state === "error") return <span className="hint">{r.message} The name is checked again when you continue.</span>;
  return null;
}

/**
 * The customer's two repayment accounts. With Paystack configured, the other bank is chosen from Paystack's
 * list and both account names are looked up as the officer types; the server repeats the lookup on save.
 */
export function AccountFields({ banks, abAccount, externalAccount, externalBankCode, externalBankName, abBankCode }: { banks: { code: string; name: string }[] | null; abAccount: string; externalAccount: string; externalBankCode: string; externalBankName: string; abBankCode: string }) {
  const lookup = !!banks;
  const [ab, setAb] = useState(abAccount);
  const [ext, setExt] = useState(externalAccount);
  const [bank, setBank] = useState(externalBankCode);
  const abR = useAccountLookup(ab, abBankCode, lookup);
  const extR = useAccountLookup(ext, bank, lookup);
  return (
    <>
      <div className="field">
        <label htmlFor="abAccount">Alternative Bank account number</label>
        <input id="abAccount" name="abAccount" inputMode="numeric" maxLength={10} pattern="[0-9]{10}" value={ab} onChange={(e) => setAb(e.target.value.replace(/\D/g, ""))} required className="mono" />
        <LookupNote r={abR} />
      </div>
      <div className="field">
        <label htmlFor="externalBank">Other bank used regularly</label>
        {lookup ? (
          <select id="externalBank" name="externalBankCode" value={bank} onChange={(e) => setBank(e.target.value)} required>
            <option value="">Choose the bank</option>
            {banks!.map((b) => (
              <option key={b.code} value={b.code}>
                {b.name}
              </option>
            ))}
          </select>
        ) : (
          <input id="externalBank" name="externalBank" defaultValue={externalBankName} required placeholder="Bank name" />
        )}
      </div>
      <div className="field">
        <label htmlFor="externalAccount">Account number at that bank</label>
        <input id="externalAccount" name="externalAccount" inputMode="numeric" maxLength={10} pattern="[0-9]{10}" value={ext} onChange={(e) => setExt(e.target.value.replace(/\D/g, ""))} required className="mono" />
        <LookupNote r={extR} />
        <span className="hint">The Paystack Direct Debit mandate is set up on this account.</span>
      </div>
    </>
  );
}
