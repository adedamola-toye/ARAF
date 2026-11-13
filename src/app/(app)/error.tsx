"use client";
import { useRouter } from "next/navigation";
import { startTransition } from "react";
import { IncidentScreen } from "@/components/Incident";

/** Crashed page inside the signed-in shell: navigation stays available around the incident screen. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  return (
    <IncidentScreen
      error={error}
      reset={() =>
        startTransition(() => {
          router.refresh(); // re-fetch the server-rendered page, then re-render the boundary
          reset();
        })
      }
    />
  );
}
