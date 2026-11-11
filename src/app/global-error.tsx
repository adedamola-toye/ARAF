"use client";

/* Last-resort error page. It replaces the root layout, so styles are inline and follow the landing design. */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const muted = "#64718c";
  return (
    <html lang="en-NG">
      <body style={{ fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif", margin: 0, background: "#f7f9ff", color: "#152b59" }}>
        <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 clamp(18px, 4vw, 52px)" }}>
          <header style={{ minHeight: 102, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, borderBottom: "1px solid #dee5f3" }}>
            <div>
              <p style={{ margin: 0, fontSize: 23, fontWeight: 720, letterSpacing: -0.85 }}>Retail Asset Factory</p>
              <p style={{ margin: "7px 0 0", fontSize: 11, color: muted }}>A Payments and Collections Product</p>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/landing/alternative-bank-logo.webp" alt="The Alternative Bank" width={178} height={80} style={{ objectFit: "contain" }} />
          </header>
          <main style={{ padding: "65px 0 78px", maxWidth: 560 }}>
            <h1 style={{ fontSize: 40, fontWeight: 690, letterSpacing: -1.6, margin: "0 0 18px" }}>Something went wrong</h1>
            <p style={{ color: muted, lineHeight: 1.75 }}>The application hit an unexpected error. Please reload the page.</p>
            {error.digest && <p style={{ color: muted }}>Reference: {error.digest}</p>}
            <a style={{ color: "#153faf" }} href="/queue">Return to My Action Queue</a>
          </main>
          <footer style={{ borderTop: "1px solid #dee5f3", padding: "22px 0", fontSize: 12, color: muted }}>
            <p style={{ margin: 0 }}>A platform by The Alternative Bank.</p>
            <p style={{ margin: "4px 0 0" }}>Internal use only</p>
          </footer>
        </div>
      </body>
    </html>
  );
}
