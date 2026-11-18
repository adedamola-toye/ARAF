import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { DBC_REGIONS, ROUTING_KEYS, classificationGaps, routingAssignments, type RoutingKey } from "@/server/domain/rm-routing";
import { PageHeader } from "@/components/PageHeader";
import { AssignmentForm, ClassifyForm, ProvisionRbeForm } from "./Forms";

export const metadata = { title: "RM classification and routing" };

async function holders(role: string) {
  return (
    await db.query<{ id: string; name: string }>(
      `SELECT s.id, s.full_name AS name FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active AND ra.role = $1
        WHERE s.status = 'ACTIVE' ORDER BY s.full_name`,
      [role],
    )
  ).rows;
}

export default async function RmRouting() {
  await requireSuperAdmin();
  const [rms, rbes, unitHeads, assigned, gaps] = await Promise.all([
    db
      .query<{ id: string; name: string; team: string | null; segment: string | null; dbc_region: string | null; business_unit: string | null; rbe_id: string | null; rbe_name: string | null }>(
        `SELECT s.id, s.full_name AS name, max(ra.team) AS team, c.segment, c.dbc_region, c.business_unit, l.manager_id AS rbe_id, m.full_name AS rbe_name
           FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active AND ra.role = 'RM'
           LEFT JOIN rm_classifications c ON c.staff_id = s.id
           LEFT JOIN org_links l ON l.staff_id = s.id AND l.relation = 'RBE'
           LEFT JOIN staff m ON m.id = l.manager_id
          WHERE s.status = 'ACTIVE'
          GROUP BY s.id, s.full_name, c.segment, c.dbc_region, c.business_unit, l.manager_id, m.full_name
          ORDER BY c.segment NULLS FIRST, s.full_name`,
      )
      .then((r) => r.rows),
    holders("RBE"),
    holders("UNIT_HEAD"),
    routingAssignments(db),
    classificationGaps(db),
  ]);
  const portfolio = new Map<string, number>();
  for (const r of rms) if (r.rbe_id) portfolio.set(r.rbe_id, (portfolio.get(r.rbe_id) ?? 0) + 1);
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="RM classification and routing"
        intro="Classify each Relationship Manager as DBC or Non-DBC. DBC requests keep their approved route and go to the Unit Head for the RM's DBC region. Non-DBC requests go RM → assigned RBE → CX credit review → Credit Officer by amount → E-commerce Unit Head → Divisional Head. Changes need a reason, are audited, and apply to requests submitted afterwards."
      />

      {gaps.length > 0 && (
        <section className="card" style={{ marginBottom: "var(--space-4)" }} aria-labelledby="rr-gaps">
          <h2 id="rr-gaps">Needs your attention ({gaps.length})</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            Unclassified RMs keep the route in force before classification. A Non-DBC RM without an active RBE cannot submit financing requests.
          </p>
          <ul className="small">
            {gaps.map((g) => (
              <li key={g.id}>
                {g.full_name} — {g.issue}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" style={{ marginBottom: "var(--space-4)" }} aria-labelledby="rr-approvers">
        <h2 id="rr-approvers">Configured Unit Heads</h2>
        <p className="small muted" style={{ marginTop: 0 }}>Each must hold the Unit Head (credit approval) role. If one is not set, requests reaching that stage wait in the assignment exception queue; no other Unit Head is used.</p>
        <div className="table-wrap">
          <table className="data small">
            <thead>
              <tr>
                <th scope="col">Stage</th>
                <th scope="col">Current</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(ROUTING_KEYS) as RoutingKey[]).map((k) => {
                const cur = assigned.find((a) => a.key === k);
                return (
                  <tr key={k}>
                    <td>{ROUTING_KEYS[k]}</td>
                    <td>{cur?.full_name ?? <span className="muted">Not set</span>}</td>
                    <td>
                      <AssignmentForm routingKey={k} current={cur?.staff_id ?? null} unitHeads={unitHeads} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{ marginBottom: "var(--space-4)" }} aria-labelledby="rr-rbe">
        <h2 id="rr-rbe">Regional Business Executives</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          {rbes.length ? rbes.map((r) => `${r.name} (${portfolio.get(r.id) ?? 0} RM${portfolio.get(r.id) === 1 ? "" : "s"})`).join(" · ") : "No Regional Business Executive is provisioned yet."}
        </p>
        <h3 className="small" style={{ margin: "var(--space-3) 0 var(--space-2)" }}>Provision a new RBE</h3>
        <p className="small muted" style={{ marginTop: 0 }}>Grants only the RBE role (approval queue, RM portfolio and regional reporting). It does not grant product origination. An existing staff member is never duplicated: grant them the RBE role from Staff instead.</p>
        <ProvisionRbeForm />
      </section>

      <section className="card" aria-labelledby="rr-rms">
        <h2 id="rr-rms">Relationship Managers ({rms.length})</h2>
        <div className="table-wrap">
          <table className="data small">
            <thead>
              <tr>
                <th scope="col">Relationship Manager</th>
                <th scope="col">Current</th>
                <th scope="col">Classify</th>
              </tr>
            </thead>
            <tbody>
              {rms.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.name}
                    {r.team && <div className="muted">Team {r.team}</div>}
                  </td>
                  <td>
                    {!r.segment ? (
                      <span className="badge badge-red">Not classified</span>
                    ) : r.segment === "DBC" ? (
                      `DBC · ${DBC_REGIONS[r.dbc_region as keyof typeof DBC_REGIONS] ?? "—"}`
                    ) : (
                      `Non-DBC · RBE: ${r.rbe_name ?? "not set"}`
                    )}
                    {r.business_unit && <div className="muted">{r.business_unit}</div>}
                  </td>
                  <td>
                    <ClassifyForm staffId={r.id} segment={r.segment} dbcRegion={r.dbc_region} rbeId={r.rbe_id} businessUnit={r.business_unit} rbes={rbes.filter((b) => b.id !== r.id)} />
                  </td>
                </tr>
              ))}
              {!rms.length && (
                <tr>
                  <td colSpan={3} className="muted">No active Relationship Managers.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
