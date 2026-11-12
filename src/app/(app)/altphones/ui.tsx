import Link from "next/link";
import { CheckCircle2, CircleDashed, CircleDot, Clock, Smartphone, XCircle, type LucideIcon } from "lucide-react";
import { ALT_STATUS_LABELS, formatNaira, formatRateE4, statusTone, type AltStatus } from "@/lib/altphones";
import type { AppListRow } from "@/server/altphones/views";
import { formatLagos } from "@/server/time";

const TONE_CLASS = { green: "badge-green", blue: "badge-blue", red: "badge-red", yellow: "badge-warn", grey: "" } as const;
const ICON: Partial<Record<AltStatus, LucideIcon>> = { COMPLETED: CheckCircle2, DISBURSED: CheckCircle2, APPROVED: CheckCircle2, PAID: CheckCircle2, CREDIT_DECLINED: XCircle, REJECTED: XCircle, CANCELLED: XCircle, DRAFT: CircleDot };

export function AltStatusBadge({ status }: { status: AltStatus }) {
  const Icon = ICON[status] ?? Clock;
  return (
    <span className={`badge ${TONE_CLASS[statusTone(status)]}`}>
      <Icon className="icon" aria-hidden="true" />
      {ALT_STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function KindBadge({ kind, legacy }: { kind: "OUTRIGHT" | "CREDIT"; legacy?: boolean }) {
  return (
    <>
      <span className="badge">{kind === "OUTRIGHT" ? "Outright" : "On credit"}</span>
      {legacy && <span className="badge badge-dark">Legacy / Imported</span>}
    </>
  );
}

export function PhoneImage({ modelId, hasImage, name, size = "card" }: { modelId: string; hasImage: boolean; name: string; size?: "card" | "thumb" }) {
  if (!hasImage)
    return (
      <div className={`alt-phone-img alt-phone-img--${size} is-empty`} role="img" aria-label={`${name}: product photo not uploaded`}>
        <Smartphone className="icon" aria-hidden="true" />
        {size === "card" && <span>Photo not uploaded</span>}
      </div>
    );
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={`alt-phone-img alt-phone-img--${size}`} src={`/api/altphones/models/${modelId}/image`} alt={name} loading="lazy" />;
}

export function Check({ ok, label, detail, pending }: { ok: boolean; label: string; detail?: React.ReactNode; pending?: boolean }) {
  const Icon = ok ? CheckCircle2 : pending ? Clock : CircleDashed;
  return (
    <li className={`alt-check ${ok ? "is-ok" : pending ? "is-pending" : ""}`}>
      <Icon className="icon" aria-hidden="true" />
      <span>
        <strong>{label}</strong>
        {detail && <span className="small muted"> — {detail}</span>}
      </span>
    </li>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function TermsTable({ app }: { app: Record<string, any> }) {
  if (!app.financed_kobo) return null;
  const rows: [string, string][] = [
    ["Phone price", formatNaira(app.price_kobo)],
    ["Down payment", formatNaira(app.down_payment_kobo)],
    ["Amount financed", formatNaira(app.financed_kobo)],
    ["Markup rate", `${formatRateE4(app.markup_rate_e4)}${app.markup_basis === "FLAT_PER_MONTH" ? " per month" : " for the tenure"}`],
    ["Total markup", formatNaira(app.markup_kobo)],
    ["Total repayment", formatNaira(app.total_repayment_kobo)],
    ["Monthly instalment", `${formatNaira(app.instalment_kobo)}${app.final_instalment_kobo !== app.instalment_kobo ? ` (final ${formatNaira(app.final_instalment_kobo)})` : ""}`],
    ["Tenure", `${app.tenure_months} months`],
    ["Repayment day", app.repayment_day ? `Day ${app.repayment_day} of each month` : "—"],
  ];
  return (
    <dl className="kv alt-kv">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ScheduleTable({ rows }: { rows: { seq: number; due_date: string; amount_kobo: string; basis: string }[] }) {
  if (!rows.length) return <p className="small muted">The schedule is generated with the contract.</p>;
  return (
    <div className="table-wrap">
      <table className="data">
        <caption className="sr-only">Repayment schedule</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Due date</th>
            <th scope="col" className="num">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.seq}>
              <td>{r.seq}</td>
              <td>{r.due_date}</td>
              <td className="num">{formatNaira(r.amount_kobo)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted" style={{ marginTop: 6 }}>
        {rows[0].basis === "FINAL" ? "Final schedule, from the disbursement date." : "Provisional: dates are fixed from the disbursement date."}
      </p>
    </div>
  );
}

export function AppTable({ rows, empty, showOfficer = false }: { rows: AppListRow[]; empty: string; showOfficer?: boolean }) {
  if (!rows.length) return <p className="muted small">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Reference</th>
            <th scope="col">Customer</th>
            <th scope="col">Phone</th>
            {showOfficer && <th scope="col">Officer</th>}
            <th scope="col">Location</th>
            <th scope="col">Status</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`/altphones/applications/${r.id}`} className="mono">
                  {r.ref}
                </Link>
                <div className="alt-row-tags">
                  <KindBadge kind={r.kind} legacy={r.legacy} />
                  {r.channel === "SA" && <span className="badge">BOX</span>}
                </div>
              </td>
              <td>{r.customer_name ?? <span className="muted">—</span>}</td>
              <td>
                {r.model_name ?? "—"}
                {r.tenure_months ? <span className="small muted"> · {r.tenure_months} mo</span> : null}
              </td>
              {showOfficer && <td>{r.originator_name ?? "—"}</td>}
              <td className="small">
                {r.origin_name ?? "—"}
                {r.supply_name && r.supply_name !== r.origin_name ? <span className="muted"> ← {r.supply_name}</span> : null}
              </td>
              <td>
                <AltStatusBadge status={r.status} />
                {r.refund_status === "REQUIRED" && <span className="badge badge-red">Refund required</span>}
              </td>
              <td className="small muted">{formatLagos(r.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
