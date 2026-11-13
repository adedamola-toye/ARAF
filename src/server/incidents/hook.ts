import { recordFailure } from ".";

/** Server hook: record a request failure against its digest. Never throws. */
export async function recordRequestError(err: unknown, path: string, routeType: string): Promise<void> {
  const e = err as Error & { digest?: string };
  if (e?.name === "DomainError" || /^NEXT_/.test(String(e?.digest ?? ""))) return; // expected outcomes and Next control flow
  try {
    const source = routeType === "route" ? "api" : routeType === "action" ? "action" : "render";
    await recordFailure({ source, route: path, error: err, digest: e?.digest ?? null });
  } catch (x) {
    console.error(JSON.stringify({ event: "araf.incident.unrecorded", source: "server-hook", reason: (x as { code?: string }).code ?? "Error", at: new Date().toISOString() }));
  }
}
