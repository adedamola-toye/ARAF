import { AuthScene } from "@/components/Brand";
import { safeNext } from "@/lib/paths";
import { currentTheme } from "../_lib/theme";
import { EmailForm } from "./EmailForm";

export const metadata = { title: "Sign in" };

export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return (
    <AuthScene theme={await currentTheme()}>
      <h1>
        Retail Asset<span> Factory</span>
      </h1>
      <p className="lede">Initiate, appraise, approve and process retail financing: Vendor Financing, Alt Drive and Alt Power.</p>
      <p className="lede">
        For <strong>Relationship Managers</strong>, <strong>Delight Officers</strong> and the review, credit and operations teams.
      </p>
      <EmailForm as={sp.as ?? ""} next={safeNext(sp.next)} returning={!!sp.next && safeNext(sp.next) !== "/queue"} />
    </AuthScene>
  );
}
