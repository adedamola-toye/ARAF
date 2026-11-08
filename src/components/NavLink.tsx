"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";

export function NavLink({ href, children, count, exact = false, icon, alert = false }: { href: string; children: React.ReactNode; count?: number; exact?: boolean; icon?: React.ReactNode; alert?: boolean }) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(href + "/");
  return (
    <Link href={href} className="nav-link" aria-current={active ? "page" : undefined}>
      {icon}
      <span className="nav-label">{children}</span>
      {count !== undefined && count > 0 && (
        <span className={`nav-count ${alert ? "alert" : ""}`} aria-label={`${count} items`}>
          {count}
        </span>
      )}
    </Link>
  );
}

/** Small-screen navigation: toggles the side navigation as an overlay sheet. */
export function MobileNavToggle() {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    document.getElementById("sidenav")?.classList.toggle("open", open);
  }, [open]);
  return (
    <button type="button" className="btn btn-sm btn-ghost mobile-only" aria-expanded={open} aria-controls="sidenav" onClick={() => setOpen(!open)}>
      {open ? <X className="icon" aria-hidden="true" /> : <Menu className="icon" aria-hidden="true" />}
      <span>Menu</span>
    </button>
  );
}

export function WorkspaceSelect({ roles, active, labels, action }: { roles: string[]; active: string | null; labels: Record<string, string>; action: (fd: FormData) => void }) {
  return (
    <form action={action} className="field">
      <label htmlFor="ws">Workspace</label>
      <select id="ws" name="role" defaultValue={active ?? ""} onChange={(e) => e.currentTarget.form?.requestSubmit()}>
        {roles.map((r) => (
          <option key={r} value={r}>
            {labels[r] ?? r}
          </option>
        ))}
      </select>
      <span className="hint">Your identity is unchanged; actions are recorded against the role you act in.</span>
      <noscript>
        <button className="btn btn-sm">Switch</button>
      </noscript>
    </form>
  );
}
