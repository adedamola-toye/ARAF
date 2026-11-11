"use client";

/* Last-resort error page. It replaces the root layout, so its styles are inline: the V39 light and
   dark palettes, following the operating system, with the self-hosted fonts. */
const CSS = `
@font-face{font-family:'Nunito Sans';src:url(/fonts/nunito-sans-latin.woff2) format('woff2');font-weight:400 900;font-display:swap}
@font-face{font-family:'DM Sans';src:url(/fonts/dm-sans-latin.woff2) format('woff2');font-weight:400 700;font-display:swap}
:root{color-scheme:light dark}
body{margin:0;font-family:'DM Sans',system-ui,sans-serif;background:#F7F9FF;color:#152B59}
.w{max-width:1240px;margin:0 auto;padding:0 clamp(18px,4vw,52px)}
header{min-height:96px;display:flex;align-items:center;justify-content:space-between;gap:24px;border-bottom:1px solid #DEE5F3}
.t{margin:0;font-family:'Nunito Sans',system-ui,sans-serif;font-size:23px;font-weight:900;letter-spacing:-.065em}
.s,.m,footer{color:#64718C}.s{margin:7px 0 0;font-size:11px}
img{width:150px;height:62px;object-fit:contain}
main{padding:65px 0 78px;max-width:560px}
h1{font-family:'Nunito Sans',system-ui,sans-serif;font-size:42px;font-weight:900;letter-spacing:-.05em;margin:0 0 16px}
.m{line-height:1.7}a{color:#153FAF;font-weight:600}
footer{border-top:1px solid #DEE5F3;padding:22px 0;font-size:12px}footer p{margin:0 0 4px}
@media(prefers-color-scheme:dark){body{background:#101820;color:#F5F7FA}header,footer{border-color:#354553}.s,.m,footer{color:#C1CBD5}a{color:#9DBBFF}img{background:#fff;border-radius:8px;padding:5px}}
`;

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en-NG">
      <body>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="w">
          <header>
            <div>
              <p className="t">Retail Asset Factory</p>
              <p className="s">A Payments and Collections Product</p>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/landing/alternative-bank-logo.webp" alt="The Alternative Bank" />
          </header>
          <main id="main">
            <h1>Something went wrong</h1>
            <p className="m">The application hit an unexpected error. Please reload the page.</p>
            {error.digest && <p className="m">Reference: {error.digest}</p>}
            <a href="/queue">Return to My Action Queue</a>
          </main>
          <footer>
            <p>A platform by The Alternative Bank.</p>
            <p>Internal use only</p>
          </footer>
        </div>
      </body>
    </html>
  );
}
