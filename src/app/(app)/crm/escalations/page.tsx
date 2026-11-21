import AllComplaints from "../all/page";

export const metadata = { title: "Escalations" };

/** CX Head: escalated complaints that are still open (same filters as All Complaints). */
export default async function Escalations({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return AllComplaints({ searchParams: Promise.resolve({ ...sp, escalated: "1" }) });
}
