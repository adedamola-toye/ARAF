import "server-only";
import { DomainError } from "@/server/errors";
import { requireStaffFinancing } from "@/server/staff/permission";
import type { Authed } from "./auth";

/** The user's own authorised starting point (used by "Return to Dashboard"). */
export function dashboardFor(roles: readonly string[], activeRole: string | null): string {
  const altphones = ["SMILE_ASSOCIATE", "DELIGHT_OFFICER", "BUSINESS_PERFORMANCE_MANAGER", "ALTPHONES_PRODUCT_MANAGER"];
  if (roles.includes("SMILE_ASSOCIATE") || (activeRole && altphones.includes(activeRole))) return "/altphones";
  return roles.length ? "/queue" : "/";
}

/**
 * Page guard for Staff Financing screens. Asks the backend policy (which records a denied attempt in the
 * audit log) and returns where "Return to Dashboard" should go when access is refused, or null when allowed.
 */
export async function staffFinancingGate(a: Authed, action: string, target?: string | null): Promise<string | null> {
  try {
    await requireStaffFinancing(a.ctx, action, target);
    return null;
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") return dashboardFor(a.roles, a.session.activeRole);
    throw e;
  }
}
