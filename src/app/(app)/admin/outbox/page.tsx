import Link from "next/link";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { formatLagos } from "@/server/time";
import { RetryButton } from "../AdminForms";

export const metadata = { title: "Email delivery" };

export default async function Outbox({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const status = sp.status ?? "";
  const rows = (
    await db.query(
      `SELECT o.id, o.kind, o.status, o.attempts, o.max_attempts, o.last_error, o.created_at, o.sent_at, o.next_attempt_at, o.subject,
              array_length(o.to_addresses,1) AS n_to, array_length(o.cc_addresses,1) AS n_cc, array_length(o.attachment_document_ids,1) AS n_att, a.ref, a.id AS app_id
         FROM notification_outbox o LEFT JOIN applications a ON a.id = o.application_id
        WHERE ($1 = '' OR o.status = $1) ORDER BY o.created_at DESC LIMIT 200`,
      [status],
    )
  ).rows;
  const counts = (await db.query("SELECT status, count(*) AS n FROM notification_outbox GROUP BY status")).rows;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Email delivery</h1>
          <p>Transactional outbox. Failed deliveries retry with exponential backoff; retries reuse the same message, so closure packs are never duplicated. OTP codes are sent directly and never stored here.</p>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link className={`btn btn-sm ${!status ? "btn-primary" : ""}`} href="/admin/outbox">All</Link>
        {["PENDING", "SENDING", "SENT", "FAILED", "DEAD"].map((s) => (
          <Link key={s} className={`btn btn-sm ${status === s ? "btn-primary" : ""}`} href={`/admin/outbox?status=${s}`}>
            {s} ({counts.find((c) => c.status === s)?.n ?? 0})
          </Link>
        ))}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Created</th><th>Kind</th><th>Subject</th><th>Request</th><th>Recipients</th><th>Status</th><th>Attempts</th><th>Last error</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="small nowrap">{formatLagos(r.created_at)}</td>
                <td className="small mono">{r.kind}</td>
                <td className="small">{r.subject}</td>
                <td className="small mono">{r.ref ?? "—"}</td>
                <td className="small">{r.n_to ?? 0} to{r.n_cc ? `, ${r.n_cc} cc` : ""}{r.n_att ? `, ${r.n_att} files` : ""}</td>
                <td><span className={`badge ${r.status === "SENT" ? "badge-green" : r.status === "DEAD" || r.status === "FAILED" ? "badge-red" : "badge-yellow"}`}>{r.status}</span>{r.sent_at && <div className="small muted">{formatLagos(r.sent_at)}</div>}</td>
                <td>{r.attempts}/{r.max_attempts}</td>
                <td className="small" style={{ maxWidth: 240 }}>{r.last_error ?? ""}{r.status === "FAILED" && <div className="muted">next {formatLagos(r.next_attempt_at)}</div>}</td>
                <td>{(r.status === "FAILED" || r.status === "DEAD") && <RetryButton id={r.id} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
