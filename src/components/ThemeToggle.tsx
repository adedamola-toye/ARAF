"use client";
import { useEffect, useState } from "react";

type Theme = "light" | "dark";

/** Persistent light/dark preference (cookie for server rendering + localStorage). */
export function ThemeToggle({ initial }: { initial: Theme | null }) {
  const [theme, setTheme] = useState<Theme | null>(initial);
  useEffect(() => {
    if (theme) return;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("wb-theme");
    } catch {
      /* storage unavailable */
    }
    const t = stored === "dark" || stored === "light" ? stored : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    setTheme(t);
  }, [theme]);
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    document.cookie = `wb-theme=${next}; path=/; max-age=31536000; samesite=lax`;
    try {
      localStorage.setItem("wb-theme", next);
    } catch {
      /* ignore */
    }
  };
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button type="button" className="btn btn-sm theme-toggle" onClick={toggle} aria-label={label} title={label}>
      <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
      <span className="sr-only">{label}</span>
    </button>
  );
}
