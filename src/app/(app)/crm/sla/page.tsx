import AllComplaints from "../all/page";

export const metadata = { title: "SLA Monitoring" };

/** CX Head: open complaints past their resolution target (same filters as All Complaints). */
export default async function SlaMonitoring({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return AllComplaints({ searchParams: Promise.resolve({ ...sp, overdue: "1" }) });
}
