import Link from "next/link";
import { AuthScene } from "@/components/Brand";

export const metadata = { title: "Access denied" };

export default async function Forbidden() {
  return (
    <AuthScene>
      <h1 className="auth-h1-sm">Access denied</h1>
      <p className="lede" role="alert">Your current role assignments do not allow this page. Access comes from role assignments made by the Super Admin, not from the workspace you choose.</p>
      <div className="auth-form">
        <Link className="auth-continue" href="/queue" style={{ textDecoration: "none" }}>
          My Action Queue <span aria-hidden="true">↗</span>
        </Link>
      </div>
    </AuthScene>
  );
}
