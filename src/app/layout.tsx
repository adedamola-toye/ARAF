import type { Metadata, Viewport } from "next";
import "./globals.css";
import { currentTheme } from "./_lib/theme";

export const metadata: Metadata = {
  title: { default: "WakeelBoost Work Desk", template: "%s · WakeelBoost Work Desk" },
  description: "Stock financing for Wakeel merchants. Internal Alternative Bank workbench.",
  robots: { index: false, follow: false },
  icons: { icon: "/icon.svg" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1C1D20" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = await currentTheme();
  return (
    <html lang="en-NG" data-theme={theme}>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
