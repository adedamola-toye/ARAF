# Design system

The whole application follows the approved landing page **V39 ("PIGGYVEST 1")**, kept unchanged at
`docs/design/retail_asset_factory_v39_piggyvest_theme_fixed.html`. This is a visual standard only: business
rules, workflows, permissions, routes and calculations are not part of it.

## Where things live

| Concern | File |
|---|---|
| Fonts (self-hosted) | `src/app/fonts.css`, `public/fonts/*.woff2`, licence `public/fonts/OFL.txt` |
| Design tokens and all shared components | `src/app/globals.css` |
| Landing page styles (generated from V39) | `src/app/landing.module.css` ← `scripts/port-v39-landing.mjs` |
| Theme mechanism | `src/lib/theme.ts` (pre-paint script), `src/app/_lib/theme.ts` (server), `src/components/Appearance.tsx` (controls) |
| Product lockup, sign-in layout, footer | `src/components/Brand.tsx` |

## Typography

| Role | Face | Weights |
|---|---|---|
| Headings, card titles, KPI figures, table/eyebrow labels | Nunito Sans (`--font-display`), optical size 6–12 | 700–900 headings, 800 labels |
| Body, navigation, buttons, forms, tables, messages | DM Sans (`--font`) | 400, 500, 600 |

Both fonts are the exact files and `@font-face` declarations V39 requests from Google Fonts (latin and latin-ext;
latin-ext carries the naira sign ₦), served from `/fonts`, so production never calls Google. Discrete weight faces
are kept as in V39, so CSS weights such as 450 or 850 resolve exactly as in the reference. Financial figures use
tabular numerals (`.num`, `.tnum`, `table.data td`, metrics, money inputs); amounts in tables are right-aligned.
Identifiers (phone, account, BVN, references) use the body face with tabular figures, not a monospace font.

## Tokens

Semantic tokens are defined once for light (`:root`) and once for dark (`:root[data-theme="dark"]`, repeated in a
`prefers-color-scheme` block for System without JavaScript). Components use only these tokens.

| Token | Light | Dark | Source in V39 |
|---|---|---|---|
| `--bg` | `#F7F9FF` | `#101820` | page background |
| `--surface` / `-2` / `-3` | `#FFFFFF` / `#F3F6FC` / `#E8EDF5` | `#16212B` / `#1B2935` / `#263744` | cards, appearance panel, switcher |
| `--ink` / `--ink-2` | `#152B59` / `#2B3F69` | `#F5F7FA` / `#D4E0EB` | text |
| `--muted` | `#5F6C87` | `#B5C1CD` | secondary text (`#64718C` / `#C1CBD5`) |
| `--line` / `--line-strong` | `#DEE5F3` / `#C4CEE2` | `#2C3A47` / `#40505D` | dividers |
| `--brand` / `--brand-hover` | `#1D438E` / `#173B9D` | `#204991` / `#2A56A6` | Relationship Manager card |
| `--accent` (links, focus, active) | `#153FAF` | `#9DBBFF` | eyebrow |
| `--success` on `--success-bg` | `#204C3A` on `#E7F2EB` | `#D0E7D8` on `#234238` | Delight Officer card |
| `--warn` on `--warn-bg` | `#684A2D` on `#F7EBDD` | `#F0D9C1` on `#4B392A` | Staff Personal Request card |
| `--danger` on `--danger-bg` | `#B42318` on `#FDECEB` | `#FFB4AB` on 14% red | (added for errors) |

Spacing `--space-1…7` = 4, 8, 12, 16, 24, 32, 48 px. Radii: controls 10 px, cards 14 px, large cards 16 px
(V39 workspace cards), photo 20 px. Control height 42 px. Shadows `--shadow-sm`, `--shadow-card` (V39 card hover),
`--shadow-float` (V39 appearance panel). Focus: 3 px `--focus` outline. Motion: 0.15–0.2 s, disabled under
`prefers-reduced-motion`.

## Appearance: Light, Dark, System

- One preference, `raf-theme` = `light | dark | system` (default **System**, as in V39), stored in a cookie (so the
  server renders the right theme) and mirrored to localStorage. A legacy `wb-theme` cookie is honoured.
- `<html data-theme-preference>` holds the choice; `<html data-theme>` the resolved theme. The script in
  `src/lib/theme.ts` runs in `<head>` before first paint (no flash), follows operating-system changes while
  System is selected, and applies changes made in other tabs.
- Controls: the discreet "⚙ Appearance" menu in the footer of the landing page and sign-in screens (V39), and an
  Appearance segment in the profile menu of the signed-in application. Both call the same controller.

## Corrections to V39 found in browser verification

1. With **System** selected on a light operating system, V39 drew the theme switcher in its dark colours
   (its `:has(#raf-system:checked)` rules sat outside the dark media query). System rules now apply only when
   System resolves to dark.
2. The footer "Appearance" label was `#78849A` at 78% opacity (under 3.6:1). It now uses V39's `#64718C` at full
   opacity (4.9:1, WCAG AA).
3. V39 applied the theme from a script at the end of the page, so dark users saw a light flash animating to dark.
   The application resolves the theme before first paint.

Everything else on the landing page is V39 verbatim: it renders pixel-identical to the reference in light and dark
at 1920, 1440, 1366, 1280, 1024, 820, 768, 430, 390 and 360 px (except the corrected label above).

## Regenerating the landing styles

```
node scripts/port-v39-landing.mjs docs/design/retail_asset_factory_v39_piggyvest_theme_fixed.html src/app/landing.module.css
```

The script scopes every V39 rule to the page, maps V39's radio-button `:has()` theme rules to the `<html>`
attributes (keeping their specificity) and appends the corrections above. Do not hand-edit the generated file.
