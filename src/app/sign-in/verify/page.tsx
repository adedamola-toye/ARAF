import Link from "next/link";
import { AuthScene } from "@/components/Brand";
import { config } from "@/server/config";
import { maskEmail } from "@/server/mask";
import { safeNext } from "@/lib/paths";
import { readPending } from "../actions";
import { VerifyForm } from "./VerifyForm";
import { themePreference } from "../../_lib/theme";

export const metadata = { title: "Enter code" };

export default async function Verify({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const pending = await readPending();
  return (
    <AuthScene theme={await themePreference()}>
      <h1 className="auth-h1-sm">Check your email</h1>
      {pending ? (
        <>
          <p className="lede">
            If {maskEmail(pending.email)} belongs to provisioned staff, we sent it a 6-digit code. It works once.
          </p>
          <VerifyForm next={next} as={pending.as} expiresAt={pending.at + config.otpTtlSeconds * 1000} ttlMs={config.otpTtlSeconds * 1000} />
        </>
      ) : (
        <>
          <p className="lede">This sign-in attempt has expired.</p>
          <p className="auth-feedback">
            <Link href={`/sign-in?next=${encodeURIComponent(next)}`}>Start again with your work email</Link>
          </p>
        </>
      )}
    </AuthScene>
  );
}
