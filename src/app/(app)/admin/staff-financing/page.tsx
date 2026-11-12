import Link from "next/link";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { requireSuperAdmin } from "../guard";
import { PageHeader } from "@/components/PageHeader";
import { db } from "@/server/db";
import { formatLagos } from "@/server/time";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { roleHolders, DISBURSEMENT_ROLES } from "@/server/staff/core";
import { activeStaffTemplate, STAFF_OFFER_PLACEHOLDERS, REQUIRED_STAFF_OFFER_PLACEHOLDERS } from "@/server/staff/offer";
import { documentLibrary } from "@/server/staff/sharepoint";
import { config } from "@/server/config";
import { APPLICANT_SUPPORTING_CATEGORIES, bpsLabel, formatNairaKobo, STAFF_DOC_CATEGORIES } from "@/lib/staff-financing";
import { StaffSettingsForm, StaffTemplateForm } from "./AdminStaffForms";

export const metadata = { title: "Staff financing settings" };

export default async function StaffFinancingAdmin() {
  await requireSuperAdmin();
  const versions = (await db.query("SELECT v.*, s.full_name AS created_by_name FROM staff_financing_settings v LEFT JOIN staff s ON s.id = v.created_by ORDER BY version DESC LIMIT 10")).rows;
  const cur = versions[0];
  const tpl = await activeStaffTemplate(db);
  const missing = documentLibrary().missingSettings();
  const coverage: [string, readonly string[]][] = [
    ["Product Manager", ["PRODUCT_MANAGER"]],
    ["Unit Head", ["UNIT_HEAD"]],
    ["Divisional Head", ["DIVISIONAL_HEAD"]],
    ["Disbursement Officer", DISBURSEMENT_ROLES],
    ["Legal reviewer", ["LEGAL_REVIEWER"]],
    ["Shariah reviewer", ["SHARIAH_REVIEWER"]],
  ];
  const counts = await Promise.all(coverage.map(async ([, r]) => (await roleHolders(db, r)).length));
  return (
    <>
      <PageHeader
        crumbs={[{ href: "/admin", label: "Administration" }, { label: "Staff financing" }]}
        eyebrow="Administration"
        title="Staff personal financing"
        intro="Settings, the offer letter template, integrations and role coverage for the staff workflow."
        actions={<Link className="btn" href="/staff-financing?view=ops">Operations queue</Link>}
      />
      <div className="grid-2" style={{ alignItems: "start" }}>
        <section className="card stack" aria-labelledby="set-h">
          <h2 id="set-h" style={{ margin: 0 }}>Settings in force · version {cur.version}</h2>
          <table className="kv">
            <tbody>
              <tr><th>Deduction</th><td>{bpsLabel(cur.deduction_rate_bps)} of the gross amount</td></tr>
              <tr><th>Amount limits</th><td>{cur.min_amount_kobo ? formatNairaKobo(cur.min_amount_kobo) : "no minimum"} – {cur.max_amount_kobo ? formatNairaKobo(cur.max_amount_kobo) : "no maximum"}</td></tr>
              <tr><th>Tenor options</th><td>{cur.tenor_options_months.length ? cur.tenor_options_months.map((t: number) => `${t} months`).join(", ") : "Not collected"}</td></tr>
              <tr><th>Required at submission</th><td>{cur.required_document_types.length ? cur.required_document_types.map((c: string) => STAFF_DOC_CATEGORIES[c as keyof typeof STAFF_DOC_CATEGORIES]).join(", ") : "No mandatory document"}</td></tr>
              <tr><th>Source</th><td className="small">{cur.reason}</td></tr>
            </tbody>
          </table>
          <details>
            <summary className="btn btn-sm">Save a new version</summary>
            <StaffSettingsForm current={{ deductionPercent: (cur.deduction_rate_bps / 100).toString(), minAmount: cur.min_amount_kobo ? String(Number(cur.min_amount_kobo) / 100) : "", maxAmount: cur.max_amount_kobo ? String(Number(cur.max_amount_kobo) / 100) : "", tenorOptions: cur.tenor_options_months.join(", "), requiredDocuments: cur.required_document_types }} categories={APPLICANT_SUPPORTING_CATEGORIES.map((c) => ({ code: c, label: STAFF_DOC_CATEGORIES[c] }))} />
          </details>
          <details>
            <summary className="small">History</summary>
            <ul className="timeline" style={{ marginTop: 8 }}>
              {versions.map((v) => (
                <li key={v.id} className="done">
                  <strong>v{v.version} · {bpsLabel(v.deduction_rate_bps)}</strong>
                  <div className="small muted">{v.created_by_name ?? "Migration"} · {formatLagos(v.created_at)}</div>
                  <div className="small">{v.reason}</div>
                </li>
              ))}
            </ul>
          </details>
        </section>
        <div className="stack">
          <section className="card stack" aria-labelledby="tpl-h">
            <h2 id="tpl-h" style={{ margin: 0 }}>Offer letter template</h2>
            {tpl ? (
              <p className={`small ${tpl.production_approved ? "" : "err"}`} style={{ margin: 0 }}>
                {tpl.production_approved ? <CheckCircle2 className="icon" aria-hidden="true" /> : <AlertTriangle className="icon" aria-hidden="true" />} Active: v{tpl.version}, {tpl.production_approved ? `approved for production ${formatLagos(tpl.approved_at)}` : "NOT approved for production: no offer letters are issued until the bank's Legal and Shariah wording is loaded and approved."}
              </p>
            ) : (
              <p className="small err" style={{ margin: 0 }}>No active staff template. No offer letters can be issued.</p>
            )}
            <p className="small muted" style={{ margin: 0 }}>
              Placeholders: {STAFF_OFFER_PLACEHOLDERS.map((p) => `{{${p}}}`).join(" ")}. Required: {REQUIRED_STAFF_OFFER_PLACEHOLDERS.map((p) => `{{${p}}}`).join(" ")}. Activate and approve versions on <Link href="/admin/templates">Offer templates</Link>.
            </p>
            <details>
              <summary className="btn btn-sm">Load the bank-approved wording</summary>
              <StaffTemplateForm initial={tpl?.body_html ?? ""} />
            </details>
          </section>
          <section className="card stack" aria-labelledby="sp-h">
            <h2 id="sp-h" style={{ margin: 0 }}>Microsoft SharePoint</h2>
            {missing.length === 0 ? (
              <p className="small" style={{ margin: 0 }}>
                <CheckCircle2 className="icon" aria-hidden="true" /> Configured. Archives are uploaded to <strong>{config.sharepoint.rootFolder}/STAFF-&lt;staff ID&gt;/</strong> and verified by checksum.
              </p>
            ) : (
              <>
                <p className="small" style={{ margin: 0 }}>
                  <AlertTriangle className="icon" aria-hidden="true" /> Not configured. Completed facility archives are kept in the platform&apos;s encrypted storage and handed to Legal and Shariah from there.
                </p>
                <p className="small muted" style={{ margin: 0 }}>Missing: {missing.join(", ")}. Values are set on the server only and are never shown here.</p>
              </>
            )}
          </section>
          <section className="card" aria-labelledby="cov-h">
            <h2 id="cov-h">Role coverage</h2>
            <table className="kv">
              <tbody>
                {coverage.map(([label, r], i) => (
                  <tr key={label}>
                    <th>{label}</th>
                    <td>
                      {counts[i] ? `${counts[i]} active` : <span className="err">Nobody holds this role</span>}
                      <span className="small muted"> · {r.map((x) => ROLE_LABELS[x as Role]).join(" or ")}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted" style={{ margin: "10px 0 0" }}>
              Employees with no other platform role need the {ROLE_LABELS.STAFF_APPLICANT} role to sign in and apply. Grant roles on <Link href="/admin/staff">Users &amp; roles</Link>.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
