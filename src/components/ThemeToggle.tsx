"use client";
import { useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";

/** Discreet, persistent light/dark control. Dark is the default on first visit. */
export function ThemeToggle({ initial, variant = "icon" }: { initial: Theme | null; variant?: "icon" | "pill" }) {
  const [theme, setTheme] = useState<Theme>(initial ?? "dark");
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    document.cookie = `wb-theme=${next}; path=/; max-age=31536000; samesite=lax`;
    try {
      localStorage.setItem("wb-theme", next);
    } catch {
      /* storage unavailable */
    }
  };
  const target = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${target} mode`;
  const Icon = theme === "dark" ? Sun : Moon;
  if (variant === "pill")
    return (
      <button type="button" className="theme-pill" onClick={toggle} aria-label={label} aria-pressed={theme === "dark"}>
        <Icon className="icon" aria-hidden="true" />
        <span>{target === "light" ? "Light mode" : "Dark mode"}</span>
      </button>
    );
  return (
    <button type="button" className="btn btn-sm btn-ghost" onClick={toggle} aria-label={label} title={label}>
      <Icon className="icon" aria-hidden="true" />
    </button>
  );
}
