import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { searchInstitutions } from "@/server/domain/vendors";
import { nameEnquiryProvider } from "@/server/domain/vendors";
import { PageHeader } from "@/components/PageHeader";
import { InstitutionForm, InstitutionImport } from "../RetailAdminForms";

export const metadata = { title: "Banks and microfinance banks" };

export default async function InstitutionsAdmin({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const rows = await searchInstitutions(db, sp.q ?? "", { includeInactive: true });
  const unconfirmed = rows.filter((r) => r.regulatory_status !== "CONFIRMED_ACTIVE").length;
  return (
    <>
      <PageHeader eyebrow="Administration" title="Banks and microfinance banks" intro="The directory behind every vendor bank dropdown. Load it from the current CBN list of licensed institutions and the approved payment provider's routing codes; the platform does not assert regulatory status itself." />
      <div className="alert alert-info" style={{ marginBottom: 12 }}>
        Name enquiry: {nameEnquiryProvider() ? "connected" : "no approved account-enquiry integration is connected; vendor accounts are verified manually with evidence by the vendor register team"}. {unconfirmed} of {rows.length} listed institutions have unconfirmed regulatory status.
      </div>
      <div className="grid-2">
        <section className="card"><h2>Import from CSV</h2><InstitutionImport /></section>
        <section className="card"><h2>Add or update one institution</h2><InstitutionForm /></section>
      </div>
      <form className="filters" method="get" style={{ marginTop: 16 }}>
        <div className="field"><label htmlFor="q">Search</label><input id="q" name="q" type="search" defaultValue={sp.q ?? ""} /></div>
        <button className="btn">Search</button>
      </form>
      <div className="table-wrap">
        <table className="data responsive">
          <thead><tr><th>Code</th><th>Name and aliases</th><th>Category</th><th>Regulatory status</th><th>Payment route</th><th>Source</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="empty">No institutions loaded. Import the CBN list to enable vendor bank selection.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono" data-label="Code">{r.code}</td>
                <td data-label="Name">{r.name}{r.aliases.length ? <div className="small muted">{r.aliases.join(", ")}</div> : null}{!r.active && <span className="badge">inactive</span>}</td>
                <td className="small" data-label="Category">{r.category.toLowerCase().replace("_", " ")}</td>
                <td data-label="Status"><span className={`badge ${r.regulatory_status === "CONFIRMED_ACTIVE" ? "badge-green" : r.regulatory_status === "REVOKED" ? "badge-red" : "badge-warn"}`}>{r.regulatory_status.toLowerCase().replace("_", " ")}</span></td>
                <td className="small" data-label="Payment">{r.payment_supported ? `supported ${Object.entries(r.routing_codes).map(([k, v]) => `${k} ${v}`).join(", ")}` : "not supported"}</td>
                <td className="small" data-label="Source">{r.source}{r.source_reference ? ` · ${r.source_reference}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
