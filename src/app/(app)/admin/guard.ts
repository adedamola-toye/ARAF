import "server-only";
import { requireRole } from "../../_lib/auth";

/** Admin pages require an active SUPER_ADMIN assignment (workspace choice does not grant it). */
export const requireSuperAdmin = () => requireRole(["SUPER_ADMIN"]);
