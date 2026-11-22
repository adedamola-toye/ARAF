import { requireRole } from "../../../../_lib/auth";
import { REGISTER_CSV_TEMPLATE } from "@/server/staff/register";

/** CSV template for the salary register (one illustrative row; replace it with real payroll data). */
export async function GET() {
  await requireRole(["SALARY_REGISTER_ADMIN", "SUPER_ADMIN"]);
  return new Response(REGISTER_CSV_TEMPLATE, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="salary-register-template.csv"', "cache-control": "no-store" } });
}
