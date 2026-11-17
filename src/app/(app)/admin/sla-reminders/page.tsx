import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { QUEUES, recentReminders, slaPolicy } from "@/server/domain/sla-reminders";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { SlaForm } from "./SlaForm";

export const metadata = { title: "SLA reminders" };

export default async function SlaReminders() {
  await requireSuperAdmin();
  const p = await slaPolicy(db);
  const recent = await recentReminders(db, 40);
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="SLA reminders"
        intro="When an assigned officer has not acted on a request within the set time, ARAF emails them a reminder. Opening a request does not stop the clock; a saved decision does. A new assignment starts a new clock."
      />
      <section className="card" aria-labelledby="sla-h2">
        <h2 id="sla-h2">Policy</h2>
        <SlaForm
          v={{
            reminderHours: String(Number(p.reminder_hours)),
            repeatHours: p.repeat_hours === null ? "" : String(Number(p.repeat_hours)),
            hourMode: p.hour_mode,
            workingStart: p.working_start,
            workingEnd: p.working_end,
            workingDays: p.working_days,
            holidays: p.holidays.join("\n"),
            queues: Object.entries(QUEUES).map(([key, label]) => ({ key, label, on: !p.excluded_queues.includes(key) })),
            ccEmails: p.cc_emails.join(", "),
            subjectTemplate: p.subject_template,
            bodyTemplate: p.body_template,
            enabled: p.enabled,
          }}
        />
      </section>
      <section className="card" aria-labelledby="sla-rec" style={{ marginTop: "var(--space-5)" }}>
        <h2 id="sla-rec">Recent reminders</h2>
        <div className="table-wrap">
          <table className="data small">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Queue</th>
                <th scope="col">Officer</th>
                <th scope="col">Due</th>
                <th scope="col">Sent</th>
                <th scope="col">Delivery</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r, i) => (
                <tr key={i}>
                  <td>{r.reference}</td>
                  <td>{QUEUES[r.queue as keyof typeof QUEUES] ?? r.queue}{r.threshold_no > 1 ? ` (reminder ${r.threshold_no})` : ""}</td>
                  <td>{r.officer ?? "—"}</td>
                  <td>{formatLagos(r.due_at)}</td>
                  <td>{formatLagos(r.sent_at)}</td>
                  <td>{r.status ? r.status.toLowerCase() : "queued"}</td>
                </tr>
              ))}
              {!recent.length && (
                <tr>
                  <td colSpan={6} className="muted">
                    No reminders sent yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
