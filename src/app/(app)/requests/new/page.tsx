import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { INITIATOR_ROLES, ROLE_LABELS, isInitiatorRole } from "@/server/domain/roles";
import { NewRequestForm } from "./NewRequestForm";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Initiate New Request" };

export default async function NewRequest() {
  const { roles, session } = await requireUser();
  const mine = INITIATOR_ROLES.filter((r) => roles.includes(r));
  if (!mine.length) redirect("/forbidden");
  const def = isInitiatorRole(session.activeRole) ? session.activeRole : mine[0];
  return (
    <>
      <PageHeader eyebrow="Work" title="Initiate New Request" intro="Start by selecting the applicant type. Your draft is saved on the server and stays available after you sign in again." />
      <div className="card" style={{ maxWidth: 760 }}>
        <NewRequestForm roles={mine.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} defaultRole={def} />
      </div>
    </>
  );
}
