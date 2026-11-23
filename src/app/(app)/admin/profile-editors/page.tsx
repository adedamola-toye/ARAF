import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { teamLeadEditors } from "@/server/domain/team-profiles";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { Designate } from "../../team/Forms";

export const metadata = { title: "Team profile editors" };

export default async function ProfileEditors() {
  await requireSuperAdmin();
  const rows = await teamLeadEditors(db);
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Team profile editors"
        intro="Designate Team Leads who may correct the full name and business unit of people in their own team. They cannot change roles, status, region or access. Case reassignment stays with the Super Admin."
      />
      {rows.length ? (
        <div className="table-wrap">
          <table className="data responsive">
            <thead>
              <tr>
                <th>Team Lead</th>
                <th>Team(s)</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="Team Lead">
                    <strong>{r.full_name}</strong>
                    <div className="small muted">{r.email}</div>
                  </td>
                  <td data-label="Team(s)">{r.teams ?? "No team set"}</td>
                  <td data-label="Status">
                    {r.designated ? <span className="badge badge-green">Designated {r.designated_at ? formatLagos(r.designated_at) : ""}</span> : <span className="badge">Not designated</span>}
                  </td>
                  <td className="row-actions">
                    <Designate staffId={r.id} designated={r.designated} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No active Team Lead is profiled.</p>
      )}
    </>
  );
}
