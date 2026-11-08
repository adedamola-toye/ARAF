/**
 * Money is held as integer kobo (1 NGN = 100 kobo). Amounts in this domain are at most
 * ₦50,000,000 = 5e9 kobo, well within Number.MAX_SAFE_INTEGER; multiplications use BigInt.
 */
export const KOBO_PER_NAIRA = 100;
export const NAIRA = (n: number) => n * KOBO_PER_NAIRA;

/** Parse a user entered naira amount ("5,000,000.50", "₦1 200") into kobo. Rejects >2 decimals. */
export function parseNairaToKobo(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input).replace(/[₦,\s]/g, "").trim();
  if (!s) return null;
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const kobo = BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  if (kobo > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(kobo);
}

export function formatKobo(kobo: number | string | bigint | null | undefined, withSymbol = true): string {
  if (kobo === null || kobo === undefined || kobo === "") return "—";
  const k = BigInt(kobo);
  const neg = k < 0n;
  const abs = neg ? -k : k;
  const naira = abs / 100n;
  const rem = (abs % 100n).toString().padStart(2, "0");
  const grouped = naira.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${withSymbol ? "₦" : ""}${grouped}.${rem}`;
}

export function koboToNairaString(kobo: number): string {
  return formatKobo(kobo, false).replace(/,/g, "");
}

/** amount * basisPoints / 10000, rounded half-up, exact integer arithmetic. */
export function applyBasisPoints(kobo: number, bp: number): number {
  const num = BigInt(kobo) * BigInt(bp);
  return Number((num + 5000n) / 10000n);
}

/** Parse a percentage like "12.5" into basis points (1250). Max 4 decimal places -> rounded to bp. */
export function parsePercentToBp(input: string | number): number | null {
  const s = String(input).trim();
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  const fourDp = BigInt(i) * 10000n + BigInt(f.padEnd(4, "0"));
  // basis points = percent * 100 => fourDp / 100
  return Number((fourDp + 50n) / 100n);
}
