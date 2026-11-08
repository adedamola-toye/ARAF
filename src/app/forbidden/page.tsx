import Link from "next/link";
import { AuthFrame } from "@/components/Brand";

export default function Forbidden() {
  return (
    <AuthFrame>
      <div className="card" role="alert">
        <h1>Access denied</h1>
        <p className="muted">Your current role assignments do not allow access to this page. Access is granted by the Super Admin through role assignments, not by workspace selection.</p>
        <Link className="btn btn-primary" href="/queue">
          My Action Queue
        </Link>
      </div>
    </AuthFrame>
  );
}
