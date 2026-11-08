import Link from "next/link";
import { AuthFrame } from "@/components/Brand";

export default function NotFound() {
  return (
    <AuthFrame>
      <div className="card">
        <h1>Page not found</h1>
        <p className="muted">The page you requested does not exist or you do not have access to it.</p>
        <Link className="btn btn-primary" href="/queue">
          Go to My Action Queue
        </Link>
      </div>
    </AuthFrame>
  );
}
