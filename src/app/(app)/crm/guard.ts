import "server-only";
import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { crmPrincipal, isOversight } from "@/server/crm/core";

/** CX Head or Super Admin only (organisation-wide complaint data). */
export async function requireOversight() {
  const a = await requireUser();
  const p = await crmPrincipal(db, a.session.staffId);
  if (!isOversight(p)) redirect("/forbidden");
  return { ...a, principal: p };
}
