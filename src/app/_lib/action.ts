import "server-only";
import { DomainError } from "@/server/errors";

export interface ActionState {
  ok?: boolean;
  error?: string | null;
  fields?: Record<string, string>;
  message?: string | null;
  data?: unknown;
  nonce?: number;
}

/** Convert expected domain errors into form state; rethrow unexpected errors (and Next redirects). */
export function toActionError(e: unknown): ActionState {
  if (e instanceof DomainError) return { ok: false, error: e.message, fields: e.fields, nonce: Date.now() };
  throw e;
}
