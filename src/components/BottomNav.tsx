"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Bell, BadgeCent, FilePlus2, Headset, Inbox, Menu, ListChecks, Smartphone } from "lucide-react";

const ICONS = { queue: Inbox, new: FilePlus2, approved: ListChecks, salary: BadgeCent, altphones: Smartphone, crm: Headset, bell: Bell } as const;
export type BottomItem = { href: string; label: string; icon: keyof typeof ICONS; count?: number; exact?: boolean };

/** Mobile bottom navigation: up to four destinations chosen for the person's role, plus More (the full menu). */
export function BottomNav({ items }: { items: BottomItem[] }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    document.getElementById("sidenav")?.classList.toggle("open", open);
  }, [open]);
  return (
    <nav className="bottom-nav" aria-label="Primary">
      {items.slice(0, 4).map((it) => {
        const Icon = ICONS[it.icon];
        const active = it.exact ? path === it.href : path === it.href || path.startsWith(it.href + "/");
        return (
          <Link key={it.href} href={it.href} aria-current={active ? "page" : undefined}>
            <Icon aria-hidden="true" />
            {it.label}
            {it.count ? <span className="bn-count">{it.count > 99 ? "99+" : it.count}</span> : null}
          </Link>
        );
      })}
      <button type="button" aria-expanded={open} aria-controls="sidenav" onClick={() => setOpen(!open)}>
        <Menu aria-hidden="true" />
        More
      </button>
    </nav>
  );
}
