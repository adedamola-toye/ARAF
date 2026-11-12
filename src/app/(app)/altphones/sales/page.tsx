import Link from "next/link";
import { requireUser } from "../../../_lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { db } from "@/server/db";
import { BUCKETS, myApplications, myBucketCounts, type Bucket } from "@/server/altphones/views";
import { AppTable } from "../ui";

export const metadata = { title: "My Altphones sales" };

export default async function MySales({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { session } = await requireUser();
  const bucket = (sp.bucket && sp.bucket in BUCKETS ? sp.bucket : null) as Bucket | null;
  const [rows, counts] = await Promise.all([myApplications(db, session.staffId, bucket, 200), myBucketCounts(db, session.staffId)]);
  return (
    <>
      <PageHeader eyebrow="Altphones" title="My sales" crumbs={[{ href: "/altphones", label: "Altphones" }, { label: "My sales" }]} actions={<Link className="btn btn-primary" href="/altphones">New sale</Link>} />
      <nav className="tabs" aria-label="Filter">
        <Link className="tab" href="/altphones/sales" aria-current={!bucket ? "page" : undefined}>
          All
        </Link>
        {(Object.keys(BUCKETS) as Bucket[]).map((b) => (
          <Link key={b} className="tab" href={`/altphones/sales?bucket=${b}`} aria-current={bucket === b ? "page" : undefined}>
            {BUCKETS[b].label} <span className="badge">{counts[b]}</span>
          </Link>
        ))}
      </nav>
      <div className="card">
        <AppTable rows={rows} empty="Nothing here yet." />
      </div>
    </>
  );
}
