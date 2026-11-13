import { randomUUID } from "node:crypto";
import { config } from "./config";

export interface Actor {
  staffId: string;
  email: string;
  name: string;
  sessionId?: string | null;
  activeRole?: string | null;
}

/** Request context passed to every domain operation. */
export interface Ctx {
  actor: Actor | null;
  now: Date;
  correlationId: string;
  ip: string | null;
  userAgent: string | null;
  /** Set only by systemCtx(): a background job, not a person. Never derived from a request. */
  system?: true;
}

export function systemCtx(now = new Date()): Ctx {
  return { actor: null, now, correlationId: `job-${randomUUID()}`, ip: null, userAgent: "system/worker", system: true };
}

/**
 * Determine the client IP from X-Forwarded-For using the trusted proxy hop count.
 * With N trusted proxies in front of the app, the client is the (N+1)th entry from the right
 * (the Next.js server itself appends the socket address as the right-most entry).
 */
export function clientIpFromHeaders(get: (name: string) => string | null, hops = config.trustedProxyHops): string | null {
  const xff = get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const idx = parts.length - 1 - hops;
    const ip = parts[Math.max(0, idx)];
    if (ip) return normaliseIp(ip);
  }
  const real = get("x-real-ip");
  return real ? normaliseIp(real) : null;
}
function normaliseIp(ip: string): string {
  return ip.replace(/^::ffff:/, "");
}

/** Very small UA summariser: "Chrome 130 on Windows (desktop)". */
export function describeDevice(ua: string | null | undefined): string | null {
  if (!ua) return null;
  if (ua.startsWith("system/")) return "system";
  const browser =
    match(ua, /Edg\/(\d+)/, "Edge") ??
    match(ua, /OPR\/(\d+)/, "Opera") ??
    match(ua, /Firefox\/(\d+)/, "Firefox") ??
    match(ua, /Chrome\/(\d+)/, "Chrome") ??
    match(ua, /Version\/(\d+).*Safari/, "Safari") ??
    (/HeadlessChrome/.test(ua) ? "HeadlessChrome" : null) ??
    "Unknown browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iOS/.test(ua)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "Unknown OS";
  const form = /Mobile|iPhone|Android/.test(ua) ? "mobile" : /iPad|Tablet/.test(ua) ? "tablet" : "desktop";
  return `${browser} on ${os} (${form})`;
}
function match(ua: string, re: RegExp, name: string): string | null {
  const m = re.exec(ua);
  return m ? `${name} ${m[1]}` : null;
}
