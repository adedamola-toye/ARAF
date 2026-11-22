/**
 * Skeleton shown in the content area while a page's data loads (navigation and header stay in place).
 * Shapes follow the common page layout: heading, a row of figures, then a list.
 */
export default function Loading() {
  return (
    <div className="skeleton-page" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="sk sk-eyebrow" />
      <div className="sk sk-title" />
      <div className="sk sk-line" style={{ width: "48%" }} />
      <div className="sk-figures">
        {[0, 1, 2].map((i) => (
          <div key={i} className="sk-figure">
            <div className="sk sk-label" />
            <div className="sk sk-value" />
          </div>
        ))}
      </div>
      <div className="sk-list">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="sk-row">
            <div style={{ flex: 1, display: "grid", gap: 6 }}>
              <div className="sk sk-line" style={{ width: "36%" }} />
              <div className="sk sk-line sk-thin" style={{ width: "58%" }} />
            </div>
            <div className="sk sk-amount" />
          </div>
        ))}
      </div>
    </div>
  );
}
