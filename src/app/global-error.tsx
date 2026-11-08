"use client";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en-NG">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#f5f4ef", color: "#161616" }}>
        <header style={{ background: "#1b1b1b", color: "#fff", padding: "16px 24px", borderBottom: "4px solid #ffc20e", fontWeight: 800 }}>
          WakeelBoost Work Desk
        </header>
        <main style={{ padding: 32, maxWidth: 560 }}>
          <h1>Something went wrong</h1>
          <p>The application hit an unexpected error. Please reload the page.</p>
          {error.digest && <p>Reference: {error.digest}</p>}
          <a href="/queue">Return to My Action Queue</a>
        </main>
        <footer style={{ padding: "14px 24px", borderTop: "1px solid #ddd", fontSize: 13 }}>Powered by DKTA Technologies @2026</footer>
      </body>
    </html>
  );
}
