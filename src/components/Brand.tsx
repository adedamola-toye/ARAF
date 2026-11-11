import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";

/**
 * Text wordmark for the AltBank Retail Asset Factory. Replace with the approved logo asset when
 * supplied; keep the accessible name.
 */
export function Wordmark({ href = "/", app = false }: { href?: string; app?: boolean }) {
  return (
    <Link href={href} className="wordmark" aria-label="AltBank Retail Asset Factory home">
      <span className="wordmark-text">AltBank</span>
      {app && <span className="wordmark-app">Retail Asset Factory</span>}
    </Link>
  );
}

export const FOOTER_TEXT = "Powered by DKTA Technologies @2026";

export function Footer({ className = "footer" }: { className?: string }) {
  return (
    <footer className={className}>
      <span>AltBank Retail Asset Factory · Internal use only</span>
      <span>{FOOTER_TEXT}</span>
    </footer>
  );
}

/**
 * Authentication scene from the accepted landing reference: full-bleed merchant photograph (retained
 * existing visual asset, stored locally; usage rights to be confirmed) blended into graphite (dark) or
 * warm off-white (light). Used for sign-in, OTP, session-expired and error screens.
 */
export function AuthScene({ children, theme }: { children: React.ReactNode; theme: "light" | "dark" }) {
  return (
    <section className="auth" aria-label="AltBank Retail Asset Factory staff sign-in">
      <figure className="auth-photo" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/wakeel-merchant-1080.jpg"
          srcSet="/images/wakeel-merchant-640.jpg 640w, /images/wakeel-merchant-1080.jpg 1080w"
          sizes="(max-width: 670px) 100vw, 76vw"
          alt=""
          fetchPriority="high"
        />
      </figure>
      <header className="auth-header">
        <Wordmark href="/sign-in" />
        <ThemeToggle initial={theme} variant="pill" />
      </header>
      <main className="auth-main" id="main">
        {children}
      </main>
      <footer className="auth-footer">{FOOTER_TEXT}</footer>
    </section>
  );
}

/** Backwards-compatible frame used by error and access pages. */
export function AuthFrame({ children, theme = "dark" }: { children: React.ReactNode; theme?: "light" | "dark"; right?: React.ReactNode }) {
  return (
    <AuthScene theme={theme}>
      <div className="auth-card">{children}</div>
    </AuthScene>
  );
}

export function PlainFrame({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="plain-frame">
      <header>
        <Wordmark href="/sign-in" app />
        {right}
      </header>
      <main id="main">{children}</main>
      <Footer />
    </div>
  );
}
