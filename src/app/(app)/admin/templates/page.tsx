import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { DEV_OFFER_TEMPLATE, PLACEHOLDERS } from "@/server/domain/offer";
import { formatLagos } from "@/server/time";
import { config } from "@/server/config";
import { ActivateTemplateButton, TemplateForm } from "../AdminForms";

export const metadata = { title: "Offer templates" };

export default async function Templates() {
  await requireSuperAdmin();
  const rows = (await db.query("SELECT t.*, s.full_name AS created_by_name, a.full_name AS activated_by_name FROM offer_templates t LEFT JOIN staff s ON s.id = t.created_by LEFT JOIN staff a ON a.id = t.activated_by ORDER BY t.name, t.version DESC")).rows;
  const active = rows.find((r) => r.status === "ACTIVE");
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Offer templates</h1>
          <p>Versioned, bank-owned offer letter templates. Generated offers record the template version and are frozen as document versions.</p>
        </div>
      </div>
      {active && !active.production_approved && (
        <div className="alert alert-warn" style={{ marginBottom: 16 }}>
          The active template is not marked bank-approved. {config.isProduction ? "Offer generation is blocked in production." : "Upload the bank's actual offer template before production."}
        </div>
      )}
      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <table className="data">
          <thead><tr><th>Name</th><th>Version</th><th>Status</th><th>Bank approved</th><th>Created</th><th>Activated</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}<div className="small muted">{r.notes}</div></td>
                <td>v{r.version}</td>
                <td><span className={`badge ${r.status === "ACTIVE" ? "badge-green" : ""}`}>{r.status}</span></td>
                <td>{r.production_approved ? <span className="badge badge-green">Yes</span> : <span className="badge badge-yellow">No</span>}</td>
                <td className="small">{formatLagos(r.created_at)}{r.created_by_name && <div className="muted">{r.created_by_name}</div>}</td>
                <td className="small">{r.activated_at ? formatLagos(r.activated_at) : "—"}{r.activated_by_name && <div className="muted">{r.activated_by_name}</div>}</td>
                <td>{r.status !== "ACTIVE" && <ActivateTemplateButton templateId={r.id} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>New template version</h2>
        <p className="small muted">
          Placeholders: {PLACEHOLDERS.filter((p) => !p.startsWith("director_")).map((p) => `{{${p}}}`).join(" ")}. Limited companies: repeat a section per director with{" "}
          <code>{"{{#directors}} … {{director_name}} … {{director_bvn}} … {{/directors}}"}</code>. Optional blocks: <code>{"{{#if_bvn}}…{{/if_bvn}}"}</code>, <code>{"{{#if_tin}}…{{/if_tin}}"}</code>. Customer name renders as the individual&apos;s name, “Name trading as Business Name” for Enterprise, or the company name for Limited.
        </p>
        <TemplateForm defaultBody={active?.body_html ?? DEV_OFFER_TEMPLATE} />
      </div>
    </>
  );
}
