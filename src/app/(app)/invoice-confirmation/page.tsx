import Link from "next/link";
import { requireRole } from "../../_lib/auth";
import { db } from "@/server/db";
import { IC_STATUS_LABELS, icQueue } from "@/server/domain/invoice-confirmation";
import { CATEGORY_LABEL } from "@/server/domain/documents";
import { formatDuration, formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Invoice confirmation" };

const TABS: [string, string, string[]][] = [
  ["pending", "Pending", ["PENDING"]],
  ["returned", "Returned", ["RETURNED"]],
  ["completed", "Completed", ["COMPLETED"]],
  ["failed", "Not dispatched", ["DISPATCH_FAILED"]],
];

export default async function InvoiceQueue({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { session, roles } = await requireRole(["INVOICE_CONFIRMATION_OFFICER", "SUPER_ADMIN"]);
  const sp = await searchParams;
  const tab = TABS.find((t) => t[0] === sp.tab) ?? TABS[0];
  const all = roles.includes("SUPER_ADMIN");
  const rows = await icQueue(db, session.staffId, all, tab[2]);
  const now = Date.now();
  return (
    <>
      <PageHeader eyebrow="Work" title="Invoice confirmation" intro="Invoices sent automatically after final approval. Confirm each with the issuer, upload their response and mark it Confirmation Completed, or return it to the initiator with a reason." />
      <nav className="tabs" aria-label="Confirmation status">
        {TABS.map(([k, label]) => (
          <Link key={k} className="tab" href={`/invoice-confirmation?tab=${k}`} aria-current={tab[0] === k ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="table-wrap">
        <table className="data responsive">
          <caption className="sr-only">{tab[1]} invoice confirmations</caption>
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">Customer</th>
              <th scope="col">Product</th>
              <th scope="col">Document</th>
              <th scope="col">{tab[0] === "pending" ? "Waiting" : "Updated"}</th>
              {all && <th scope="col">Officer</th>}
              <th scope="col">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td data-label="Reference">{r.ref}</td>
                <td data-label="Customer">{r.customer_name ?? "—"}</td>
                <td data-label="Product">{r.product_label ?? "WakeelBoost"}</td>
                <td data-label="Document">
                  {CATEGORY_LABEL[r.invoice_category] ?? r.invoice_category} · v{r.invoice_version}
                </td>
                <td data-label={tab[0] === "pending" ? "Waiting" : "Updated"}>
                  {tab[0] === "pending" && r.assigned_at ? formatDuration(now - new Date(r.assigned_at).getTime()) : formatLagos(r.completed_at ?? r.returned_at ?? r.created_at)}
                </td>
                {all && <td data-label="Officer">{r.officer_name ?? "—"}</td>}
                <td>
                  <Link className="btn btn-sm" href={`/invoice-confirmation/${r.id}`}>
                    Open
                  </Link>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={all ? 7 : 6} className="muted">
                  Nothing {IC_STATUS_LABELS[tab[2][0]]?.toLowerCase() ?? ""}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
