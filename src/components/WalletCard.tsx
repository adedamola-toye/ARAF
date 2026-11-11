import Link from "next/link";
import { Wallet } from "lucide-react";
import { formatKobo } from "@/server/money";

/** Prominent RM balance: total financing requested (submitted) today, Lagos time. */
export function WalletCard({ totalKobo, count, day }: { totalKobo: string; count: number; day: string }) {
  return (
    <section className="wallet" aria-labelledby="wallet-title">
      <div className="wallet-main">
        <span id="wallet-title" className="wallet-label">
          <Wallet className="icon" aria-hidden="true" /> Total Requested Today
        </span>
        <strong className="wallet-amount tnum">{formatKobo(totalKobo)}</strong>
        <span className="small">
          {count} submitted application{count === 1 ? "" : "s"} · {day} (Lagos) · requested amounts only; approvals and disbursements are tracked separately
        </span>
      </div>
      <div className="wallet-actions">
        <Link className="btn btn-sm" href={`/wallet?day=${day}`}>
          View breakdown
        </Link>
        <Link className="btn btn-sm btn-ghost" href="/wallet?view=month">
          View Monthly Requested Total
        </Link>
      </div>
    </section>
  );
}
