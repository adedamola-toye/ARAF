import type { Instrumentation } from "next";

export function register() {}

/**
 * Every server-side failure (page render, route handler, server action that throws past its handler)
 * is recorded as an incident against its error digest, so the error screen can show the shared reference.
 * Recording never throws. Node.js runtime only (the incident service needs the database).
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { recordRequestError } = await import("./server/incidents/hook");
    await recordRequestError(err, request.path, context.routeType);
  }
};
