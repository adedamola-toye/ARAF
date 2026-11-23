"use client";
import { useEffect, useState } from "react";
import { Eye, EyeOff, PanelLeftClose, PanelLeftOpen } from "lucide-react";

/** Per-browser display preferences for the signed-in shell (no data is stored on the server). */
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode: the preference simply is not remembered */
  }
};
const shell = () => document.querySelector<HTMLElement>(".shell");

/** Restores saved preferences on load (rendered once in the layout). */
export function ShellPrefsInit() {
  useEffect(() => {
    const s = shell();
    if (!s) return;
    if (read("araf.nav") === "rail") s.dataset.nav = "rail";
    if (read("araf.hideAmounts") === "1") s.dataset.hideAmounts = "1";
  }, []);
  return null;
}

export function NavCollapseButton() {
  const [rail, setRail] = useState(false);
  useEffect(() => setRail(shell()?.dataset.nav === "rail"), []);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost nav-collapse"
      aria-pressed={rail}
      aria-label={rail ? "Expand navigation" : "Collapse navigation"}
      title={rail ? "Expand navigation" : "Collapse navigation"}
      onClick={() => {
        const s = shell();
        if (!s) return;
        const next = !rail;
        if (next) s.dataset.nav = "rail";
        else delete s.dataset.nav;
        write("araf.nav", next ? "rail" : "full");
        setRail(next);
      }}
    >
      {rail ? <PanelLeftOpen className="icon" aria-hidden="true" /> : <PanelLeftClose className="icon" aria-hidden="true" />}
    </button>
  );
}

export function HideAmountsButton() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => setHidden(shell()?.dataset.hideAmounts === "1"), []);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
      aria-pressed={hidden}
      aria-label={hidden ? "Show amounts" : "Hide amounts"}
      title={hidden ? "Show amounts" : "Hide amounts"}
      onClick={() => {
        const s = shell();
        if (!s) return;
        const next = !hidden;
        if (next) s.dataset.hideAmounts = "1";
        else delete s.dataset.hideAmounts;
        write("araf.hideAmounts", next ? "1" : "0");
        setHidden(next);
      }}
    >
      {hidden ? <EyeOff className="icon" aria-hidden="true" /> : <Eye className="icon" aria-hidden="true" />}
    </button>
  );
}
