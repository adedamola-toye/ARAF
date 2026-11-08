import { Download } from "lucide-react";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { REQUIRED_DOCX_PLACEHOLDERS } from "@/server/domain/offer-docx";
import { APPLICANT_TYPE_LABELS, type ApplicantType } from "@/server/domain/application-data";
import { formatLagos } from "@/server/time";
import { config } from "@/server/config";
import { PageHeader } from "@/components/PageHeader";
import { ActivateTemplateButton, ApproveTemplateButton, UploadTemplateForm } from "../AdminForms";

export const metadata = { title: "Offer templates" };

export default async function Templates() {
  await requireSuperAdmin();
  const rows = (
    await db.query(
      `SELECT t.*, s.full_name AS created_by_name, a.full_name AS activated_by_name, p.full_name AS approved_by_name FROM offer_templates t
         LEFT JOIN staff s ON s.id = t.created_by LEFT JOIN staff a ON a.id = t.activated_by LEFT JOIN staff p ON p.id = t.approved_by
        ORDER BY t.applicant_type NULLS LAST, t.status = 'ACTIVE' DESC, t.version DESC`,
    )
  ).rows;
  const types: ApplicantType[] = ["INDIVIDUAL", "ENTERPRISE", "LIMITED"];
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Offer templates"
        intro="The bank's Murabaha offer letters, one active template per applicant type. Generated offers are editable Word documents (with a PDF copy for preview), record the template version and are frozen as document versions."
      />
      <div className="grid-3" style={{ marginBottom: 16 }}>
        {types.map((t) => {
          const a = rows.find((r) => r.status === "ACTIVE" && r.applicant_type === t);
          return (
            <div className="card" key={t} style={{ margin: 0 }}>
              <p className="eyebrow">{APPLICANT_TYPE_LABELS[t]}</p>
              {a ? (
                <>
                  <h2 style={{ marginBottom: 4 }}>{a.name} v{a.version}</h2>
                  {a.production_approved ? (
                    <span className="badge badge-green">Approved for production{a.approved_by_name ? ` · ${a.approved_by_name}` : ""}</span>
                  ) : (
                    <span className="badge badge-warn">Awaiting bank approval{config.isProduction ? " · offers blocked" : ""}</span>
                  )}
                </>
              ) : (
                <span className="badge badge-red">No active template</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <table className="data responsive">
          <thead><tr><th>Template</th><th>Type</th><th>Status</th><th>Bank approval</th><th>Created</th><th>Activated</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td data-label="Template">{r.name} <span className="muted">v{r.version} · {r.format}</span><div className="small muted">{r.source_filename ?? ""}{r.notes ? ` · ${r.notes}` : ""}</div></td>
                <td className="small" data-label="Type">{r.applicant_type ? APPLICANT_TYPE_LABELS[r.applicant_type as ApplicantType] : "All types"}</td>
                <td data-label="Status"><span className={`badge ${r.status === "ACTIVE" ? "badge-green" : ""}`}>{r.status}</span></td>
                <td className="small" data-label="Bank approval">{r.production_approved ? <>Approved{r.approved_at && <div className="muted">{r.approved_by_name ?? ""} {formatLagos(r.approved_at)}</div>}</> : <span className="badge badge-warn">Not approved</span>}</td>
                <td className="small" data-label="Created">{formatLagos(r.created_at)}{r.created_by_name && <div className="muted">{r.created_by_name}</div>}</td>
                <td className="small" data-label="Activated">{r.activated_at ? formatLagos(r.activated_at) : "—"}{r.activated_by_name && <div className="muted">{r.activated_by_name}</div>}</td>
                <td className="row-actions">
                  <div className="row">
                    <a className="btn btn-sm" href={`/api/admin/templates/${r.id}`}><Download className="icon" aria-hidden="true" />Download</a>
                    {!r.production_approved && <ApproveTemplateButton templateId={r.id} />}
                    {r.status !== "ACTIVE" && <ActivateTemplateButton templateId={r.id} />}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Upload a new template version</h2>
        <p className="small muted">
          Edit the downloaded Word file and keep the placeholders exactly as written, e.g. <code>{"{{cost_price}}"}</code>. Required placeholders:{" "}
          {types.map((t) => (
            <span key={t}>
              <strong>{APPLICANT_TYPE_LABELS[t]}</strong>: {REQUIRED_DOCX_PLACEHOLDERS[t].map((x) => `{{${x}}}`).join(" ")}.{" "}
            </span>
          ))}
          See docs/OFFER_TEMPLATES.md for every placeholder. Signature images are not allowed; letters are signed by hand.
        </p>
        <UploadTemplateForm />
      </div>
    </>
  );
}
