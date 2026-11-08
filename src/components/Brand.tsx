import Link from "next/link";

/**
 * Text wordmark. Replace with the approved Wakeel / AltBank logo asset when supplied
 * (keep the accessible name "WakeelBoost Work Desk").
 */
export function Wordmark({ href = "/", compact = false }: { href?: string; compact?: boolean }) {
  return (
    <Link href={href} className="wordmark" aria-label="WakeelBoost Work Desk home">
      <span className="wordmark-badge" aria-hidden="true">W</span>
      {!compact && (
        <span className="wordmark-text">
          <strong>WakeelBoost</strong>
          <span>Work Desk</span>
        </span>
      )}
    </Link>
  );
}

export const FOOTER_TEXT = "Powered by DKTA Technologies @2026";

export function Footer({ className = "footer" }: { className?: string }) {
  return (
    <footer className={className}>
      <span>WakeelBoost Work Desk · Alternative Bank · Internal use only</span>
      <span>{FOOTER_TEXT}</span>
    </footer>
  );
}

/** Minimal branded frame for sign-in, expired-session and error screens. */
export function AuthFrame({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="auth-wrap">
      <header className="auth-top">
        <Wordmark href="/sign-in" />
        {right}
      </header>
      <main className="auth-main" id="main">
        <div className="auth-card">{children}</div>
      </main>
      <Footer />
    </div>
  );
}
