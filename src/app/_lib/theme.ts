import "server-only";
import { cookies } from "next/headers";

/** Theme: dark by default on first visit; the persisted preference (cookie) wins afterwards. */
export async function currentTheme(): Promise<"light" | "dark"> {
  return (await cookies()).get("wb-theme")?.value === "light" ? "light" : "dark";
}
