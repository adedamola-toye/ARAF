import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "WakeelBoost Work Desk", template: "%s · WakeelBoost Work Desk" },
  description: "Internal Alternative Bank workbench for WakeelBoost merchant stock financing.",
  robots: { index: false, follow: false },
  icons: { icon: "/icon.svg" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = (await cookies()).get("wb-theme")?.value;
  const dataTheme = theme === "dark" || theme === "light" ? theme : undefined;
  return (
    <html lang="en-NG" data-theme={dataTheme}>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
