"use client";
import { IncidentScreen } from "@/components/Incident";

/** Crashed page outside the signed-in shell (sign-in, landing): the incident experience. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="inc-root">
      <IncidentScreen error={error} reset={reset} />
    </main>
  );
}
