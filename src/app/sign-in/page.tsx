import Link from "next/link";
import { AuthFrame } from "@/components/Brand";
import { ThemeToggle } from "@/components/ThemeToggle";
import { config } from "@/server/config";
import { safeNext } from "@/lib/paths";
import { EmailForm } from "./EmailForm";

export const metadata = { title: "Sign in" };

const CHOICES = [
  { as: "RM", title: "Relationship Manager", desc: "Initiate and track requests" },
  { as: "ANM", title: "Agent Network Manager", desc: "Initiate and track requests" },
  { as: "MERCHANT_OFFICER", title: "Merchant Officer", desc: "Initiate and track requests" },
];

export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const as = sp.as;
  const label = CHOICES.find((c) => c.as === as)?.title ?? (as === "STAFF" ? "Staff" : null);
  return (
    <AuthFrame right={<ThemeToggle initial={null} />}>
      <div className="card stack">
        <div>
          <h1>Sign in to WakeelBoost Work Desk</h1>
          <p className="muted">Alternative Bank staff only. A one-time code will be sent to your provisioned @{config.staffEmailDomain} email.</p>
        </div>
        {next !== "/queue" && <div className="alert alert-info">Sign in to continue to the requested case.</div>}
        {!label ? (
          <>
            <h2 className="small muted" style={{ textTransform: "uppercase", letterSpacing: 0.6, margin: 0 }}>
              Initiators
            </h2>
            <div className="choice-grid">
              {CHOICES.map((c) => (
                <Link key={c.as} className="choice" href={`/sign-in?as=${c.as}&next=${encodeURIComponent(next)}`}>
                  <strong>{c.title}</strong>
                  <span>{c.desc}</span>
                </Link>
              ))}
            </div>
            <Link className="btn btn-dark btn-block" href={`/sign-in?as=STAFF&next=${encodeURIComponent(next)}`}>
              Staff sign-in (credit, approvals, disbursement, admin)
            </Link>
            <p className="small muted" style={{ margin: 0 }}>
              Your access is determined by your active role assignments. Choosing a sign-in option does not grant permissions.
            </p>
          </>
        ) : (
          <>
            <div className="row">
              <span className="badge badge-yellow">{label} sign-in</span>
              <Link className="small" href={`/sign-in?next=${encodeURIComponent(next)}`}>
                Change
              </Link>
            </div>
            <EmailForm as={as!} next={next} />
          </>
        )}
        {!config.isProduction && (
          <p className="small muted" style={{ margin: 0 }}>
            Development environment: codes are delivered to the <Link href="/dev/mailbox">development mailbox</Link>.
          </p>
        )}
      </div>
    </AuthFrame>
  );
}
