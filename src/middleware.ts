import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge middleware: assigns a request correlation id and exposes the request path to server
 * components (for post-login deep links). Authentication is enforced server-side in every page,
 * action and route handler against the database session.
 */
export function middleware(req: NextRequest) {
  const headers = new Headers(req.headers);
  const incoming = req.headers.get("x-correlation-id");
  const correlationId = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  headers.set("x-correlation-id", correlationId);
  headers.set("x-pathname", req.nextUrl.pathname + req.nextUrl.search);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-correlation-id", correlationId);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
