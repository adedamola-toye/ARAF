import "server-only";
import { unstable_rethrow } from "next/navigation";
import { DomainError } from "@/server/errors";
import { reportForCurrentUser } from "@/server/incidents/subject";
import type { IncidentView } from "@/lib/incident-messages";

export interface ActionState {
  ok?: boolean;
  error?: string | null;
  fields?: Record<string, string>;
  message?: string | null;
  data?: unknown;
  nonce?: number;
  /** A genuine technical failure: the shared incident and this user's assigned message. */
  incident?: IncidentView & { retry: boolean };
}

/**
 * Expected domain errors (validation, permissions, business rules, conflicts) become ordinary form
 * messages. Next.js control flow (redirect, notFound) is rethrown. Anything else is a technical failure:
 * it is recorded as an incident and the form shows the incident panel, keeping the user's entries.
 * Server actions do their writes in one database transaction, which has rolled back by the time the error
 * reaches here, so resubmitting (with the same idempotency key) is safe.
 */
export async function toActionError(e: unknown): Promise<ActionState> {
  if (e instanceof DomainError) return { ok: false, error: e.message, fields: e.fields, nonce: Date.now() };
  unstable_rethrow(e);
  const view = await reportForCurrentUser({ source: "action", error: e });
  return {
    ok: false,
    error: view.ref ? `A technical problem stopped this (reference ${view.ref}). Your entries are kept; try again shortly.` : "A technical problem stopped this. Your entries are kept; try again shortly.",
    incident: { ...view, retry: true },
    nonce: Date.now(),
  };
}
