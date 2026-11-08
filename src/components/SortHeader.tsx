import Link from "next/link";

/** Server-rendered sortable column header that preserves the other query parameters. */
export function SortHeader({ label, col, sp, base }: { label: string; col: string; sp: Record<string, string | undefined>; base: string }) {
  const active = (sp.sort ?? "") === col;
  const dir = active && sp.dir === "asc" ? "desc" : "asc";
  const q = new URLSearchParams(Object.entries({ ...sp, sort: col, dir, page: "1" }).filter(([, v]) => v !== undefined) as [string, string][]);
  return (
    <th aria-sort={active ? (sp.dir === "asc" ? "ascending" : "descending") : "none"} scope="col">
      <Link href={`${base}?${q.toString()}`}>
        {label} {active ? (sp.dir === "asc" ? "▲" : "▼") : ""}
      </Link>
    </th>
  );
}

export function pageHref(base: string, sp: Record<string, string | undefined>, page: number) {
  const q = new URLSearchParams(Object.entries({ ...sp, page: String(page) }).filter(([, v]) => v !== undefined) as [string, string][]);
  return `${base}?${q.toString()}`;
}
