"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, children, count, exact = false }: { href: string; children: React.ReactNode; count?: number; exact?: boolean }) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(href + "/");
  return (
    <Link href={href} className="nav-link" aria-current={active ? "page" : undefined}>
      <span>{children}</span>
      {count !== undefined && count > 0 && <span className="nav-count" aria-label={`${count} items`}>{count}</span>}
    </Link>
  );
}

export function WorkspaceSelect({ roles, active, labels, action }: { roles: string[]; active: string | null; labels: Record<string, string>; action: (fd: FormData) => void }) {
  return (
    <form action={action} className="row" style={{ gap: 6 }}>
      <label htmlFor="ws" className="sr-only">
        Workspace
      </label>
      <select id="ws" name="role" defaultValue={active ?? ""} onChange={(e) => e.currentTarget.form?.requestSubmit()} style={{ minHeight: 34, padding: "4px 8px", width: "auto" }}>
        {roles.map((r) => (
          <option key={r} value={r}>
            {labels[r] ?? r}
          </option>
        ))}
      </select>
      <noscript>
        <button className="btn btn-sm">Switch</button>
      </noscript>
    </form>
  );
}
