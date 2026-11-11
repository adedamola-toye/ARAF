"use client";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";

/** Keep digits and at most one decimal point with two decimals. Returns the canonical (unformatted) value. */
export function sanitizeAmount(raw: string): string {
  let s = raw.replace(/[^\d.]/g, "");
  const dot = s.indexOf(".");
  if (dot >= 0) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "").slice(0, 2);
  s = s.replace(/^0+(?=\d)/, "");
  return s;
}

/** 50000000.5 → "50,000,000.5" (grouping only; decimals kept as typed). */
export function groupAmount(canonical: string): string {
  if (!canonical) return "";
  const [i, f] = canonical.split(".");
  const grouped = (i || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return f !== undefined ? `${grouped}.${f}` : grouped;
}

export function formatNaira(kobo: number | null | undefined): string {
  if (kobo === null || kobo === undefined) return "—";
  return "₦" + (kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function amountToKobo(canonical: string): number | null {
  const m = /^(\d{1,13})(?:\.(\d{0,2}))?$/.exec(canonical);
  if (!m) return null;
  return Number(BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0"));
}

/**
 * Naira amount input: thousands separators while typing, a visible ₦ prefix, at most two decimal places,
 * caret preserved across reformatting (counted by digits before the caret), and paste/delete friendly.
 * The value passed to `onChange` is the canonical unformatted string (e.g. "50000000.5").
 */
export function AmountInput({
  id,
  value,
  onChange,
  invalid,
  describedBy,
  max,
  label,
}: {
  id: string;
  value: string;
  onChange: (canonical: string) => void;
  invalid?: boolean;
  describedBy?: string;
  max?: number | null;
  label?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const display = groupAmount(value);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || caret.current === null || document.activeElement !== el) return;
    // Place the caret after the same number of significant characters (digits and the decimal point).
    let seen = 0;
    let pos = display.length;
    for (let i = 0; i < display.length; i++) {
      if (seen === caret.current) {
        pos = i;
        break;
      }
      if (/[\d.]/.test(display[i])) seen++;
    }
    if (seen === caret.current && caret.current === 0) pos = 0;
    el.setSelectionRange(pos, pos);
    caret.current = null;
  });
  const kobo = amountToKobo(value);
  const overMax = max != null && kobo !== null && kobo > max;
  return (
    <div className={`money-input ${invalid || overMax ? "invalid" : ""}`}>
      <span className="money-prefix" aria-hidden="true">₦</span>
      <input
        ref={ref}
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={display}
        aria-invalid={invalid || overMax}
        aria-describedby={describedBy}
        aria-label={label}
        onChange={(e) => {
          const el = e.currentTarget;
          const before = el.value.slice(0, el.selectionStart ?? el.value.length);
          const sanitizedBefore = sanitizeAmount(before);
          const next = sanitizeAmount(el.value);
          caret.current = Math.min(sanitizedBefore.length, next.length);
          onChange(next);
        }}
      />
    </div>
  );
}

/**
 * Fixed-length numeric identifier (Nigerian phone, BVN): digits only, leading zeros preserved, shows how
 * many digits are entered and an inline error once the field is left incomplete. Format checks are not
 * verification.
 */
export function DigitsInput({
  id,
  value,
  onChange,
  length = 11,
  kind,
  invalid,
  serverError,
  placeholder,
  fieldLabel,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  length?: number;
  kind: "tel" | "bvn";
  invalid?: boolean;
  serverError?: string;
  placeholder?: string;
  fieldLabel?: string;
}) {
  const [touched, setTouched] = useState(false);
  const [edited, setEdited] = useState(false);
  const hintId = useId();
  const local = touched && value.length > 0 && value.length !== length ? `${fieldLabel ?? (kind === "tel" ? "Phone number" : "BVN")} must be exactly ${length} digits (${value.length} entered).` : "";
  // The live check wins; a server message is shown until the user edits the field.
  const err = local || (!edited ? serverError : "");
  return (
    <>
      <input
        id={id}
        type={kind === "tel" ? "tel" : "text"}
        inputMode={kind === "tel" ? "tel" : "numeric"}
        autoComplete={kind === "tel" ? "tel-national" : "off"}
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid || !!err}
        aria-describedby={hintId}
        onBlur={() => setTouched(true)}
        onChange={(e) => {
          setEdited(true);
          onChange(e.currentTarget.value.replace(/\D/g, "").slice(0, length));
        }}
        onPaste={(e) => {
          const t = e.clipboardData.getData("text");
          if (/\D/.test(t)) {
            e.preventDefault();
            onChange(t.replace(/\D/g, "").slice(0, length));
          }
        }}
      />
      <span id={hintId} className={err ? "err" : "hint"} role={err ? "alert" : undefined}>
        {err || `${value.length}/${length} digits${kind === "bvn" && !fieldLabel ? " · format check only, not BVN verification" : ""}`}
      </span>
    </>
  );
}

export interface SearchOption {
  value: string;
  label: string;
  hint?: string;
  aliases?: string[];
  disabled?: boolean;
}

/** Searchable select: type to filter by name or alias, then choose. Keyboard and screen-reader friendly. */
export function SearchSelect({ id, options, value, onChange, placeholder = "Type to search", size = 6, invalid }: { id: string; options: SearchOption[]; value: string; onChange: (v: string) => void; placeholder?: string; size?: number; invalid?: boolean }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return options;
    return options.filter((o) => o.label.toLowerCase().includes(t) || (o.aliases ?? []).some((a) => a.toLowerCase().includes(t)) || o.value.toLowerCase().includes(t));
  }, [q, options]);
  const selected = options.find((o) => o.value === value);
  return (
    <div className="search-select">
      <input type="search" aria-controls={id} aria-label="Filter the list" placeholder={placeholder} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
      <select id={id} size={Math.min(size, Math.max(2, filtered.length + 1))} value={value} aria-invalid={invalid} onChange={(e) => onChange(e.currentTarget.value)}>
        <option value="">{filtered.length ? "— Select —" : "No matches"}</option>
        {filtered.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
            {o.hint ? ` — ${o.hint}` : ""}
          </option>
        ))}
      </select>
      {selected && <span className="hint">Selected: {selected.label}{selected.hint ? ` (${selected.hint})` : ""}</span>}
    </div>
  );
}
