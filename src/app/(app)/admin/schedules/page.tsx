import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { currentMonthlyPeriod, currentWeeklyPeriod } from "@/server/jobs/schedules";
import { formatLagos } from "@/server/time";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { ScheduleForm } from "../AdminForms";

export const metadata = { title: "Scheduled emails" };

export default async function Schedules() {
  await requireSuperAdmin();
  const s = (await db.query("SELECT * FROM schedule_settings WHERE code = 'MONTHLY_REPORT'")).rows[0];
  const runs = (await db.query("SELECT r.*, (SELECT count(*) FROM digest_deliveries d WHERE d.run_id = r.id AND d.outbox_id IS NOT NULL) AS sent FROM schedule_runs r ORDER BY started_at DESC LIMIT 20")).rows;
  const staff = (
    await db.query(
      `SELECT s.id, s.full_name, string_agg(ra.role, ',') AS roles FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active
        WHERE s.status = 'ACTIVE' AND ra.role IN ('CREDIT_LEAD_1','CREDIT_LEAD_2','MERCHANT_OFFICER_LEAD','ANM_LEAD_NORTH','ANM_LEAD_SOUTH','UNIT_HEAD','DIVISIONAL_HEAD','RBE')
        GROUP BY s.id ORDER BY s.full_name`,
    )
  ).rows;
  const now = new Date();
  const w = currentWeeklyPeriod(now);
  const nextWeekly = new Date(w.end);
  const m = currentMonthlyPeriod(now, s.day_of_month, s.hour, s.minute);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Scheduled emails</h1>
          <p>Run by the durable background worker. Each period and recipient is recorded so restarts and retries never send duplicates.</p>
        </div>
      </div>
      <div className="grid-2">
        <div className="card">
          <h2>Weekly initiator digest</h2>
          <p className="small">Sunday midnight as Monday begins (Africa/Lagos). Summarises the initiator&apos;s successful disbursements and repayments due Monday–Sunday. Repayment prompts start after vendor payment confirmation.</p>
          <p className="small">Next run: <strong>{formatLagos(nextWeekly)}</strong></p>
        </div>
        <div className="card">
          <h2>Monthly leads summary</h2>
          <p className="small">Prior calendar month&apos;s pipeline, bookings, turnaround, corrections/rejections and upcoming repayments, scoped to each recipient&apos;s access. Current period due: <strong>{formatLagos(m.dueAt)}</strong> ({m.label}).</p>
          <ScheduleForm s={s} staff={staff.map((x) => ({ value: x.id, label: `${x.full_name} (${String(x.roles).split(",").map((r) => ROLE_LABELS[r as Role]).join(", ")})` }))} />
        </div>
      </div>
      <div className="card">
        <h2>Recent runs</h2>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Schedule</th><th>Period</th><th>Started</th><th>Finished</th><th>Status</th><th>Emails queued</th></tr></thead>
            <tbody>
              {runs.length === 0 && <tr><td colSpan={6} className="empty">No runs yet. Start the worker with npm run worker.</td></tr>}
              {runs.map((r) => (
                <tr key={r.id}><td>{r.code}</td><td className="mono">{r.period_key}</td><td className="small">{formatLagos(r.started_at)}</td><td className="small">{r.finished_at ? formatLagos(r.finished_at) : "—"}</td><td>{r.status}</td><td>{r.sent}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
