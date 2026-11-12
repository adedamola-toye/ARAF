import { NextResponse, type NextRequest } from "next/server";
import { baseCtx } from "../../../../_lib/auth";
import { handlePaystackWebhook } from "@/server/altphones/origination";

/**
 * Paystack webhook. The signature (HMAC-SHA512 of the raw body with the secret key) is checked first;
 * events are de-duplicated and every payment or mandate is re-verified with Paystack's API before
 * anything changes. Responds 200 quickly for handled or ignored events.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > 256 * 1024) return NextResponse.json({ ok: false }, { status: 413 });
  const ctx = await baseCtx();
  const r = await handlePaystackWebhook(ctx, raw, req.headers.get("x-paystack-signature"));
  return NextResponse.json({ ok: r.status === 200, outcome: r.outcome }, { status: r.status });
}
