import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { INITIATOR_ROLES, LEGACY_INITIATOR_ROLES, RETAIL_INITIATOR_ROLES, ROLE_LABELS } from "@/server/domain/roles";
import { BLOCKED_ACTION_LABELS, configGaps, effectiveConfig, listProducts, PROFILE_LABELS, RATE_CONVENTION_LABELS, INSURANCE_LABELS, structureLabel, type CustomerProfile } from "@/server/domain/products";
import { formatKobo } from "@/server/money";
import { NewRequestForm } from "./NewRequestForm";
import { NewRetailForm, type CatalogueProduct } from "./NewRetailForm";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Initiate New Request" };

export default async function NewRequest() {
  const { roles, session } = await requireUser();
  // The Delight Officer / Smile Associate workspace sells Altphones only.
  if (session.activeRole === "DELIGHT_OFFICER" || session.activeRole === "SMILE_ASSOCIATE") redirect("/altphones");
  const mine = [...new Set([...INITIATOR_ROLES, ...RETAIL_INITIATOR_ROLES])].filter((r) => roles.includes(r));
  if (!mine.length) redirect("/forbidden");
  const retailRoles = RETAIL_INITIATOR_ROLES.filter((r) => roles.includes(r));
  const legacyRoles = LEGACY_INITIATOR_ROLES.filter((r) => roles.includes(r));
  const products = await listProducts(db, { activeOnly: true });
  const now = new Date();
  const catalogue: CatalogueProduct[] = [];
  for (const p of products.filter((x) => x.workflow === "RETAIL")) {
    const cfg = await effectiveConfig(db, p.code, now);
    if (!cfg) continue;
    const profiles = (Object.entries(cfg.config.profiles) as [CustomerProfile, NonNullable<(typeof cfg.config.profiles)[CustomerProfile]>][])
      .filter(([, r]) => r?.enabled)
      .map(([code, r]) => {
        const gaps = configGaps(cfg.config, { profile: code });
        return {
          code,
          label: PROFILE_LABELS[code],
          eligibleTypes: r.eligibleApplicantTypes,
          note: r.eligibilityNote,
          limits: [r.maxAmountKobo !== null ? `Up to ${formatKobo(r.maxAmountKobo)}` : "Maximum amount not configured", r.maxTenorMonths !== null ? `up to ${r.maxTenorMonths} months` : "maximum tenor not configured", r.dsr.maxPercent ? `DSR ≤ ${r.dsr.maxPercent}%` : "DSR threshold not configured"].join(" · "),
          structures: r.structures.map((s) => ({
            code: s.code,
            label: structureLabel(s.code, s.label),
            rate: s.ratePercent ? `${s.ratePercent}%` : "rate not configured",
            convention: s.rateConvention ? RATE_CONVENTION_LABELS[s.rateConvention] : "rate convention not configured",
            insurance: s.insuranceBearer ? INSURANCE_LABELS[s.insuranceBearer] : "insurance treatment not configured",
          })),
          blocked: gaps.filter((g) => g.blocks === "SUBMISSION").map((g) => g.label),
          laterBlocks: [...new Set(gaps.filter((g) => g.blocks !== "SUBMISSION").map((g) => BLOCKED_ACTION_LABELS[g.blocks]))],
        };
      });
    catalogue.push({ code: p.code, name: p.name, description: p.description ?? "", configVersion: cfg.version, profiles });
  }
  const showLegacy = legacyRoles.length > 0 && products.some((p) => p.code === "WAKEELBOOST");
  const def = (RETAIL_INITIATOR_ROLES as readonly string[]).includes(session.activeRole ?? "") ? session.activeRole! : retailRoles[0];
  return (
    <>
      <PageHeader eyebrow="Work" title="Initiate New Request" intro="Choose the product, the customer profile and the financing structure. Your draft is saved on the server and can be resumed at any time." />
      <section className="initiators" aria-labelledby="who">
        <h2 id="who" className="sr-only">Who initiates</h2>
        <div className={`initiator ${retailRoles.includes("RM") ? "is-mine" : ""}`}>
          <strong className="initiator-title">1. Relationship Managers</strong>
          <span className="small">Initiate any retail product. Review: Team Lead → Head of Retail Sales → Head of Unit (where configured) → credit.</span>
          {retailRoles.includes("RM") && <span className="badge badge-yellow">You hold this role</span>}
        </div>
        <div className={`initiator ${retailRoles.includes("DELIGHT_OFFICER") ? "is-mine" : ""}`}>
          <strong className="initiator-title">2. Delight Officers</strong>
          <span className="small">Initiate from an outlet. Review: Outlet Service Supervisor → Team Lead → Head of Retail Sales → Head of Unit (where configured) → credit.</span>
          {retailRoles.includes("DELIGHT_OFFICER") && <span className="badge badge-yellow">You hold this role</span>}
        </div>
        {(retailRoles.includes("TEAM_LEAD") || retailRoles.includes("UNIT_HEAD")) && (
          <div className="initiator is-mine">
            <strong className="initiator-title">3. Team Leads and Unit Heads</strong>
            <span className="small">Initiate products on the CX approval policy. Your request never comes back to you: it goes to independent CX credit review, then the Unit Head (another Unit Head, or the Divisional Head, if you are the Unit Head) and the Divisional Head.</span>
            <span className="badge badge-yellow">You hold this role</span>
          </div>
        )}
      </section>
      <p className="small muted" style={{ margin: "0 0 var(--space-4)" }}>
        What you can initiate depends on the roles provisioned for you ({mine.map((r) => ROLE_LABELS[r]).join(", ")}). Choosing a role here never grants a permission.
      </p>
      {retailRoles.length > 0 ? (
        <NewRetailForm products={catalogue} roles={retailRoles.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} defaultRole={def} />
      ) : (
        <div className="card">
          <p style={{ margin: 0 }}>Retail products are initiated by Relationship Managers, Delight Officers, Team Leads and Unit Heads. Ask an administrator if you need one of these roles.</p>
        </div>
      )}
      {showLegacy && (
        <details className="card" style={{ marginTop: "var(--space-5)" }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>WakeelBoost (legacy merchant stock financing)</summary>
          <div style={{ marginTop: 12, maxWidth: 760 }}>
            <NewRequestForm roles={legacyRoles.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} defaultRole={legacyRoles[0]} />
          </div>
        </details>
      )}
    </>
  );
}
