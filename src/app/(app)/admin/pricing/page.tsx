import Link from "next/link";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { configHistory, effectiveConfig, listProducts, structureLabel, CUSTOMER_PROFILES, PROFILE_LABELS, RATE_CONVENTION_LABELS } from "@/server/domain/products";
import { listContractTypes } from "@/server/domain/product-admin";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { ContractTypeForm, NewProductForm } from "./PricingForms";

export const metadata = { title: "Pricing and tenor" };

export default async function PricingAdmin() {
  await requireSuperAdmin();
  const now = new Date();
  const products = await listProducts(db, { retailOnly: true });
  const contractTypes = await listContractTypes(db);
  const ctName = new Map(contractTypes.map((c) => [c.code, c.name]));
  const loaded = await Promise.all(products.map(async (p) => ({ p, cfg: await effectiveConfig(db, p.code, now), pending: (await configHistory(db, p.code)).find((h) => h.status === "PROPOSED") ?? null })));
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Pricing and tenor"
        intro="Mark-ups and tenor in force for each product and contract type, the contract types themselves, and new products. Mark-ups and tenor are changed under Product Settings (Financing & Pricing) and published as a new version; requests already submitted keep the terms they were submitted under."
      />

      <section className="card" aria-labelledby="h-now">
        <h2 id="h-now">Mark-ups and tenor in force</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Customer profile</th>
                <th scope="col">Contract type</th>
                <th scope="col" className="num">Mark-up</th>
                <th scope="col">Applied</th>
                <th scope="col">Tenor (months)</th>
              </tr>
            </thead>
            <tbody>
              {loaded.flatMap(({ p, cfg, pending }) => {
                if (!cfg)
                  return [
                    <tr key={p.code}>
                      <td>{p.name}</td>
                      <td colSpan={5} className="muted">No approved configuration yet{pending ? " · first version awaiting approval" : ""}.</td>
                    </tr>,
                  ];
                return CUSTOMER_PROFILES.filter((pr) => cfg.config.profiles[pr]).flatMap((pr) => {
                  const r = cfg.config.profiles[pr]!;
                  const tenor = r.maxTenorMonths === null ? "maximum not set" : r.minTenorMonths ? `${r.minTenorMonths} to ${r.maxTenorMonths}` : `up to ${r.maxTenorMonths}`;
                  const rows = r.structures.length ? r.structures : [null];
                  return rows.map((s, i) => (
                    <tr key={`${p.code}-${pr}-${s?.code ?? "none"}`}>
                      <td>
                        {i === 0 && pr === CUSTOMER_PROFILES.find((x) => cfg.config.profiles[x]) ? (
                          <>
                            <strong>{p.name}</strong>
                            <div className="small muted">v{cfg.version}{pending ? <> · <Link href={`/admin/product-settings/${p.code}`}>earlier proposal v{pending.version} to review</Link></> : ""}</div>
                          </>
                        ) : null}
                      </td>
                      <td>{i === 0 ? PROFILE_LABELS[pr] : ""}</td>
                      <td>{s ? structureLabel(s.code, ctName.get(s.code) ?? s.label) : <span className="muted">none offered</span>}</td>
                      <td className="num">{s ? (s.ratePercent ? `${s.ratePercent}%` : <span className="badge badge-warn">not set</span>) : "—"}</td>
                      <td className="small">{s?.rateConvention ? RATE_CONVENTION_LABELS[s.rateConvention].split(" (")[0] : s ? <span className="muted">not set</span> : ""}</td>
                      <td>{i === 0 ? tenor : ""}</td>
                    </tr>
                  ));
                });
              })}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>To change a mark-up or the tenor, open the product under <Link href="/admin/product-settings">Product settings</Link> and edit Financing &amp; Pricing.</p>
      </section>

      <section className="card" aria-labelledby="h-ct">
        <h2 id="h-ct">Contract types</h2>
        <p className="small muted" style={{ marginTop: 0 }}>The contract types products can be offered under. A new one is available to every product; give it a mark-up on a product above to offer it. Contract types are never deleted: an inactive one stays on existing requests but cannot get new mark-ups.</p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Contract type</th>
                <th scope="col">Offered on</th>
                <th scope="col">Status</th>
                <th scope="col">Last changed</th>
              </tr>
            </thead>
            <tbody>
              {contractTypes.map((c) => {
                const on = loaded.filter(({ cfg }) => cfg && Object.values(cfg.config.profiles).some((r) => r?.structures.some((s) => s.code === c.code))).map(({ p }) => p.name);
                return (
                  <tr key={c.code}>
                    <td>
                      <details>
                        <summary>
                          <strong>{c.name}</strong> <span className="mono small muted">{c.code}</span>
                        </summary>
                        <div style={{ marginTop: 8 }}>
                          <ContractTypeForm value={{ code: c.code, name: c.name, description: c.description, active: c.active }} />
                        </div>
                      </details>
                      {c.description && <div className="small muted">{c.description}</div>}
                    </td>
                    <td>{on.length ? on.join(", ") : <span className="muted">not offered yet</span>}</td>
                    <td>{c.active ? "Active" : <span className="badge">Inactive</span>}</td>
                    <td className="small">{formatLagos(c.updated_at)}{c.updated_by_name ? ` by ${c.updated_by_name}` : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <h3>Add a contract type</h3>
        <ContractTypeForm />
      </section>

      <section className="card" aria-labelledby="h-np">
        <h2 id="h-np">Create a product</h2>
        <p className="small muted" style={{ marginTop: 0 }}>The new product copies the rules of an existing product (mark-ups, tenor, documents and approval chain) as its first configuration. It appears under Product settings as not set up, with the copied rules as a proposal: load it into a draft, adjust it, and publish version 1. It stays closed to applications until you open it there.</p>
        <NewProductForm products={products.map((p) => ({ value: p.code, label: p.name }))} />
      </section>
    </>
  );
}
