"use client";
import Link from "next/link";
import { AuthScene } from "@/components/Brand";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <AuthScene>
      <h1 className="auth-h1-sm">Something went wrong</h1>
      <p className="lede" role="alert">The request could not be completed and no partial changes were saved.{error.digest ? ` Reference: ${error.digest}.` : ""}</p>
      <div className="auth-form">
        <button className="auth-continue" onClick={() => reset()}>
          Try again <span aria-hidden="true">↗</span>
        </button>
        <p className="auth-feedback">
          <Link href="/queue">Go to My Action Queue</Link>
        </p>
      </div>
    </AuthScene>
  );
}
