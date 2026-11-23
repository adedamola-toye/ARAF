import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, FilePlus2 } from "lucide-react";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { initiatorFigures, myDrafts, myReturned, PERIOD_LABEL, type HomePeriod } from "@/server/domain/home";
import { actionQueue } from "@/server/domain/views";
import { PRIORITY_LABEL, PRIORITY_ORDER, priorityClassifier } from "@/server/domain/queue-priority";
import { isInitiatorRole } from "@/server/domain/roles";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { formatDuration, formatLagos, lagosParts, fromLagos } from "@/server/time";
import { Money } from "@/components/Money";
import { DeleteDraft } from "./DeleteDraft";

export const metadata = { title: "Overview" };

const PERIODS: HomePeriod[] = ["today", "week", "month", "year"];
const greeting = (now: Date) => {
  const h = lagosParts(now).hour;
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

/**
 * Personal home: what is my responsibility, what needs me, what next, how am I doing, where is my work.
 * Every figure comes from records; a first-time user sees genuine zeros.
 */
export default async function Overview({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const { session, roles } = await requireUser();
  const ws = session.activeRole;
  // Staff whose only role is the salary advance applicant have their own personal home.
  if (roles.length === 1 && roles[0] === "STAFF_APPLICANT") redirect("/staff-request");
  const sp = await searchParams;
  const period = (PERIODS as string[]).includes(sp.period ?? "") ? (sp.period as HomePeriod) : "today";
  const now = new Date();
  const first = session.fullName.split(/\s+/)[0];
  const initiator = (isInitiatorRole(ws) || ["TEAM_LEAD", "UNIT_HEAD", "MERCHANT_OFFICER_LEAD", "MERCHANT_OFFICER_HEAD"].includes(ws ?? "")) && ws !== "DELIGHT_OFFICER";
  const queue = await actionQueue(db, session.staffId, { all: true });
  const classify = await priorityClassifier(db, now);
  const ranked = queue.rows.map((r) => ({ ...r, p: classify(r) })).sort((a, b) => PRIORITY_ORDER.indexOf(a.p) - PRIORITY_ORDER.indexOf(b.p) || new Date(a.assigned_at).getTime() - new Date(b.assigned_at).getTime());
  const overdue = ranked.filter((r) => r.p === "OVERDUE").length;
  const l = lagosParts(now);
  const monthStart = fromLagos(l.year, l.month, 1);
  const decidedThisMonth = Number((await db.query("SELECT count(*) AS n FROM decisions WHERE actor_id = $1 AND created_at >= $2", [session.staffId, monthStart])).rows[0].n);
  const figures = initiator ? await initiatorFigures(db, session.staffId, period, now) : null;
  const drafts = initiator ? await myDrafts(db, session.staffId) : [];
  const returned = initiator ? await myReturned(db, session.staffId) : [];
  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <p className="eyebrow">Overview</p>
          <h1>
            {greeting(now)}, {first}
          </h1>
          <p>{ranked.length ? `${ranked.length} item${ranked.length === 1 ? "" : "s"} need${ranked.length === 1 ? "s" : ""} your action${overdue ? `, ${overdue} overdue` : ""}.` : "You're all caught up."}</p>
        </div>
        {initiator && (
          <div className="row">
            <Link className="btn btn-primary" href="/requests/new">
              <FilePlus2 className="icon" aria-hidden="true" /> New application
            </Link>
          </div>
        )}
      </div>

      {figures && (
        <section aria-labelledby="h-fin" style={{ marginBottom: "var(--space-6)" }}>
          <h2 id="h-fin" className="sr-only">
            Your financing
          </h2>
          <nav className="tabs" aria-label="Reporting period">
            {PERIODS.map((p) => (
              <Link key={p} className="tab" href={`/overview?period=${p}`} aria-current={period === p ? "page" : undefined}>
                {PERIOD_LABEL[p]}
              </Link>
            ))}
          </nav>
          <Money size="hero" label="Financing initiated" kobo={figures.initiated.kobo} private hint={`${figures.initiated.count} submitted application${figures.initiated.count === 1 ? "" : "s"} · drafts are not counted`} />
          <div className="grid-2" style={{ marginTop: "var(--space-5)", maxWidth: 720 }}>
            <Money size="lg" label="Approved" kobo={figures.approved.kobo} private hint={`${figures.approved.count} final approval${figures.approved.count === 1 ? "" : "s"}`} />
            <Money size="lg" label="Successfully disbursed" kobo={figures.disbursed.kobo} private hint={`${figures.disbursed.count} disbursement${figures.disbursed.count === 1 ? "" : "s"} recorded`} />
          </div>
        </section>
      )}

      {!figures && (
        <section className="grid-3" style={{ marginBottom: "var(--space-6)" }} aria-label="Your work">
          <div className="fig fig-hero">
            <span className="fig-label">Awaiting your action</span>
            <span className="fig-value">{ranked.length}</span>
          </div>
          <div className="fig fig-lg">
            <span className="fig-label">Overdue</span>
            <span className="fig-value">{overdue}</span>
          </div>
          <div className="fig fig-lg">
            <span className="fig-label">Decisions this month</span>
            <span className="fig-value">{decidedThisMonth}</span>
          </div>
        </section>
      )}

      <section aria-labelledby="h-next" style={{ marginBottom: "var(--space-6)" }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 id="h-next">What needs you</h2>
          <Link className="small" href="/queue">
            My Action Queue →
          </Link>
        </div>
        {ranked.length ? (
          <ul className="home-list">
            {ranked.slice(0, 6).map((r) => (
              <li key={r.task_id}>
                <Link href={`/requests/${r.application_id}?task=${r.task_id}`} className="home-row">
                  <span className="home-main">
                    <strong>{r.customer_name ?? r.ref}</strong>
                    <span className="small muted">
                      {r.ref} · {r.product_label ?? "WakeelBoost"} · {STAGE_LABELS[r.stage as Stage]} · waiting {formatDuration(now.getTime() - new Date(r.assigned_at).getTime())}
                    </span>
                  </span>
                  {r.p !== "OTHER" && <span className={`badge ${r.p === "OVERDUE" ? "badge-red" : r.p === "URGENT" ? "badge-warn" : r.p === "RETURNED" ? "badge-yellow" : "badge-blue"}`}>{PRIORITY_LABEL[r.p]}</span>}
                  <Money size="table" as="span" kobo={r.requested_amount_kobo} private />
                  <ArrowRight className="icon" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">You&apos;re all caught up. New applications requiring your attention will appear here.</p>
        )}
      </section>

      {initiator && returned.length > 0 && (
        <section aria-labelledby="h-ret" style={{ marginBottom: "var(--space-6)" }}>
          <h2 id="h-ret">Returned for correction</h2>
          <ul className="home-list">
            {returned.map((r) => (
              <li key={r.id}>
                <Link href={`/requests/${r.id}${r.task_id ? `?task=${r.task_id}` : ""}`} className="home-row">
                  <span className="home-main">
                    <strong>{r.customer_name ?? r.ref}</strong>
                    <span className="small muted">
                      {r.ref} · {r.product_label ?? "WakeelBoost"} · returned {formatLagos(r.updated_at)}
                    </span>
                  </span>
                  <ArrowRight className="icon" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {initiator && (
        <section aria-labelledby="h-drafts" style={{ marginBottom: "var(--space-6)" }}>
          <h2 id="h-drafts">Resume a draft</h2>
          {drafts.length ? (
            <ul className="home-list">
              {drafts.map((d) => (
                <li key={d.id} className="home-row">
                  <Link href={`/requests/${d.id}/edit`} className="home-main">
                    <strong>{d.customer_name || "Customer not entered yet"}</strong>
                    <span className="small muted">
                      {d.ref} · {d.product_label ?? "WakeelBoost"} · last saved {formatLagos(d.updated_at)}
                    </span>
                  </Link>
                  {d.requested_amount_kobo && <Money size="table" as="span" kobo={d.requested_amount_kobo} private />}
                  <DeleteDraft id={d.id} label={d.ref} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No drafts. Applications you start and save appear here until you submit them.</p>
          )}
        </section>
      )}

      <p className="small muted">
        Your previous work: <Link href="/requests">View Progress</Link> · <Link href="/booked">Booked Requests</Link>
        {roles.some((r) => !isInitiatorRole(r)) && (
          <>
            {" "}
            · <Link href="/requests/approved">Requests I approved</Link>
          </>
        )}
      </p>
    </>
  );
}
