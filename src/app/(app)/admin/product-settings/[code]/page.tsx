import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, ExternalLink, Lock } from "lucide-react";
import { requireSuperAdmin } from "../../guard";
import { db } from "@/server/db";
import { draftOf, generalOf, KNOWN_DOCUMENTS, ORIGINATION_CEILING, settingsAuditRef, versionsOf } from "@/server/domain/product-settings";
import { configGaps, FULFILMENT_KINDS, FULFILMENT_LABELS, getProduct, INITIAL_PRODUCT_CONFIGS, BLOCKED_ACTION_LABELS } from "@/server/domain/products";
import { listContractTypes } from "@/server/domain/product-admin";
import { CATEGORY_LABEL } from "@/server/domain/documents";
import { ROLES, ROLE_LABELS, type Role } from "@/server/domain/roles";
import { workflowProduct } from "@/lib/approval-workflow";
import { applySalariedDocumentUpdate, diffSettings, SALARIED_DOCUMENT_UPDATE, STATUS, type General } from "@/lib/product-settings";
import { formatLagos, lagosDate } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { SettingsEditor, ChangeList } from "../SettingsEditor";
import { DiscardDraft, DismissProposal, GeneralForm, StartDraft } from "../ProductForms";

export async function generateMetadata({ params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code;
  const p = code === "ALTPHONES" ? { name: "Altphones" } : await getProduct(db, code);
  return { title: `${p?.name ?? "Product"} settings` };
}

const label = (r: string) => ROLE_LABELS[r as Role] ?? r;
const APPROVER_EXCLUDED = ["SUPER_ADMIN", "REPORTING_ADMIN", "LEGAL_REVIEWER", "SHARIAH_REVIEWER", "RM", "DELIGHT_OFFICER", "ANM", "MERCHANT_OFFICER", "SMILE_ASSOCIATE"];

export default async function ProductSettings({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ published?: string; edit?: string; a?: string; b?: string }> }) {
  await requireSuperAdmin();
  const code = (await params).code;
  const sp = await searchParams;
  if (code === "ALTPHONES") return <AltphonesHub />;
  const product = await getProduct(db, code);
  if (!product) notFound();
  if (product.workflow === "WAKEELBOOST") return <WakeelBoostHub product={product} />;
  if (product.workflow !== "RETAIL") notFound();

  const now = new Date();
  const [versions, draft, contractTypes] = await Promise.all([versionsOf(db, code), draftOf(db, code), listContractTypes(db)]);
  const published = versions.filter((v) => v.status === "APPROVED");
  const live = published.filter((v) => new Date(v.effective_from) <= now).sort((a, b) => +new Date(b.effective_from) - +new Date(a.effective_from) || b.version - a.version)[0] ?? null;
  const latest = published[0] ?? null;
  const proposals = versions.filter((v) => v.status === "PROPOSED");
  const general = generalOf(product);
  const gaps = live ? configGaps(live.config) : [];
  const status = draft ? "DRAFT" : !latest ? "NOT_SET_UP" : !product.active ? "CLOSED" : !live ? "SCHEDULED" : gaps.length ? "INCOMPLETE" : "PUBLISHED";
  const just = sp.published && /^[0-9a-f-]{36}$/.test(sp.published) ? versions.find((v) => v.id === sp.published) : null;
  const ceiling = (ORIGINATION_CEILING.RETAIL ?? []).map((r) => [r, label(r)] as [string, string]);
  const editorBase = {
    code,
    productName: product.name,
    ceiling,
    documents: KNOWN_DOCUMENTS.map((d) => [d, CATEGORY_LABEL[d]] as [string, string]).sort((a, b) => a[1].localeCompare(b[1])),
    contractTypes: contractTypes.filter((c) => c.active).map((c) => [c.code, c.name] as [string, string]),
    approverRoles: ROLES.filter((r) => !APPROVER_EXCLUDED.includes(r)).map((r) => [r, label(r)] as [string, string]),
    fulfilment: FULFILMENT_KINDS.map((f) => [f, FULFILMENT_LABELS[f]] as [string, string]),
    workflowHref: workflowProduct(code) ? `/admin/workflows/${code}` : null,
    today: lagosDate(now),
    published: latest ? { config: latest.config, general, version: latest.version } : null,
  };
  // Compare any two versions (the pickers default to the two most recent; shown once requested).
  const a = versions.find((v) => String(v.version) === sp.a) ?? published[1] ?? null;
  const b = versions.find((v) => String(v.version) === sp.b) ?? published[0] ?? null;
  const comparison = sp.a && sp.b && a && b && a.id !== b.id ? diffSettings({ config: a.config }, { config: b.config }) : null;

  return (
    <>
      <Link href="/admin/product-settings" className="btn btn-ghost btn-sm" style={{ marginBottom: "var(--space-3)" }}>
        <ArrowLeft className="icon" aria-hidden="true" /> All products
      </Link>
      <PageHeader
        eyebrow="Product settings"
        title={product.name}
        intro={
          live
            ? `Version ${live.version} in force since ${formatLagos(live.effective_from)}${live.published_via === "DIRECT" && live.proposed_by_name ? `, published by ${live.proposed_by_name}` : ""}.`
            : latest
              ? `Version ${latest.version} takes effect ${formatLagos(latest.effective_from)}.`
              : "This product's rules have not been set up yet. New requests cannot be started until version 1 is published."
        }
      />
      <p style={{ marginTop: "calc(-1 * var(--space-3))" }}>
        <span className={STATUS[status].cls}>{STATUS[status].label}</span>
      </p>

      {just && just.status === "APPROVED" && (
        <div className="alert alert-success wf-published" role="status">
          <CheckCircle2 className="icon" aria-hidden="true" />
          <div>
            <strong>Published.</strong> {product.name} rules version {just.version} {new Date(just.effective_from) <= now ? "are in force now" : `take effect ${formatLagos(just.effective_from)}`} for requests started from then. Requests already started keep their version.
            <dl className="wf-meta">
              <div>
                <dt>Version</dt>
                <dd>{just.version}</dd>
              </div>
              <div>
                <dt>Effective</dt>
                <dd>{formatLagos(just.effective_from)}</dd>
              </div>
              <div>
                <dt>Changes</dt>
                <dd>{just.changes?.length ?? 0}</dd>
              </div>
              <div>
                <dt>Audit reference</dt>
                <dd className="mono">{settingsAuditRef(code, just.version, just.id)}</dd>
              </div>
            </dl>
          </div>
        </div>
      )}

      {!draft && latest && applySalariedDocumentUpdate(latest.config) && (
        <section className="card ps-update" aria-labelledby="ps-upd">
          <h2 id="ps-upd">Approved update ready: {SALARIED_DOCUMENT_UPDATE.title}</h2>
          <p className="small" style={{ marginTop: 0 }}>{SALARIED_DOCUMENT_UPDATE.summary}</p>
          <details>
            <summary className="small">What it changes</summary>
            <ChangeList changes={diffSettings({ config: latest.config }, { config: applySalariedDocumentUpdate(latest.config) })} />
          </details>
          <p className="small muted">Nothing changes until you review the draft and publish it with a reason. Requests already started keep their version.</p>
          <StartDraft productCode={code} kind="VERSION" update={SALARIED_DOCUMENT_UPDATE.key} label="Load into draft" primary />
        </section>
      )}

      {proposals.length > 0 && (
        <section className="card" aria-labelledby="ps-props">
          <h2 id="ps-props">Earlier proposals</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            These were proposed under the earlier two-person approval process and were never approved. Load one into the draft to review and publish it, or dismiss it with a reason. Nothing is applied automatically, and publishing a new version supersedes them.
          </p>
          <ul className="ps-proposals">
            {proposals.map((v) => {
              const ch = diffSettings({ config: latest?.config ?? {} }, { config: v.config });
              return (
                <li key={v.id}>
                  <div>
                    <strong>Proposal {v.version}</strong>{" "}
                    <span className="small muted">
                      {v.proposed_by_name ? `by ${v.proposed_by_name}` : "by the system (policy update)"} · {formatLagos(v.proposed_at)}
                    </span>
                    <p className="small" style={{ margin: "4px 0" }}>
                      {v.reason}
                    </p>
                    <details>
                      <summary className="small">What it would change ({ch.length})</summary>
                      <ChangeList changes={ch} />
                    </details>
                  </div>
                  <div className="ps-proposal-actions">
                    <StartDraft productCode={code} kind="PROPOSAL" refValue={v.id} replace={!!draft} label="Load into draft" confirm={draft ? "This replaces your current draft. Continue?" : undefined} />
                    <DismissProposal id={v.id} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {draft ? (
        <>
          <SettingsEditor
            key={`${draft.revision}-${draft.updated_at}`}
            {...editorBase}
            config={draft.config}
            general={draft.general as General}
            effectiveFrom={draft.effective_from}
            revision={draft.revision}
            readOnly={false}
            draftNote={`Draft ${draft.source === "VERSION" ? `from version ${draft.source_ref}` : draft.source === "PROPOSAL" ? "from an earlier proposal" : draft.source === "SUPPLIED" ? "from the supplied parameters" : "started blank"} · last saved ${formatLagos(draft.updated_at)}${draft.updated_by_name ? ` by ${draft.updated_by_name}` : ""}`}
          />
          <div className="ps-below">
            <DiscardDraft productCode={code} />
          </div>
        </>
      ) : latest ? (
        <>
          <div className="ps-actions" style={{ marginBottom: "var(--space-4)" }}>
            <StartDraft productCode={code} kind="VERSION" label="Edit Configuration" primary />
          </div>
          {gaps.length > 0 && (
            <div className="alert alert-warn">
              <div>
                <strong>Settings still to complete in the version in force</strong>
                <ul className="small">
                  {gaps.map((g) => (
                    <li key={g.key}>
                      {g.label}: {BLOCKED_ACTION_LABELS[g.blocks].toLowerCase()} is blocked
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <SettingsEditor {...editorBase} config={latest.config} general={general} effectiveFrom={null} revision={0} readOnly draftNote={null} />
        </>
      ) : (
        <section className="card" aria-labelledby="ps-setup">
          <h2 id="ps-setup">Set Up Product</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            Start a draft. You can save it at any time and publish it when it is complete; publishing creates version 1.
          </p>
          <div className="ps-actions">
            {INITIAL_PRODUCT_CONFIGS[code] && <StartDraft productCode={code} kind="SUPPLIED" label="Start from the parameters supplied by the bank" primary />}
            <StartDraft productCode={code} kind="BLANK" label="Start with a blank form" primary={!INITIAL_PRODUCT_CONFIGS[code]} />
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="ps-hist" style={{ marginTop: "var(--space-5)" }}>
        <div className="card-head">
          <h2 id="ps-hist">Version history</h2>
        </div>
        {versions.length === 0 ? (
          <p className="small muted">No versions yet.</p>
        ) : (
          <ol className="wf-history">
            {versions.map((v) => (
              <li key={v.id}>
                <div className="wf-history-head">
                  <strong>Version {v.version}</strong>
                  {live?.id === v.id && <span className="badge badge-green">In force</span>}
                  {v.status === "APPROVED" && new Date(v.effective_from) > now && <span className="badge badge-blue">Scheduled</span>}
                  {v.status === "PROPOSED" && <span className="badge badge-warn">Proposal (not approved)</span>}
                  {v.status === "WITHDRAWN" && <span className="badge">Withdrawn</span>}
                  {v.status === "REJECTED" && <span className="badge badge-red">Rejected</span>}
                  {v.status === "APPROVED" && v.id !== live?.id && new Date(v.effective_from) <= now && <span className="badge">Superseded</span>}
                  <span className="small muted">
                    effective {formatLagos(v.effective_from)} ·{" "}
                    {v.published_via === "DIRECT" ? `published by ${v.proposed_by_name ?? "a Super Admin"}` : v.status === "APPROVED" ? `proposed by ${v.proposed_by_name ?? "the system"}, approved by ${v.decided_by_name ?? "the system"}` : `proposed by ${v.proposed_by_name ?? "the system"}`}
                    {v.restored_from ? ` · restored from version ${v.restored_from}` : ""}
                  </span>
                </div>
                <p className="small" style={{ margin: "4px 0" }}>
                  <span className="muted">Reason:</span> {v.reason}
                  {v.decision_note && v.status !== "APPROVED" ? (
                    <>
                      {" "}
                      <span className="muted">· {v.decision_note}</span>
                    </>
                  ) : null}
                </p>
                {v.changes && v.changes.length > 0 && (
                  <details>
                    <summary className="small">{v.changes.length} change{v.changes.length === 1 ? "" : "s"}</summary>
                    <ChangeList changes={v.changes} />
                  </details>
                )}
                {v.status === "APPROVED" && v.id !== latest?.id && <StartDraft productCode={code} kind="VERSION" refValue={String(v.version)} replace={!!draft} label={`Restore version ${v.version} as a draft`} small confirm={draft ? "This replaces your current draft. Continue?" : undefined} />}
              </li>
            ))}
          </ol>
        )}
        {versions.length > 1 && (
          <div className="ps-compare" id="ps-compare">
            <h3>Compare versions</h3>
            <form method="get" action="#ps-compare" className="ps-compare-form">
              <div className="field">
                <label htmlFor="cmp-a">From</label>
                <select id="cmp-a" name="a" defaultValue={a ? String(a.version) : ""}>
                  {versions.map((v) => (
                    <option key={v.id} value={v.version}>
                      Version {v.version}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="cmp-b">To</label>
                <select id="cmp-b" name="b" defaultValue={b ? String(b.version) : ""}>
                  {versions.map((v) => (
                    <option key={v.id} value={v.version}>
                      Version {v.version}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn btn-sm" type="submit">
                Compare
              </button>
            </form>
            {comparison && (
              <>
                <p className="small muted">
                  Version {a!.version} → version {b!.version}: {comparison.length} difference{comparison.length === 1 ? "" : "s"}
                </p>
                <ChangeList changes={comparison} />
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}

function Hub({ items }: { items: { title: string; text: string; href?: string; link?: string; fixed?: boolean }[] }) {
  return (
    <div className="ps-hub">
      {items.map((i) => (
        <section key={i.title} className="card ps-hub-card">
          <h2>
            {i.fixed && <Lock className="icon" aria-hidden="true" />} {i.title}
          </h2>
          <p className="small muted">{i.text}</p>
          {i.href && (
            <Link href={i.href} className="btn btn-sm">
              {i.link} <ExternalLink className="icon" aria-hidden="true" />
            </Link>
          )}
        </section>
      ))}
    </div>
  );
}

async function WakeelBoostHub({ product }: { product: NonNullable<Awaited<ReturnType<typeof getProduct>>> }) {
  const ceiling = (ORIGINATION_CEILING.WAKEELBOOST ?? []).map((r) => [r, label(r)] as [string, string]);
  return (
    <>
      <Link href="/admin/product-settings" className="btn btn-ghost btn-sm" style={{ marginBottom: "var(--space-3)" }}>
        <ArrowLeft className="icon" aria-hidden="true" /> All products
      </Link>
      <PageHeader eyebrow="Product settings" title={product.name} intro="WakeelBoost keeps its existing settings logic. General settings are changed here directly, with a reason; pricing and the approval workflow have their own versioned screens." />
      <section className="card" aria-labelledby="wb-general">
        <h2 id="wb-general">General</h2>
        <GeneralForm productCode={product.code} general={generalOf(product)} ceiling={ceiling} />
      </section>
      <Hub
        items={[
          { title: "Eligibility & KYC", text: "Business owners only (merchant financing). BVN and identity verification and the SeedFi credit check apply to every request.", fixed: true },
          { title: "Financing & Pricing", text: "Pricing and tenor are versioned under WakeelBoost pricing.", href: "/admin/pricing", link: "Open pricing" },
          { title: "Approval Workflow", text: "Approval stages and credit authority.", href: "/admin/workflows/WAKEELBOOST", link: "Open approval workflow" },
          { title: "Documentation", text: "WakeelBoost uses its fixed document checklist.", fixed: true },
          { title: "Controls & Exceptions", text: "Segregation of duties, no self-approval and the approval verification checklist are mandatory.", fixed: true },
        ]}
      />
    </>
  );
}

function AltphonesHub() {
  return (
    <>
      <Link href="/admin/product-settings" className="btn btn-ghost btn-sm" style={{ marginBottom: "var(--space-3)" }}>
        <ArrowLeft className="icon" aria-hidden="true" /> All products
      </Link>
      <PageHeader eyebrow="Product settings" title="Altphones" intro="Altphones keeps its existing settings logic: its catalogue, pricing and sales policy are managed in Altphones settings." />
      <Hub
        items={[
          { title: "General", text: "Originated only by Delight Officers and Smile Associates. This cannot be changed.", fixed: true },
          { title: "Eligibility & KYC", text: "Customer identity verification and the SeedFi credit check, set in the sales policy.", href: "/altphones/manage", link: "Open Altphones settings" },
          { title: "Financing & Pricing", text: "Device catalogue, prices, down payment and tenor.", href: "/altphones/manage", link: "Open Altphones settings" },
          { title: "Approval Workflow", text: "Review stages for device financing.", href: "/admin/workflows/ALTPHONES", link: "Open approval workflow" },
          { title: "Documentation", text: "The Altphones sale checklist is fixed.", fixed: true },
          { title: "Controls & Exceptions", text: "Segregation of duties, no self-approval and the approval verification checklist are mandatory.", fixed: true },
        ]}
      />
    </>
  );
}
