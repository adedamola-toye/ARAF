import { formatKobo } from "@/server/money";
import type { DailySummary, PerformanceBlock } from "@/server/domain/performance";

const pct = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("en-NG", { maximumFractionDigits: 1 })}%`);

function Block({ b }: { b: PerformanceBlock }) {
  return (
    <div className="perf-block">
      <h3>{b.label}</h3>
      <dl className="perf-grid">
        <div>
          <dt>Monthly target</dt>
          <dd>{b.target && b.target.valueTargetId ? formatKobo(b.target.value) : <span className="muted">Target not configured</span>}</dd>
        </div>
        <div>
          <dt>Disbursed this month</dt>
          <dd>
            {formatKobo(b.mtd.valueKobo)} <span className="small muted">({b.mtd.count})</span>
          </dd>
        </div>
        <div>
          <dt>Achievement</dt>
          <dd>{b.achievementPercent === null ? <span className="muted">—</span> : pct(b.achievementPercent)}</dd>
        </div>
        <div>
          <dt>Run rate (per working day)</dt>
          <dd>{formatKobo(b.runRateKobo)}</dd>
        </div>
        <div>
          <dt>Projected month end</dt>
          <dd>{formatKobo(b.projectedKobo)}</dd>
        </div>
        <div>
          <dt>Needed per remaining day</dt>
          <dd>{b.requiredDailyKobo === null ? <span className="muted">—</span> : formatKobo(b.requiredDailyKobo)}</dd>
        </div>
        {b.target?.countTargetId && (
          <div>
            <dt>Request target</dt>
            <dd>
              {b.mtd.count} of {b.target.count}
            </dd>
          </div>
        )}
        <div>
          <dt>Last disbursement day</dt>
          <dd>{b.yesterday.date ? `${formatKobo(b.yesterday.valueKobo)} (${b.yesterday.count}) on ${b.yesterday.date}` : <span className="muted">None yet</span>}</dd>
        </div>
      </dl>
      <p className="small muted" style={{ margin: "var(--space-2) 0 0" }}>
        Pipeline: {b.pipeline.drafts} draft{b.pipeline.drafts === 1 ? "" : "s"} · {b.pipeline.inReview} in review · {b.pipeline.correction} returned for correction · {b.pipeline.approvedNotDisbursed} approved, not yet disbursed · {b.pipeline.submittedToday} submitted today
      </p>
    </div>
  );
}

export function PerformanceSummary({ s }: { s: DailySummary }) {
  return (
    <div className="perf">
      <p className="small muted" style={{ marginTop: 0 }}>
        {s.day} · working day {s.workingDays.elapsed} of {s.workingDays.total} ({s.workingDays.remaining} left including today) · {s.awaitingMe} item{s.awaitingMe === 1 ? "" : "s"} in your action queue
      </p>
      {s.mine && <Block b={s.mine} />}
      {s.teams.map((t) => (
        <Block key={t.label} b={t} />
      ))}
      {s.teams.length > 0 && <p className="small muted">Your own requests are part of your team total; the two are shown side by side and never added together.</p>}
      <p className="small muted" style={{ marginBottom: 0 }}>
        From disbursements recorded in ARAF (Lagos dates). Working days exclude weekends and public holidays in the holiday calendar.
      </p>
    </div>
  );
}
