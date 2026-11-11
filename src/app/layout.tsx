import type { Metadata, Viewport } from "next";
import "./fonts.css";
import "./globals.css";
import { themePreference } from "./_lib/theme";
import { THEME_SCRIPT } from "@/lib/theme";

/* Approved typography (V39): Nunito Sans for headings and figures, DM Sans for everything else.
   Both are self-hosted from /public/fonts (see fonts.css), so production never calls Google. */
const FONT_PRELOADS = ["/fonts/dm-sans-latin.woff2", "/fonts/nunito-sans-latin.woff2"];

export const metadata: Metadata = {
  title: { default: "AltBank Retail Asset Factory", template: "%s · AltBank Retail Asset Factory" },
  description: "Internal Alternative Bank platform for initiating, appraising, reviewing, approving and processing retail financing applications.",
  robots: { index: false, follow: false },
  icons: { icon: "/icon.svg" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F7F9FF" },
    { media: "(prefers-color-scheme: dark)", color: "#101820" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pref = await themePreference();
  return (
    <html
      lang="en-NG"
      data-theme-preference={pref}
      data-theme={pref === "system" ? undefined : pref}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {FONT_PRELOADS.map((href) => (
          <link key={href} rel="preload" href={href} as="font" type="font/woff2" crossOrigin="anonymous" />
        ))}
      </head>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
