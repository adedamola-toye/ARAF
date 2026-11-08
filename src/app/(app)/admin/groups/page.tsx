import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { formatLagos } from "@/server/time";
import { GroupMemberForm, RemoveMemberButton } from "../AdminForms";

export const metadata = { title: "Recipient groups" };

export default async function Groups() {
  await requireSuperAdmin();
  const groups = (await db.query("SELECT * FROM recipient_groups ORDER BY code")).rows;
  const members = (
    await db.query(
      `SELECT m.*, d.full_name, d.is_group_mailbox, s.id AS staff_id FROM recipient_group_members m
         LEFT JOIN bank_directory d ON d.email = m.email LEFT JOIN staff s ON s.email = m.email ORDER BY m.email`,
    )
  ).rows;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Closure recipient groups</h1>
          <p>Approved Legal and Shariah Compliance recipients for closure packs. Addresses must be internal and present in the bank directory allowlist. Members with the matching reviewer role get scoped read access to the closure cases delivered to their group.</p>
        </div>
      </div>
      <div className="grid-2">
        {groups.map((g) => (
          <div className="card" key={g.code}>
            <h2>{g.name}</h2>
            <ul className="stack" style={{ listStyle: "none", padding: 0, margin: "0 0 12px" }}>
              {members.filter((m) => m.group_code === g.code).map((m) => (
                <li key={m.email} className="row" style={{ justifyContent: "space-between" }}>
                  <span>
                    <strong>{m.email}</strong>
                    <div className="small muted">{m.full_name ?? "Not in directory"} · {m.is_group_mailbox ? "group mailbox" : m.staff_id ? "provisioned staff" : "directory entry"} · added {formatLagos(m.added_at)}</div>
                  </span>
                  <RemoveMemberButton group={g.code} email={m.email} />
                </li>
              ))}
            </ul>
            <GroupMemberForm group={g.code} />
          </div>
        ))}
      </div>
    </>
  );
}
