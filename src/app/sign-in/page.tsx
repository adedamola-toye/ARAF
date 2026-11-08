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
        Wakeel<span>Boost</span>
        <br />
        Work Desk
      </h1>
      <p className="lede">Stock financing for Wakeel merchants.</p>
      <EmailForm as={sp.as ?? ""} next={safeNext(sp.next)} returning={!!sp.next && safeNext(sp.next) !== "/queue"} />
    </AuthScene>
  );
}
