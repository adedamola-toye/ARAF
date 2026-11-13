import Link from "next/link";
import { Lock } from "lucide-react";

/** Shown in place of a product the user's verified profile does not authorise. Creates nothing. */
export function AccessRestricted({ product, dashboardHref }: { product: string; dashboardHref: string }) {
  return (
    <div className="restricted-wrap">
      <section className="card restricted" role="alert" aria-labelledby="restricted-h">
        <span className="restricted-mark" aria-hidden="true">
          <Lock className="icon" />
        </span>
        <h1 id="restricted-h">Access Restricted</h1>
        <p>Your current profile does not authorise you to access {product}. Please contact your administrator if you believe your access should be reviewed.</p>
        <div className="restricted-actions">
          <Link className="btn btn-primary" href={dashboardHref}>
            Return to Dashboard
          </Link>
        </div>
      </section>
    </div>
  );
}
