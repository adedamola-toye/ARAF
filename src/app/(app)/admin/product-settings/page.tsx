import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { productSettingsList } from "@/server/domain/product-settings";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { ProductList, type ListRow } from "./ProductList";

export const metadata = { title: "Product settings" };

export default async function ProductSettingsPage() {
  await requireSuperAdmin();
  const now = new Date();
  const list = await productSettingsList(db, now);
  const rows: ListRow[] = list.map((p) => {
    const status = !p.active && p.status !== "NOT_SET_UP" && p.status !== "DRAFT" ? "CLOSED" : p.status;
    const detail =
      p.kind === "ALTPHONES"
        ? "Device catalogue, pricing and policy"
        : p.kind === "WAKEELBOOST"
          ? "Legacy product: pricing and workflow in their own screens"
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
    </>
  );
}
