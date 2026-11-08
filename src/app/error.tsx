"use client";
import Link from "next/link";
import { AuthFrame } from "@/components/Brand";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <AuthFrame>
      <div className="card" role="alert">
        <h1>Something went wrong</h1>
        <p className="muted">The request could not be completed. No partial changes were saved. If this keeps happening, share the reference below with support.</p>
        {error.digest && (
          <p className="small">
            Reference: <code>{error.digest}</code>
          </p>
        )}
        <div className="row">
          <button className="btn btn-primary" onClick={() => reset()}>
            Try again
          </button>
          <Link className="btn" href="/queue">
            My Action Queue
          </Link>
        </div>
      </div>
    </AuthFrame>
  );
}
