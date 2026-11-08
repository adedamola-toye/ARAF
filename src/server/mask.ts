/** Masking helpers for sensitive identifiers shown in lists, exports, notifications and audit. */
export function last4(value: string): string {
  const digits = value.replace(/\s+/g, "");
  return digits.slice(-4);
}
export function maskWithLast4(l4: string | null | undefined, totalLen = 11): string {
  if (!l4) return "—";
  return "•".repeat(Math.max(0, totalLen - l4.length)) + l4;
}
export function maskEmail(email: string): string {
  const [u, d] = email.split("@");
  if (!d) return "•••";
  return `${u.slice(0, 2)}•••@${d}`;
}

const SENSITIVE_KEY = /(bvn|tin|otp|code|token|secret|password|pass|cookie|authorization)/i;
/** Removes or masks sensitive keys from an arbitrary payload before it is written to the audit log. */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => sanitizeForAudit(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/last4$/i.test(k)) {
        out[k] = v;
      } else if (SENSITIVE_KEY.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = sanitizeForAudit(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "string" && /\b\d{11}\b/.test(value)) {
    // Looks like a BVN / phone sized number - mask all but last 4.
    return value.replace(/\b(\d{7})(\d{4})\b/g, "•••••••$2");
  }
  return value;
}
