import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { dailySummary, targetAccess } from "@/server/domain/performance";
import { PageHeader } from "@/components/PageHeader";
import { PerformanceSummary } from "@/components/Performance";

export const metadata = { title: "My performance" };

export default async function PerformancePage() {
  const { session, ctx } = await requireUser();
  const s = await dailySummary(db, session.staffId, ctx.now);
  const access = await targetAccess(db, session.staffId);
  if (!s && !access.propose && !access.approve) redirect("/forbidden");
  return (
    <>
      <PageHeader eyebrow="Performance" title="My performance" intro="Month-to-date disbursements against your approved target, with the run rate needed to reach it." />
      {(access.propose || access.approve) && (
        <p>
          <Link href="/performance/targets" className="btn btn-sm">
            Performance targets
          </Link>
        </p>
      )}
      {s ? (
        <section className="card">
          <PerformanceSummary s={s} />
        </section>
      ) : (
        <p className="muted">Performance summaries are for Relationship Managers and Team Leads.</p>
      )}
    </>
  );
}
