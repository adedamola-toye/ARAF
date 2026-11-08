import Link from "next/link";
import { AuthScene } from "@/components/Brand";
import { currentTheme } from "./_lib/theme";

export default async function NotFound() {
  return (
    <AuthScene theme={await currentTheme()}>
      <h1 className="auth-h1-sm">Page not found</h1>
      <p className="lede">The page does not exist, or you do not have access to it.</p>
      <div className="auth-form">
        <Link className="auth-continue" href="/queue" style={{ textDecoration: "none" }}>
          My Action Queue <span aria-hidden="true">↗</span>
        </Link>
      </div>
    </AuthScene>
  );
}
