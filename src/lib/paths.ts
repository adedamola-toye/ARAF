/**
 * Validate a post-login redirect target ("deep link"). Only same-origin relative application
 * paths are allowed, preventing open redirects through the `next` parameter.
 */
export function safeNext(next: string | null | undefined, fallback = "/queue"): string {
  if (!next || typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(next) || next.length > 500) return fallback;
  if (/^\/(api|_next|sign-in|session-expired)(\/|$|\?)/.test(next)) return fallback;
  return next;
}
