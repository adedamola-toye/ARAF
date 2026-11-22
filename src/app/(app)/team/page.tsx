import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { isDesignatedEditor, teamMembers } from "@/server/domain/team-profiles";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { PageHeader } from "@/components/PageHeader";
import { EditMember } from "./Forms";

export const metadata = { title: "My team" };

/** Designated Team Leads: correct the name and business unit of people in their own team. */
export default async function Team() {
  const { session } = await requireUser();
  if (!(await isDesignatedEditor(db, session.staffId))) redirect("/forbidden");
  const members = await teamMembers(db, session.staffId);
  return (
    <>
      <PageHeader
        eyebrow="Team Lead"
        title="My team"
        intro="You can correct the full name and business unit of the people in your team. Roles, status, region and access are managed by the Super Admin. Every change is recorded."
      />
      {members.length ? (
        <div className="table-wrap">
          <table className="data responsive">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Team</th>
                <th>Business unit</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td data-label="Name">
                    <strong>{m.full_name}</strong>
                  </td>
                  <td data-label="Email" className="small">
                    {m.email}
                  </td>
                  <td data-label="Role" className="small">
                    {m.roles
                      .split(",")
                      .map((r) => ROLE_LABELS[r as Role] ?? r)
                      .join(", ")}
                  </td>
                  <td data-label="Team">{m.team}</td>
                  <td data-label="Business unit">{m.business_unit ?? "—"}</td>
                  <td className="row-actions">
                    <EditMember m={{ id: m.id, fullName: m.full_name, businessUnit: m.business_unit ?? "" }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No one is mapped to your team yet. The Super Admin sets teams on each person&apos;s role.</p>
      )}
    </>
  );
}
