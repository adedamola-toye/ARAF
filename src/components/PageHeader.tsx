import Link from "next/link";

/** Page title block with optional breadcrumbs and actions. */
export function PageHeader({ title, intro, crumbs, actions, eyebrow }: { title: React.ReactNode; intro?: React.ReactNode; crumbs?: { href?: string; label: string }[]; actions?: React.ReactNode; eyebrow?: string }) {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0 }}>
        {crumbs && crumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="crumbs" style={{ marginBottom: 6 }}>
            {crumbs.map((c, i) => (
              <span key={i}>
                {c.href ? <Link href={c.href}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}
                {i < crumbs.length - 1 && <span aria-hidden="true"> / </span>}
              </span>
            ))}
          </nav>
        )}
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {intro && <p>{intro}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}
