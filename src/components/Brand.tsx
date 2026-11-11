import Link from "next/link";
/* eslint-disable @next/next/no-img-element */
import s from "@/app/landing.module.css";

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

export const FOOTER_TEXT = "A platform by The Alternative Bank.";

export function Footer({ className = "footer" }: { className?: string }) {
  return (
    <footer className={className}>
      <span>{FOOTER_TEXT}</span>
      <span>Internal use only</span>
    </footer>
  );
}

/**
 * Authentication scene for sign-in, OTP, session-ended and error screens. It uses the approved
 * landing-page design (landing.module.css): the same header, light palette, family photograph
 * panel and footer with The Alternative Bank and NIFI logos (usage rights confirmed).
 */
export function AuthScene({ children }: { children: React.ReactNode; theme?: "light" | "dark" }) {
  return (
    <div className={`${s.page} auth`}>
      <div className={s.shell}>
        <header className={s.header}>
          <Link href="/" className={s.brand} aria-label="Retail Asset Factory home">
            <p className={s.brandTitle}>Retail Asset Factory</p>
            <p>A Payments and Collections Product</p>
          </Link>
          <img className={s.bankLogo} src="/images/landing/alternative-bank-logo.webp" alt="The Alternative Bank" width={460} height={231} decoding="async" />
        </header>
        <main className={s.main} id="main">
          <div className={`${s.hero} ${s.authHero}`}>
            <div className={`${s.intro} auth-main`}>{children}</div>
            <div className={s.photo}>
              <img src="/images/landing/family.webp" alt="A smiling family at home" width={760} height={876} fetchPriority="high" />
            </div>
          </div>
          <p className={s.accessNote}>Authorised staff only. Available actions are determined by your assigned role.</p>
        </main>
        <footer className={s.footer}>
          <div className={s.footerCopy}>
            <p>A platform by The Alternative Bank.</p>
            <p>Internal use only</p>
          </div>
          <div className={s.footerLogos}>
            <img className={s.footerBankLogo} src="/images/landing/alternative-bank-logo.webp" alt="The Alternative Bank" width={460} height={231} loading="lazy" />
            <img className={s.footerNifiLogo} src="/images/landing/nifi-logo.png" alt="NIFI" width={210} height={165} loading="lazy" />
          </div>
        </footer>
      </div>
    </div>
  );
}

/** Backwards-compatible frame used by error and access pages. */
export function AuthFrame({ children }: { children: React.ReactNode; theme?: "light" | "dark"; right?: React.ReactNode }) {
  return (
    <AuthScene>
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
