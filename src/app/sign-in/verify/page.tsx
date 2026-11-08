import Link from "next/link";
import { AuthFrame } from "@/components/Brand";
import { config } from "@/server/config";
import { safeNext } from "@/lib/paths";
import { VerifyForm } from "./VerifyForm";

export const metadata = { title: "Enter code" };

export default async function Verify({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  return (
    <AuthFrame>
      <div className="card stack">
        <h1>Enter your one-time code</h1>
        <p className="muted" style={{ margin: 0 }}>
          If your email is provisioned, a 6-digit code was sent to it. The code expires in {Math.round(config.otpTtlSeconds / 60)} minutes and can be used once.
        </p>
        <VerifyForm next={next} />
        <p className="small" style={{ margin: 0 }}>
          <Link href={`/sign-in?as=${encodeURIComponent(sp.as ?? "STAFF")}&next=${encodeURIComponent(next)}`}>Request a new code</Link>
          {!config.isProduction && (
            <>
              {" · "}
              <Link href="/dev/mailbox" target="_blank">
                Open development mailbox
              </Link>
            </>
          )}
        </p>
      </div>
    </AuthFrame>
  );
}
