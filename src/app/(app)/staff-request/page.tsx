import Link from "next/link";
import { requireUser } from "../../_lib/auth";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Staff Personal Request" };

/**
 * INTEGRATION POINT: Staff Personal Request.
 * The landing page's third card routes here (via /enter/staff-personal-request). No staff personal
 * financing workflow exists in this platform yet; when the bank defines the product, eligibility and
 * approval route, implement it here (or point /enter/staff-personal-request at its workspace).
 */
export default async function StaffRequest() {
  await requireUser();
  return (
    <>
      <PageHeader eyebrow="Workspace" title="Staff Personal Request" intro="Apply for financing and track your request." />
      <div className="card" style={{ maxWidth: 640 }}>
        <p style={{ marginTop: 0 }}>Staff personal requests are not yet available on this platform. The product, eligibility rules and approval route have not been configured.</p>
        <Link className="btn btn-primary" href="/queue">
          Go to My Action Queue
        </Link>
      </div>
    </>
  );
}
