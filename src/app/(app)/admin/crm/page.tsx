import Link from "next/link";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { crmCatalogue, crmProducts, crmSettings, holdersOf, PRIORITIES, PRIORITY_LABELS } from "@/server/crm/core";
import { ESCALATION_TRIGGERS } from "@/server/crm/config";
import { STAGES, STAGE_LABELS } from "@/server/domain/stages";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { CfgForm } from "./CfgForm";

export const metadata = { title: "CRM configuration" };

const TABS: [string, string][] = [
  ["setup", "Setup and calendar"],
  ["catalogue", "Complaint categories"],
  ["teams", "Teams"],
  ["routing", "Routing rules"],
  ["sla", "SLA policies"],
  ["escalation", "Escalation rules"],
  ["reports", "Report scheduling"],
  ["audit", "Audit history"],
];
const DAYS: [number, string][] = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]];
type SP = { tab?: string; edit?: string; cat?: string };

function Sel({ name, label, opts, value, any = "Any", required }: { name: string; label: string; opts: [string, string][]; value?: string | null; any?: string | null; required?: boolean }) {
  const id = `cfg-${name}`;
  return (
    <div className="field" style={{ margin: 0 }}>
      <label htmlFor={id}>{label}</label>
      <select id={id} name={name} defaultValue={value ?? ""} required={required}>
        {any !== null && <option value="">{any}</option>}
        {opts.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}
function Active({ value = true, label = "Active" }: { value?: boolean; label?: string }) {
  return (
    <label className="check">
      <input type="checkbox" name="active" defaultChecked={value} /> {label}
    </label>
  );
}
const splitMins = (m: number | null): [string, string] => (m === null ? ["", "h"] : m % 1440 === 0 ? [String(m / 1440), "d"] : m % 60 === 0 ? [String(m / 60), "h"] : [String(m), "m"]);
function Target({ name, label, minutes }: { name: string; label: string; minutes: number | null }) {
  const [v, u] = splitMins(minutes);
  return (
    <div className="field" style={{ margin: 0 }}>
      <label htmlFor={`cfg-${name}`}>{label}</label>
      <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
        <input id={`cfg-${name}`} name={`${name}Value`} type="number" min={1} step="any" defaultValue={v} style={{ maxWidth: 110 }} />
        <select name={`${name}Unit`} defaultValue={u} aria-label={`${label} unit`}>
          <option value="m">minutes</option>
          <option value="h">hours</option>
          <option value="d">days</option>
        </select>
      </div>
    </div>
  );
}
const mins = (m: number | null) => (m === null ? "—" : m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`);

export default async function CrmConfig({ searchParams }: { searchParams: Promise<SP> }) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : "setup";
  const s = await crmSettings(db);
  const products = await crmProducts(db, { includeInactive: true });
  const productName = (c: string | null) => (c ? (products.find((p) => p.code === c)?.name ?? c) : "Any");
  const { categories, subcategories } = await crmCatalogue(db, { includeInactive: true });
  const catName = (id: string | null) => (id ? (categories.find((c) => c.id === id)?.name ?? "—") : "Any");
  const subName = (id: string | null) => (id ? (subcategories.find((c) => c.id === id)?.name ?? "—") : "Any");
  const teams = (
    await db.query<{ id: string; name: string; description: string | null; active: boolean; leads: string; officers: string }>(
      `SELECT t.id, t.name, t.description, t.active,
              count(*) FILTER (WHERE m.active AND m.member_role = 'LEAD') AS leads, count(*) FILTER (WHERE m.active AND m.member_role = 'OFFICER') AS officers
         FROM crm_teams t LEFT JOIN crm_team_members m ON m.team_id = t.id GROUP BY t.id ORDER BY t.name`,
    )
  ).rows;
  const teamOpts: [string, string][] = teams.filter((t) => t.active).map((t) => [t.id, t.name]);
  const teamName = (id: string | null) => (id ? (teams.find((t) => t.id === id)?.name ?? "—") : "Any");
  const catOpts: [string, string][] = categories.map((c) => [c.id, c.name + (c.active ? "" : " (inactive)")]);
  const subOpts: [string, string][] = subcategories.map((x) => [x.id, `${catName(x.category_id)} — ${x.name}${x.product_code ? ` (${productName(x.product_code)})` : ""}`]);
  const prodOpts: [string, string][] = products.map((p) => [p.code, p.name]);
  const prioOpts: [string, string][] = PRIORITIES.map((p) => [p, PRIORITY_LABELS[p]]);

  // Configuration still needed before the CRM can run as the bank intends (shown, never invented).
  const rules = Number((await db.query("SELECT count(*) AS n FROM crm_routing_rules WHERE active")).rows[0].n);
  const slas = Number((await db.query("SELECT count(*) AS n FROM crm_sla_policies WHERE active")).rows[0].n);
  const escs = Number((await db.query("SELECT count(*) AS n FROM crm_escalation_rules WHERE active")).rows[0].n);
  const schedulesOn = Number((await db.query("SELECT count(*) AS n FROM crm_report_schedules WHERE enabled")).rows[0].n);
  const cxHeads = await holdersOf(db, "CX_HEAD");
  const fallback = teams.find((t) => t.id === s.fallback_team_id);
  const gaps = [
    !cxHeads.length && ["No CX Head is assigned.", "/admin/staff", "Assign the CX Head role in Users & roles"],
    !teams.some((t) => t.active && t.id !== s.fallback_team_id) && ["No resolution teams exist yet.", "/admin/crm?tab=teams", "Create teams"],
    teams.some((t) => t.active && Number(t.leads) === 0) && ["Some teams have no Team Lead, so nobody can assign their tickets.", "/admin/crm?tab=teams", "Add Team Leads"],
    fallback && Number(fallback.leads) === 0 && ["The fallback queue has no Team Lead: unmatched complaints alert the CX Head and Super Admin until one is added.", "/admin/crm?tab=teams", "Add a lead to the fallback team"],
    !rules && ["No routing rules: every complaint goes to the fallback queue.", "/admin/crm?tab=routing", "Add routing rules"],
    !slas && ["No SLA policies: tickets show “No target” and no SLA breaches are measured.", "/admin/crm?tab=sla", "Add SLA policies"],
    !escs && ["No escalation rules: nothing is escalated automatically.", "/admin/crm?tab=escalation", "Add escalation rules"],
    !schedulesOn && ["Scheduled CX reports are off.", "/admin/crm?tab=reports", "Turn on report schedules"],
  ].filter(Boolean) as [string, string, string][];

  return (
    <>
      <PageHeader eyebrow="Administration" title="CRM configuration" intro="Categories, teams, routing, SLAs, escalation and reports. Every change needs a reason, applies immediately and is audited; existing tickets keep the details they were created with." />
      <nav className="tabs" aria-label="CRM configuration">
        {TABS.map(([k, l]) => (
          <Link key={k} className="tab" href={`/admin/crm?tab=${k}`} aria-current={tab === k ? "page" : undefined}>
            {l}
          </Link>
        ))}
      </nav>

      {tab === "setup" && (
        <div className="stack">
          {gaps.length > 0 && (
            <div className="alert alert-warn" role="status">
              <div>
                <strong>Configuration still needed</strong>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {gaps.map(([msg, href, cta]) => (
                    <li key={msg}>
                      {msg} <Link href={href}>{cta}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <div className="card" style={{ maxWidth: 820 }}>
            <h2>Fallback queue, closure policy and business calendar</h2>
            <CfgForm kind="settings">
              <Sel name="fallbackTeamId" label="Fallback queue (receives complaints no rule matches)" opts={teamOpts} value={s.fallback_team_id} any={null} required />
              <div className="grid-2">
                <Sel name="closurePolicy" label="Closure policy" opts={[["CONFIRMATION", "Complainant confirms (recommended)"], ["TIMEOUT", "Complainant confirms, or closes automatically after a timeout"]]} value={s.closure_policy} any={null} />
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="cfg-cto">Closure timeout (hours after resolution)</label>
                  <input id="cfg-cto" name="closureTimeoutHours" type="number" min={1} max={2160} defaultValue={s.closure_timeout_hours ?? ""} />
                  <span className="hint">Used only with the timeout policy.</span>
                </div>
              </div>
              <div className="grid-2">
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="cfg-ws">Working day starts (hour, 0–23)</label>
                  <input id="cfg-ws" name="workingStart" type="number" min={0} max={23} required defaultValue={s.working_start} />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="cfg-we">Working day ends (hour, 1–24)</label>
                  <input id="cfg-we" name="workingEnd" type="number" min={1} max={24} required defaultValue={s.working_end} />
                </div>
              </div>
              <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend>Working days</legend>
                <div className="row" style={{ gap: 14 }}>
                  {DAYS.map(([d, l]) => (
                    <label key={d} className="check" style={{ alignItems: "center" }}>
                      <input type="checkbox" name="workingDays" value={d} defaultChecked={s.working_days.includes(d)} /> {l}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="cfg-hol">Public holidays (YYYY-MM-DD, one per line)</label>
                <textarea id="cfg-hol" name="holidays" rows={3} defaultValue={s.holidays.join("\n")} />
              </div>
              <label className="check">
                <input type="checkbox" name="pauseOnPendingInfo" defaultChecked={s.pause_on_pending_info} /> Pause the resolution clock while waiting for information from the complainant (permitted SLA pause reason)
              </label>
            </CfgForm>
            <p className="small muted">Last changed {formatLagos(s.updated_at)}. Times are Africa/Lagos.</p>
          </div>
        </div>
      )}

      {tab === "catalogue" && (
        <div className="split">
          <section className="stack" style={{ minWidth: 0 }}>
            {categories.map((c) => {
              const issues = subcategories.filter((x) => x.category_id === c.id);
              return (
                <details key={c.id} className="card" open={sp.cat === c.id}>
                  <summary>
                    <strong>{c.name}</strong> <span className="small muted">· {issues.length} issue(s)</span> {!c.active && <span className="badge">Inactive</span>}{" "}
                    <Link className="small" href={`/admin/crm?tab=catalogue&edit=cat:${c.id}&cat=${c.id}`}>
                      Edit category
                    </Link>
                  </summary>
                  <table className="data" style={{ marginTop: 8 }}>
                    <caption className="sr-only">Issues in {c.name}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Issue</th>
                        <th scope="col">Product</th>
                        <th scope="col">Default priority</th>
                        <th scope="col">
                          <span className="sr-only">Edit</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {issues.map((x) => (
                        <tr key={x.id}>
                          <td>
                            {x.name} {!x.active && <span className="badge">Inactive</span>}
                          </td>
                          <td>{x.product_code ? productName(x.product_code) : "All products"}</td>
                          <td>{PRIORITY_LABELS[x.default_priority]}</td>
                          <td>
                            <Link className="small" href={`/admin/crm?tab=catalogue&edit=issue:${x.id}&cat=${c.id}`}>
                              Edit
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              );
            })}
          </section>
          <aside className="split-right">
            {(() => {
              const [kind, id] = (sp.edit ?? "").split(":");
              if (kind === "cat") {
                const c = categories.find((x) => x.id === id);
                if (c)
                  return (
                    <div className="card">
                      <h2 style={{ fontSize: 15 }}>Edit category</h2>
                      <CfgForm kind="category" hidden={{ id: c.id }}>
                        <div className="field" style={{ margin: 0 }}>
                          <label htmlFor="cfg-cn">Name</label>
                          <input id="cfg-cn" name="name" required defaultValue={c.name} />
                        </div>
                        <div className="field" style={{ margin: 0 }}>
                          <label htmlFor="cfg-cso">Display order</label>
                          <input id="cfg-cso" name="sortOrder" type="number" defaultValue={c.sort_order} />
                        </div>
                        <Active value={c.active} label="Active (shown on the complaint form)" />
                      </CfgForm>
                    </div>
                  );
              }
              const x = kind === "issue" ? subcategories.find((y) => y.id === id) : null;
              return (
                <div className="card">
                  <h2 style={{ fontSize: 15 }}>{x ? "Edit issue" : "Add an issue"}</h2>
                  <CfgForm kind="issue" hidden={x ? { id: x.id } : {}}>
                    <Sel name="categoryId" label="Category" opts={catOpts} value={x?.category_id ?? sp.cat} any={null} required />
                    <div className="field" style={{ margin: 0 }}>
                      <label htmlFor="cfg-in">Issue</label>
                      <input id="cfg-in" name="name" required defaultValue={x?.name} />
                    </div>
                    <Sel name="productCode" label="Shown for" opts={prodOpts} value={x?.product_code} any="All products" />
                    <Sel name="defaultPriority" label="Default priority" opts={prioOpts} value={x?.default_priority ?? "NORMAL"} any={null} />
                    <Active value={x?.active ?? true} />
                  </CfgForm>
                  {x && (
                    <p className="small">
                      <Link href={`/admin/crm?tab=catalogue&cat=${x.category_id}`}>Add a new issue instead</Link>
                    </p>
                  )}
                </div>
              );
            })()}
            <div className="card">
              <h2 style={{ fontSize: 15 }}>Add a category</h2>
              <CfgForm kind="category">
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="cfg-ncn">Name</label>
                  <input id="cfg-ncn" name="name" required />
                </div>
                <Active />
              </CfgForm>
            </div>
          </aside>
        </div>
      )}

      {tab === "teams" && <Teams teams={teams} fallbackId={s.fallback_team_id} editId={sp.edit} />}

      {tab === "routing" && (
        <Rules
          kind="routing"
          rows={(await db.query("SELECT * FROM crm_routing_rules ORDER BY active DESC, created_at")).rows}
          editId={sp.edit}
          head={["Product", "Category", "Issue", "Stage", "Team", "Priority", "Active"]}
          cells={(r) => [productName(r.product_code), catName(r.category_id), subName(r.subcategory_id), r.stage ? (STAGE_LABELS[r.stage as keyof typeof STAGE_LABELS] ?? r.stage) : "Any", teamName(r.team_id), r.priority_override ? PRIORITY_LABELS[r.priority_override as keyof typeof PRIORITY_LABELS] : "Issue default", r.active ? "Yes" : "No"]}
          intro="The most specific active rule wins (issue, then category, then workflow stage, then product). Complaints no rule matches go to the fallback queue."
          form={(r) => (
            <>
              <Sel name="productCode" label="Product" opts={prodOpts} value={r?.product_code} />
              <Sel name="categoryId" label="Category" opts={catOpts} value={r?.category_id} />
              <Sel name="subcategoryId" label="Issue" opts={subOpts} value={r?.subcategory_id} />
              <Sel name="stage" label="Workflow stage of the linked request" opts={STAGES.map((x) => [x, STAGE_LABELS[x]])} value={r?.stage} />
              <Sel name="teamId" label="Responsible team" opts={teamOpts} value={r?.team_id} any="Choose…" required />
              <Sel name="priorityOverride" label="Priority" opts={prioOpts} value={r?.priority_override} any="Use the issue's default" />
              <Active value={r?.active ?? true} />
            </>
          )}
        />
      )}

      {tab === "sla" && (
        <Rules
          kind="sla"
          rows={(await db.query("SELECT * FROM crm_sla_policies ORDER BY active DESC, created_at")).rows}
          editId={sp.edit}
          head={["Policy", "Applies to", "Assignment", "First response", "Resolution", "Clock", "Active"]}
          cells={(r) => [r.name, [r.product_code && productName(r.product_code), r.category_id && catName(r.category_id), r.subcategory_id && subName(r.subcategory_id), r.priority && PRIORITY_LABELS[r.priority as keyof typeof PRIORITY_LABELS], r.team_id && teamName(r.team_id)].filter(Boolean).join(" · ") || "All complaints", mins(r.assignment_minutes), mins(r.first_response_minutes), mins(r.resolution_minutes), r.business_hours ? "Business hours" : "Continuous", r.active ? "Yes" : "No"]}
          intro="Targets are set by the bank; none are assumed. The most specific active policy applies when a ticket is created and its deadlines are kept for that ticket."
          form={(r) => (
            <>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="cfg-sn">Policy name</label>
                <input id="cfg-sn" name="name" required defaultValue={r?.name} />
              </div>
              <Sel name="productCode" label="Product" opts={prodOpts} value={r?.product_code} />
              <Sel name="categoryId" label="Category" opts={catOpts} value={r?.category_id} />
              <Sel name="subcategoryId" label="Issue" opts={subOpts} value={r?.subcategory_id} />
              <Sel name="priority" label="Priority" opts={prioOpts} value={r?.priority} />
              <Sel name="teamId" label="Responsible team" opts={teamOpts} value={r?.team_id} />
              <Target name="assignment" label="Assignment target" minutes={r?.assignment_minutes ?? null} />
              <Target name="firstResponse" label="First response target" minutes={r?.first_response_minutes ?? null} />
              <Target name="resolution" label="Resolution target" minutes={r?.resolution_minutes ?? null} />
              <Sel name="clock" label="Clock" opts={[["business", "Business hours (working calendar)"], ["continuous", "Continuous (24/7)"]]} value={r && !r.business_hours ? "continuous" : "business"} any={null} />
              <Active value={r?.active ?? true} />
            </>
          )}
        />
      )}

      {tab === "escalation" && (
        <Rules
          kind="escalation"
          rows={(await db.query("SELECT * FROM crm_escalation_rules ORDER BY active DESC, created_at")).rows}
          editId={sp.edit}
          head={["When", "Notify", "Marks escalated", "Active"]}
          cells={(r) => [`${ESCALATION_TRIGGERS[r.trigger]?.label} ${r.threshold} ${ESCALATION_TRIGGERS[r.trigger]?.unit}`, [r.notify_team_lead && "Team Lead", r.notify_cx_head && "CX Head"].filter(Boolean).join(", ") || "—", r.mark_escalated ? "Yes" : "No", r.active ? "Yes" : "No"]}
          intro="Each rule fires at most once per ticket, so nobody receives repeated alerts. Time-based rules use each ticket's SLA clock (business hours unless its policy is continuous)."
          form={(r) => (
            <>
              <Sel name="trigger" label="When" opts={Object.entries(ESCALATION_TRIGGERS).map(([k, v]) => [k, `${v.label} … ${v.unit}`])} value={r?.trigger} any="Choose…" required />
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="cfg-th">Threshold</label>
                <input id="cfg-th" name="threshold" type="number" min={1} required defaultValue={r?.threshold} />
              </div>
              <label className="check">
                <input type="checkbox" name="notifyTeamLead" defaultChecked={r?.notify_team_lead ?? true} /> Notify the team&apos;s Team Lead
              </label>
              <label className="check">
                <input type="checkbox" name="notifyCxHead" defaultChecked={r?.notify_cx_head ?? true} /> Notify the CX Head
              </label>
              <label className="check">
                <input type="checkbox" name="markEscalated" defaultChecked={r?.mark_escalated ?? true} /> Mark the ticket escalated
              </label>
              <Active value={r?.active ?? true} />
            </>
          )}
        />
      )}

      {tab === "reports" && <ReportSchedules />}

      {tab === "audit" && <ConfigAudit />}
    </>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function Rules({ kind, rows, editId, head, cells, form, intro }: { kind: string; rows: Row[]; editId?: string; head: string[]; cells: (r: Row) => React.ReactNode[]; form: (r: Row | null) => React.ReactNode; intro: string }) {
  const editing = rows.find((r) => r.id === editId) ?? null;
  return (
    <div className="split">
      <section style={{ minWidth: 0 }}>
        <p className="small muted">{intro}</p>
        <div className="table-wrap">
          <table className="data responsive">
            <caption className="sr-only">{kind} rules</caption>
            <thead>
              <tr>
                {head.map((h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ))}
                <th scope="col">
                  <span className="sr-only">Edit</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {cells(r).map((c, i) => (
                    <td key={i} data-label={head[i]}>
                      {c}
                    </td>
                  ))}
                  <td>
                    <Link className="small" href={`/admin/crm?tab=${kind}&edit=${r.id}`}>
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={head.length + 1} className="muted">
                    None configured yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <aside className="split-right">
        <div className="card">
          <h2 style={{ fontSize: 15 }}>{editing ? "Edit" : "Add"}</h2>
          <CfgForm key={editing?.id ?? "new"} kind={kind} hidden={editing ? { id: editing.id } : {}}>
            {form(editing)}
          </CfgForm>
          {editing && (
            <p className="small">
              <Link href={`/admin/crm?tab=${kind}`}>Add a new one instead</Link>
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

async function Teams({ teams, fallbackId, editId }: { teams: { id: string; name: string; description: string | null; active: boolean; leads: string; officers: string }[]; fallbackId: string; editId?: string }) {
  const members = (
    await db.query<{ team_id: string; staff_id: string; full_name: string; email: string; member_role: string }>(
      "SELECT m.team_id, m.staff_id, s.full_name, s.email, m.member_role FROM crm_team_members m JOIN staff s ON s.id = m.staff_id WHERE m.active ORDER BY m.member_role DESC, s.full_name",
    )
  ).rows;
  const editing = teams.find((t) => t.id === editId) ?? null;
  return (
    <div className="split">
      <section className="stack" style={{ minWidth: 0 }}>
        {teams.map((t) => (
          <div key={t.id} className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ fontSize: 16, margin: 0 }}>
                {t.name} {t.id === fallbackId && <span className="badge badge-blue">Fallback queue</span>} {!t.active && <span className="badge">Inactive</span>}
              </h2>
              <Link className="small" href={`/admin/crm?tab=teams&edit=${t.id}`}>
                Edit team
              </Link>
            </div>
            {t.description && <p className="small muted">{t.description}</p>}
            <ul className="small">
              {members
                .filter((m) => m.team_id === t.id)
                .map((m) => (
                  <li key={m.staff_id}>
                    {m.full_name} ({m.email}) · {m.member_role === "LEAD" ? "Team Lead" : "Resolution Officer"}
                  </li>
                ))}
              {!members.some((m) => m.team_id === t.id) && <li className="muted">No members yet.</li>}
            </ul>
            <details>
              <summary className="small">Add, change or remove a member</summary>
              <CfgForm kind="member" hidden={{ teamId: t.id }} compact>
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor={`cfg-me-${t.id}`}>Staff email (an existing ARAF user)</label>
                  <input id={`cfg-me-${t.id}`} name="email" type="email" required />
                </div>
                <Sel name="memberRole" label="Role in the team" opts={[["OFFICER", "Resolution Officer"], ["LEAD", "Team Lead / Queue Manager"], ["REMOVE", "Remove from the team"]]} any={null} />
              </CfgForm>
            </details>
          </div>
        ))}
      </section>
      <aside className="split-right">
        <div className="card">
          <h2 style={{ fontSize: 15 }}>{editing ? "Edit team" : "Create a team"}</h2>
          <CfgForm key={editing?.id ?? "new"} kind="team" hidden={editing ? { id: editing.id } : {}}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="cfg-tn">Team name</label>
              <input id="cfg-tn" name="name" required defaultValue={editing?.name} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="cfg-td">What it handles</label>
              <input id="cfg-td" name="description" defaultValue={editing?.description ?? ""} />
            </div>
            <Active value={editing?.active ?? true} />
          </CfgForm>
          <p className="small muted">CRM team membership gives CRM queue access only. It never grants financing, approval or administrative rights.</p>
        </div>
      </aside>
    </div>
  );
}

async function ReportSchedules() {
  const rows = (await db.query<{ frequency: string; enabled: boolean; send_hour: number; include_cx_heads: boolean; extra_recipient_ids: string[]; updated_at: Date }>("SELECT * FROM crm_report_schedules ORDER BY CASE frequency WHEN 'DAILY' THEN 1 WHEN 'WEEKLY' THEN 2 ELSE 3 END")).rows;
  const emails = (await db.query<{ id: string; email: string }>("SELECT id, email FROM staff WHERE id = ANY($1::uuid[])", [rows.flatMap((r) => r.extra_recipient_ids)])).rows;
  const label: Record<string, string> = { DAILY: "Daily complaint report (yesterday)", WEEKLY: "Weekly operational report (Monday–Sunday, sent Monday)", MONTHLY: "Monthly CX performance report (sent on the 1st)" };
  return (
    <div className="grid-3">
      {rows.map((r) => (
        <div key={r.frequency} className="card">
          <h2 style={{ fontSize: 15 }}>{label[r.frequency]}</h2>
          <CfgForm kind="report" hidden={{ frequency: r.frequency }}>
            <label className="check">
              <input type="checkbox" name="enabled" defaultChecked={r.enabled} /> Send this report
            </label>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor={`cfg-h-${r.frequency}`}>Send at (hour, Lagos)</label>
              <input id={`cfg-h-${r.frequency}`} name="sendHour" type="number" min={0} max={23} defaultValue={r.send_hour} />
            </div>
            <label className="check">
              <input type="checkbox" name="includeCxHeads" defaultChecked={r.include_cx_heads} /> Send to every active CX Head
            </label>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor={`cfg-x-${r.frequency}`}>Other recipients (emails)</label>
              <textarea id={`cfg-x-${r.frequency}`} name="extra" rows={2} defaultValue={emails.filter((e) => r.extra_recipient_ids.includes(e.id)).map((e) => e.email).join("\n")} />
              <span className="hint">Only staff holding CX Head, Super Admin, Reporting Admin or Executive View.</span>
            </div>
          </CfgForm>
        </div>
      ))}
      <p className="small muted" style={{ gridColumn: "1 / -1" }}>
        Reports are queued in the bank&apos;s email outbox (Administration → Email delivery shows whether they were sent) and are always available under CRM → CX Reports.
      </p>
    </div>
  );
}

async function ConfigAudit() {
  const rows = (
    await db.query<{ id: string; occurred_at: Date; action: string; actor_email: string | null; reason: string | null; details: Record<string, unknown> }>(
      "SELECT id, occurred_at, action, actor_email, reason, details FROM audit_events WHERE action LIKE 'CRM_CONFIG_%' OR action LIKE 'CRM_KB_%' ORDER BY id DESC LIMIT 200",
    )
  ).rows;
  return (
    <div className="table-wrap">
      <table className="data responsive">
        <caption className="sr-only">CRM configuration history</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Change</th>
            <th scope="col">By</th>
            <th scope="col">Reason</th>
            <th scope="col">Previous → new</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td data-label="When">{formatLagos(r.occurred_at)}</td>
              <td data-label="Change">{r.action.replace(/^CRM_(CONFIG_)?/, "").replace(/_/g, " ").toLowerCase()}</td>
              <td data-label="By">{r.actor_email ?? "—"}</td>
              <td data-label="Reason">{r.reason ?? "—"}</td>
              <td data-label="Previous → new">
                <details>
                  <summary className="small">Show</summary>
                  <pre className="small" style={{ whiteSpace: "pre-wrap", maxWidth: 520 }}>
                    {JSON.stringify(r.details, null, 1)}
                  </pre>
                </details>
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={5} className="muted">
                No configuration changes yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
