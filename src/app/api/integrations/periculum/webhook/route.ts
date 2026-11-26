import { NextResponse, type NextRequest } from "next/server";
import { handlePericulumWebhook } from "@/server/domain/statement-analysis";

/**
 * Periculum Insights webhook. Deliveries are de-duplicated and the HMAC-SHA512 signature is recorded; a delivery
 * only brings the next status check forward — ARAF re-reads the statement from Periculum's API before storing
 * anything. Responds quickly.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > 2 * 1024 * 1024) return NextResponse.json({ ok: false }, { status: 413 });
  const r = await handlePericulumWebhook(raw);
  return NextResponse.json({ ok: r.accepted }, { status: r.accepted ? 200 : 400 });
}
