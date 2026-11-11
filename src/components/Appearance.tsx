"use client";
import { useEffect, useId, useState } from "react";
import { THEME_COOKIE, THEME_STORAGE_KEY, parsePreference, type ThemePreference } from "@/lib/theme";

declare global {
  interface Window {
    __rafTheme?: { set: (p: ThemePreference) => ThemePreference; apply: (p: ThemePreference) => ThemePreference };
  }
}

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "☀ Light" },
  { value: "dark", label: "☾ Dark" },
  { value: "system", label: "System" },
];

/** Applies and saves a preference through the single theme controller (see lib/theme.ts). */
function choose(p: ThemePreference) {
  if (window.__rafTheme) return window.__rafTheme.set(p);
  document.cookie = `${THEME_COOKIE}=${p}; path=/; max-age=31536000; samesite=lax`;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, p);
  } catch {
    /* storage unavailable */
  }
  location.reload();
  return p;
}

function usePreference(initial: ThemePreference) {
  const [pref, setPref] = useState<ThemePreference>(initial);
  useEffect(() => {
    const current = parsePreference(document.documentElement.getAttribute("data-theme-preference"));
    if (current !== pref) setPref(current);
    const sync = (e: Event) => setPref(parsePreference((e as CustomEvent<string>).detail));
    window.addEventListener("raf-theme", sync);
    return () => window.removeEventListener("raf-theme", sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [pref, (p: ThemePreference) => setPref(choose(p))] as const;
}

type Classes = { switcher: string; option: string };

/** Light / Dark / System radio group (V39 theme switcher). */
export function AppearanceOptions({ initial, classes = { switcher: "theme-switcher", option: "theme-option" } }: { initial: ThemePreference; classes?: Classes }) {
  const [pref, setPref] = usePreference(initial);
  const name = useId();
  return (
    <div className={classes.switcher} role="radiogroup" aria-label="Appearance">
      {OPTIONS.map((o) => (
        <label key={o.value} className={classes.option}>
          <input type="radio" name={name} value={o.value} checked={pref === o.value} onChange={() => setPref(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/** Discreet footer control from V39: "⚙ Appearance" opens a small Display theme panel. */
export function AppearanceMenu({ initial, classes }: { initial: ThemePreference; classes: Classes & { menu: string; panel: string; caption: string } }) {
  return (
    <details className={classes.menu}>
      <summary aria-label="Change appearance" title="Appearance settings">
        <span aria-hidden="true">⚙</span>
        <span>Appearance</span>
      </summary>
      <div className={classes.panel}>
        <div className={classes.caption}>DISPLAY THEME</div>
        <AppearanceOptions initial={initial} classes={classes} />
      </div>
    </details>
  );
}
