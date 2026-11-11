// Regenerates src/app/landing.module.css from the approved V39 reference.
// Usage: node scripts/port-v39-landing.mjs <v39.html with base64 images stripped or intact> src/app/landing.module.css
import fs from 'node:fs';
import postcss from 'postcss';
const [src, out] = process.argv.slice(2);
const html = fs.readFileSync(src, 'utf8');
const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);
const root = postcss.parse(blocks.join('\n'));
const G = (attr) => `:global(html${attr}) .page`;
function mapSelector(sel) {
  sel = sel.trim().replace(/#notice/g, '.notice');
  // theme state selectors -> attributes set by the app's single theme controller
  const theme = [
    [/^html\[data-theme="?dark"?\]/, G('[data-theme="dark"]')],
    [/^html\[data-theme="?light"?\]/, G('[data-theme="light"]')],
    // :not(#raf-has) keeps the ID-level specificity of V39's :has(#raf-…) selectors.
    [/^html:has\(#raf-dark:checked\)/, G('[data-theme-preference="dark"]:not(#raf-has)')],
    // V39 bug fix: the System rules must apply only when System resolves to dark.
    [/^html:has\(#raf-system:checked\)/, G('[data-theme-preference="system"][data-theme="dark"]:not(#raf-has)')],
  ];
  for (const [re, rep] of theme) if (re.test(sel)) {
    let rest = sel.replace(re, '').trim();
    rest = rest.replace(/^body\b\s*/, '');
    return rest ? `${rep} ${rest}` : rep;
  }
  if (/^(html|body|:root)$/.test(sel)) return '.page';
  if (sel === '*') return '.page *';
  sel = sel.replace(/#notice/g, '.notice');
  sel = sel.replace(/^body\s+/, '');
  return `.page ${sel}`;
}
root.walkAtRules('import', r => r.remove());
root.walkRules(rule => {
  if (rule.parent.type === 'atrule' && /keyframes/.test(rule.parent.name)) return;
  let sels = rule.selectors.map(mapSelector);
  // Sign-in screens: the product name in the header is not the page heading, so it is a <p class="brand-title">.
  sels = sels.flatMap(x => /\.brand h1/.test(x) ? [x, x.replace(/\.brand h1/g, '.brand .brand-title')] : [x]);
  // Intro paragraph styling must not restyle sign-in form feedback or its eyebrow.
  sels = sels.map(x => x.replace(/\.intro>p:not\(\.eyebrow\)/g, '.intro>p:not(.eyebrow):not(:global(.auth-eyebrow)):not(:global(.auth-feedback))'));
  rule.selectors = [...new Set(sels)];
});
root.walkDecls(d => {
  d.value = d.value.replace(/'Nunito Sans'/g, 'var(--font-nunito-sans)').replace(/'DM Sans'/g, 'var(--font-dm-sans)');
});
const header = `/*
 * Retail Asset Factory landing page: the approved V39 design ("PIGGYVEST 1").
 * GENERATED from retail_asset_factory_v39_piggyvest_theme_fixed.html: every V39 style block, in
 * order, scoped to .page. Theme selectors use the attributes set by src/lib/theme.ts instead of
 * V39's radio-button :has() rules; System rules apply only when System resolves to dark (V39 showed
 * the dark switcher on a light page). Fonts are self-hosted by next/font. Do not hand-edit values.
 */
/* Neutralise application-wide element styles so V39 renders exactly as in the reference. */
.page { display: block; font-size: 16px; line-height: normal; letter-spacing: normal; }
.page h1, .page h2, .page h3 { font-family: inherit; color: inherit; line-height: normal; letter-spacing: normal; }
.page h1 { font-size: 2em; margin: 0.67em 0; font-weight: bold; }
.page h2 { font-size: 1.5em; margin: 0.83em 0; font-weight: bold; }
.page h3 { font-size: 1.17em; margin: 1em 0; font-weight: bold; }
.page p { margin: 1em 0; }
.page .theme-option { margin: 0; font-size: inherit; font-weight: inherit; color: inherit; }
.page .brand .brand-title { margin: 0; }
.page strong { font-weight: bold; }
.page :focus-visible { outline: revert; border-radius: 0; }
`;
fs.writeFileSync(out, header + root.toString() + '\n');
console.log('rules', root.nodes.length);
