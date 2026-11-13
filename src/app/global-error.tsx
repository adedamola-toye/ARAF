"use client";
import { IncidentScreen } from "@/components/Incident";

/* Last-resort error page. It replaces the root layout, so it carries its own tokens: the V39 light and
   dark palettes, following the operating system, with the self-hosted fonts. */
const CSS = `
@font-face{font-family:'Nunito Sans';src:url(/fonts/nunito-sans-latin.woff2) format('woff2');font-weight:400 900;font-display:swap}
@font-face{font-family:'DM Sans';src:url(/fonts/dm-sans-latin.woff2) format('woff2');font-weight:400 700;font-display:swap}
:root{color-scheme:light dark;--font:'DM Sans',system-ui,sans-serif;--font-display:'Nunito Sans',system-ui,sans-serif;
  --bg:#F7F9FF;--surface:#fff;--surface-2:#F7F9FF;--ink:#152B59;--ink-2:#3B4A66;--muted:#64718C;--line:#DEE5F3;--line-strong:#C9D3E6;
  --brand:#153FAF;--brand-ink:#fff;--accent-soft:#EAF0FF;--focus:#153FAF}
@media(prefers-color-scheme:dark){:root{--bg:#101820;--surface:#16212B;--surface-2:#1B2833;--ink:#F5F7FA;--ink-2:#D5DDE5;--muted:#C1CBD5;--line:#2A3946;--line-strong:#354553;
  --brand:#9DBBFF;--brand-ink:#0B1530;--accent-soft:#1E2F4A;--focus:#9DBBFF}}
body{margin:0;font-family:var(--font);background:var(--bg);color:var(--ink)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 18px;border-radius:10px;border:1px solid var(--line);background:var(--surface);color:var(--ink);font:inherit;font-weight:700;font-size:14px;text-decoration:none;cursor:pointer}
.btn-primary{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}
`;

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en-NG">
      <body>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <main id="main">
          <IncidentScreen error={error} reset={() => location.reload()} />
        </main>
      </body>
    </html>
  );
}
