import Link from "next/link";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { listNotifications } from "@/server/domain/notifications";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { ActionForm, SubmitButton } from "@/components/forms";
import { markReadAction } from "./actions";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const { session } = await requireUser();
  const items = await listNotifications(db, session.staffId);
  const unread = items.filter((n) => !n.read_at).length;
  return (
    <>
      <PageHeader eyebrow="Work" title="Notifications" intro="Alerts that need your attention, newest first." />
      <section className="card">
        <div className="card-head">
          <h2>{unread ? `${unread} unread` : "All read"}</h2>
          {unread > 0 && (
            <ActionForm action={markReadAction} className="inline-form" showMessages={false}>
              <input type="hidden" name="id" value="ALL" />
              <SubmitButton className="btn btn-sm">Mark all as read</SubmitButton>
            </ActionForm>
          )}
        </div>
        {items.length === 0 ? (
          <p className="muted">No notifications.</p>
        ) : (
          items.map((n) => (
            <article key={n.id} className={`notice-item${n.read_at ? "" : " unread"}`}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{n.title}</strong>
                <span className="small muted">{formatLagos(n.created_at)}</span>
              </div>
              <pre className="small">{n.body}</pre>
              <div className="row" style={{ marginTop: 6 }}>
                {n.link && (
                  <Link href={n.link} className="btn btn-sm btn-primary">
                    Open the request
                  </Link>
                )}
                {!n.read_at && (
                  <ActionForm action={markReadAction} className="inline-form" showMessages={false}>
                    <input type="hidden" name="id" value={n.id} />
                    <SubmitButton className="btn btn-sm btn-ghost">Mark as read</SubmitButton>
                  </ActionForm>
                )}
              </div>
            </article>
          ))
        )}
      </section>
    </>
  );
}
