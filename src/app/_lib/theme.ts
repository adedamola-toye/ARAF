import "server-only";
import { cookies } from "next/headers";
import { THEME_COOKIE, parsePreference, type ThemePreference } from "@/lib/theme";

/**
 * The saved appearance preference (Light, Dark or System). System is the default, as in the
 * approved V39 design. A legacy light/dark cookie from the previous theme toggle is honoured.
 */
export async function themePreference(): Promise<ThemePreference> {
  const jar = await cookies();
  return parsePreference(jar.get(THEME_COOKIE)?.value ?? jar.get("wb-theme")?.value);
}
