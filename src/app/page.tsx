import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/server/auth/session";

export default async function Home() {
  const has = (await cookies()).get(SESSION_COOKIE);
  redirect(has ? "/queue" : "/sign-in");
}
