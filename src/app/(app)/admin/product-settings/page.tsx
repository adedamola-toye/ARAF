import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { productSettingsList } from "@/server/domain/product-settings";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { ProductList, type ListRow } from "./ProductList";
import { explainAccess } from "../../requests/new/catalogue";

export const metadata = { title: "Product settings" };

export default async function ProductSettingsPage({ searchParams }: { searchParams: Promise<{ access?: string }> }) {
  await requireSuperAdmin();
  const now = new Date();
  const list = await productSettingsList(db, now);
  const rows: ListRow[] = list.map((p) => {
    const status = !p.active && p.status !== "NOT_SET_UP" && p.status !== "DRAFT" ? "CLOSED" : p.status;
    const detail =
      p.kind === "ALTPHONES"
        ? "Device catalogue, pricing and policy"
        : p.kind === "WAKEELBOOST"
          ? "Merchant stock financing: pricing and workflow in their own screens"
          : p.status === "DRAFT"
            ? `Draft saved ${formatLagos(p.draftAt!)}${p.version ? ` · version ${p.version} in force` : ""}`
            : p.version
              ? `Version ${p.version}, effective ${formatLagos(p.effective!)}${p.gaps ? ` · ${p.gaps} setting${p.gaps === 1 ? "" : "s"} still to complete` : ""}`
              : p.status === "SCHEDULED"
                ? `First version takes effect ${formatLagos(p.effective!)}`
                : "No product rules published yet";
    return { code: p.code, name: p.name, status, detail, proposals: p.proposals };
  });
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Product settings"
        intro="Set up and maintain each product's rules: eligibility, financing and pricing, approval workflow, documents and controls. Changes are saved as a draft, reviewed, then published as a new version with a reason. Requests keep the version they started under."
      />
      <ProductList rows={rows} />
      <AccessCheck email={(await searchParams).access ?? ""} now={now} />
    </>
  );
}

/** "Why can't this user see this product?": the same checks as the product cards, pages and server. */
async function AccessCheck({ email, now }: { email: string; now: Date }) {
  const r = email.trim() ? await explainAccess(db, email, now) : null;
  return (
    <section className="card" aria-labelledby="ps-access" style={{ marginTop: "var(--space-5)" }}>
      <h2 id="ps-access">Check a user&apos;s product access</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        Enter a staff email to see which products they can originate and why, using the same rules as the product cards and the server.
      </p>
      <form method="get" className="ps-compare-form">
        <div className="field" style={{ minWidth: 280 }}>
          <label htmlFor="access-email">Staff email</label>
          <input id="access-email" name="access" type="email" defaultValue={email} placeholder="name@altbank.ng" />
        </div>
        <button className="btn btn-sm" type="submit">
          Check access
        </button>
      </form>
      {email.trim() && !r && <p className="small err">No staff profile uses that email.</p>}
      {r && (
        <div style={{ marginTop: "var(--space-3)" }}>
          <p className="small" style={{ margin: "0 0 8px" }}>
            <strong>{r.name}</strong> · {r.status?.toLowerCase()} · roles: {r.roles.length ? r.roles.join(", ") : "none"}
          </p>
          <div className="table-wrap">
            <table className="data small">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Access</th>
                  <th scope="col">Customer types</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.product}>
                    <td>{l.product}</td>
                    <td>{l.ok ? <span className="badge badge-green">Can originate</span> : <span className="badge badge-warn">Cannot originate</span>}</td>
                    <td>{l.categories.join(", ")}</td>
                    <td>{l.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
