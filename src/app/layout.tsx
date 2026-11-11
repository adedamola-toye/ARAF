import type { Metadata, Viewport } from "next";
import "./globals.css";
import { currentTheme } from "./_lib/theme";

export const metadata: Metadata = {
  title: { default: "AltBank Retail Asset Factory", template: "%s · AltBank Retail Asset Factory" },
  description: "Internal Alternative Bank platform for initiating, appraising, reviewing, approving and processing retail financing applications.",
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
