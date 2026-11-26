import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { orgLinks, RELATIONS, type Relation } from "@/server/domain/org";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { PageHeader } from "@/components/PageHeader";
import { LinkForm } from "./LinkForm";

export const metadata = { title: "Reporting lines" };

/** Staff in scope for a "reports to Unit Head" line: everyone who originates, reviews or sells. */
const UNIT_MEMBER_ROLES = ["RM", "TEAM_LEAD", "MERCHANT_OFFICER", "MERCHANT_OFFICER_LEAD", "MERCHANT_OFFICER_HEAD", "DELIGHT_OFFICER", "SMILE_ASSOCIATE", "BUSINESS_PERFORMANCE_MANAGER", "ALTPHONES_PRODUCT_MANAGER", "HEAD_OF_RETAIL_SALES", "HEAD_OF_UNIT", "ANM", "PRODUCT_MANAGER"];

async function holders(roles: readonly string[]) {
  return (
    await db.query<{ id: string; name: string; roles: string[] }>(
      `SELECT s.id, s.full_name AS name, array_agg(DISTINCT ra.role ORDER BY ra.role) AS roles FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active
        WHERE s.status = 'ACTIVE' AND ra.role = ANY($1) GROUP BY s.id, s.full_name ORDER BY s.full_name`,
      [roles],
    )
  ).rows;
}

export default async function ReportingLines() {
  await requireSuperAdmin();
  const links = await orgLinks(db);
  const currentLink = (staffId: string, rel: Relation) => links.find((l) => l.staff_id === staffId && l.relation === rel) ?? null;
  const sections: { rel: Relation; title: string; intro: string; people: { id: string; name: string; roles: string[] }[] }[] = [
    { rel: "MO_LEAD", title: "Merchant Officers → Merchant Officer Lead", intro: "A Merchant Officer's WakeelBoost request goes to their Lead first. Without a line, any Merchant Officer Lead may receive it.", people: await holders(["MERCHANT_OFFICER"]) },
    { rel: "MO_HEAD", title: "Merchant Officer Leads → Merchant Officer Head", intro: "After the Lead, the request goes to the Lead's Head, then to credit.", people: await holders(["MERCHANT_OFFICER_LEAD"]) },
    { rel: "UNIT_HEAD", title: "Staff → Unit Head (reporting)", intro: "Which Unit Head's reports include this person's work.", people: await holders(UNIT_MEMBER_ROLES) },
    { rel: "DIVISIONAL_HEAD", title: "Unit Heads → Divisional Head (reporting)", intro: "Which Divisional Head's reports include this Unit Head's units.", people: await holders(["UNIT_HEAD"]) },
  ];
  const managersFor = async (rel: Relation) => (await holders([RELATIONS[rel].managerRole])).map((m) => ({ id: m.id, name: m.name }));
  return (
    <>
      <PageHeader eyebrow="Administration" title="Reporting lines" intro="Who reports to whom. Approval routing for Merchant Officers and the Unit Head / Divisional Head reports use these lines. Each change needs a reason and is recorded in the audit log." />
      {await Promise.all(
        sections.map(async (sec) => {
          const managers = await managersFor(sec.rel);
          return (
            <section key={sec.rel} className="card" style={{ marginBottom: "var(--space-4)" }} aria-labelledby={`rl-${sec.rel}`}>
              <h2 id={`rl-${sec.rel}`}>{sec.title}</h2>
              <p className="small muted" style={{ marginTop: 0 }}>{sec.intro}</p>
              <div className="table-wrap">
                <table className="data small">
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col">Roles</th>
                      <th scope="col">Reports to</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sec.people.map((p) => (
                      <tr key={p.id}>
                        <td>{p.name}</td>
                        <td>{p.roles.map((r) => ROLE_LABELS[r as Role] ?? r).join(", ")}</td>
                        <td>
                          <LinkForm
                            staffId={p.id}
                            relation={sec.rel}
                            current={currentLink(p.id, sec.rel)?.manager_id ?? null}
                            currentName={currentLink(p.id, sec.rel)?.manager_name ?? null}
                            managers={managers.filter((m) => m.id !== p.id)}
                          />
                        </td>
                      </tr>
                    ))}
                    {!sec.people.length && (
                      <tr>
                        <td colSpan={3} className="muted">Nobody holds the role yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          );
        }),
      )}
    </>
  );
}
