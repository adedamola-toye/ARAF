/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import s from "@/app/landing.module.css";
import { AppearanceMenu } from "./Appearance";
import type { ThemePreference } from "@/lib/theme";

/** Class names for the V39 footer appearance control (landing page and sign-in screens). */
export const appearanceClasses = {
  menu: s["appearance-menu"],
  panel: s["appearance-panel"],
  caption: s["appearance-caption"],
  switcher: s["theme-switcher"],
  option: s["theme-option"],
};

/** Product lockup used in the signed-in application (same name and subtitle as the landing header). */
export function Wordmark({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="wordmark" aria-label="Retail Asset Factory home">
      <span className="wordmark-text">Retail Asset Factory</span>
      <span className="wordmark-app">A Payments and Collections Product</span>
    </Link>
  );
}

/**
 * The Alternative Bank logo on a transparent background (V40). Both variants are rendered and CSS in
 * globals.css shows the one matching html[data-theme], which the existing theme script sets before first
 * paint and updates on every Light / Dark / System change.
 */
export function BankLogo({ className, lazy }: { className?: string; lazy?: boolean }) {
  const common = { width: 460, height: 231, decoding: "async" as const, loading: lazy ? ("lazy" as const) : undefined };
  return (
    <>
      <img alt="The Alternative Bank" {...common} className={`${className ?? ""} logo-on-light`} src="/images/landing/alternative-bank-logo-light.png" />
      <img alt="The Alternative Bank" {...common} className={`${className ?? ""} logo-on-dark`} src="/images/landing/alternative-bank-logo-dark.png" />
    </>
  );
}

export function BankMark() {
  return <BankLogo className="bank-mark" />;
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
 * Sign-in, code entry, session ended, access denied, not found and error screens. They use the
 * approved landing layout (V39): header with the bank logo, hero with the family photograph, the
 * access note and the footer with the bank and NIFI logos and the Appearance control.
 */
export function AuthScene({ children, theme = "system" }: { children: React.ReactNode; theme?: ThemePreference }) {
  return (
    <div className={`${s.page} auth`}>
      <div className={s.shell}>
        <header>
          <Link href="/" className={s.brand} aria-label="Retail Asset Factory home">
            <p className={s["brand-title"]}>Retail Asset Factory</p>
            <p>A Payments and Collections Product</p>
          </Link>
          <div className={s["header-actions"]}>
            <BankLogo className={s["bank-logo"]} />
          </div>
        </header>
        <main id="main">
          <div className={`${s.hero} auth-hero`}>
            <div className={`${s.intro} auth-main`}>{children}</div>
            <div className={s.photo}>
              <img alt="Family portrait" src="/images/landing/family.webp" width={760} height={876} fetchPriority="high" />
            </div>
          </div>
          <p className={s["access-note"]}>Authorised staff only. Available actions are determined by your assigned role.</p>
        </main>
        <footer>
          <div className={s["footer-copy"]}>
            <p>A platform by The Alternative Bank.</p>
            <p>Internal use only</p>
          </div>
          <div className={s["footer-logos"]}>
            <BankLogo className={s["footer-bank-logo"]} lazy />
            <img alt="NIFI" className={s["footer-nifi-logo"]} src="/images/landing/nifi-logo.png" width={210} height={165} loading="lazy" />
          </div>
          <AppearanceMenu initial={theme} classes={appearanceClasses} />
        </footer>
      </div>
    </div>
  );
}

/** Backwards-compatible frame used by error and access pages. */
export function AuthFrame({ children }: { children: React.ReactNode; right?: React.ReactNode }) {
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
        <Wordmark href="/sign-in" />
        {right}
      </header>
      <main id="main">{children}</main>
      <Footer />
    </div>
  );
}
