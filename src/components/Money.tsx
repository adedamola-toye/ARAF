/**
 * Financial figure: the label on its own line, then the amount with clear hierarchy.
 *
 *   <Money label="Monthly repayment" kobo={239583333} size="lg" />
 *     Monthly repayment
 *     ₦2,395,833.33
 *
 * Amounts are integer kobo and are formatted with BigInt arithmetic (never floating point). Sizes are
 * responsive design tokens (see araf-theme.css). `private` lets the person hide amounts on shared screens.
 */
export type MoneyValue = number | string | bigint | null | undefined;

export interface MoneyParts {
  negative: boolean;
  naira: string; // grouped, e.g. "2,395,833"
  kobo: string; // two digits
}

export function moneyParts(v: MoneyValue): MoneyParts | null {
  if (v === null || v === undefined || v === "") return null;
  let k: bigint;
  try {
    k = typeof v === "bigint" ? v : BigInt(typeof v === "number" ? Math.trunc(v) : String(v).trim());
  } catch {
    return null;
  }
  const negative = k < 0n;
  const abs = negative ? -k : k;
  return { negative, naira: (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","), kobo: (abs % 100n).toString().padStart(2, "0") };
}

/** Plain text for screen readers, exports and titles: "₦2,395,833.33", "-₦1,000.00", "—". */
export function moneyText(v: MoneyValue): string {
  const p = moneyParts(v);
  return p ? `${p.negative ? "-" : ""}₦${p.naira}.${p.kobo}` : "—";
}

export function Money({
  kobo,
  label,
  hint,
  size = "md",
  as: Tag = "div",
  private: priv = false,
  loading = false,
  smallDecimals,
  className = "",
}: {
  kobo: MoneyValue;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  size?: "hero" | "lg" | "md" | "sm" | "table";
  as?: "div" | "span" | "td";
  private?: boolean;
  loading?: boolean;
  /** Smaller kobo digits; default on for hero and large balances. */
  smallDecimals?: boolean;
  className?: string;
}) {
  const p = moneyParts(kobo);
  const small = smallDecimals ?? (size === "hero" || size === "lg");
  const text = moneyText(kobo);
  const cls = ["fig", `fig-${size}`, p?.negative ? "fig-negative" : "", loading ? "fig-loading" : "", className].filter(Boolean).join(" ");
  return (
    <Tag className={cls} data-private={priv ? "" : undefined}>
      {label !== undefined && <span className="fig-label">{label}</span>}
      <span className="fig-value" aria-label={loading ? "Loading amount" : text} aria-busy={loading || undefined}>
        {loading || !p ? (
          <span>{loading ? "₦0.00" : "—"}</span>
        ) : (
          <span aria-hidden="true">
            {p.negative && "-"}
            <span className="fig-cur">₦</span>
            {p.naira}
            <span className={small ? "fig-dec" : undefined}>.{p.kobo}</span>
          </span>
        )}
      </span>
      {hint !== undefined && <span className="fig-hint">{hint}</span>}
    </Tag>
  );
}
