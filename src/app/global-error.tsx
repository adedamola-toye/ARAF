"use client";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en-NG">
      <body style={{ fontFamily: "'Century Gothic', 'Avenir Next', Futura, system-ui, sans-serif", margin: 0, background: "#1C1D20", color: "#F5F4EF" }}>
        <header style={{ padding: "22px 24px", fontWeight: 700, fontSize: 28, letterSpacing: "-0.06em" }}>
          AltBank Retail Asset Factory
        </header>
        <main style={{ padding: 32, maxWidth: 560 }}>
          <h1>Something went wrong</h1>
          <p>The application hit an unexpected error. Please reload the page.</p>
          {error.digest && <p>Reference: {error.digest}</p>}
          <a style={{ color: "#FFC900" }} href="/queue">Return to My Action Queue</a>
        </main>
        <footer style={{ padding: "14px 24px", color: "#a6a7ad", fontSize: 13 }}>Powered by DKTA Technologies @2026</footer>
      </body>
    </html>
  );
}
