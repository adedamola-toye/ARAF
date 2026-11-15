"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { TourStep } from "@/lib/onboarding/tours";
import { onboardingEventAction } from "@/app/(app)/help/actions";

export interface RoleTour {
  role: string;
  label: string;
  steps: TourStep[];
}

const START_EVENT = "araf:start-tour";
/** Start a role's tour from anywhere (e.g. Help & Guides). */
export function startTour(role: string) {
  window.dispatchEvent(new CustomEvent(START_EVENT, { detail: role }));
}

const findTarget = (t: string | null) => (t ? (document.querySelector(`[data-tour="${CSS.escape(t)}"]`) as HTMLElement | null) : null);
const visible = (el: HTMLElement | null) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && r.right > 0 && r.left < window.innerWidth;
};

/**
 * Welcome guide (first time in a role's workspace) and the interactive tour. The tour highlights real elements
 * with a ring and a small panel next to them (no full-screen overlay), scrolls them into view, and skips any step
 * whose element is not available. It only navigates; it never submits or changes anything.
 */
export function OnboardingRoot({ role, roleLabel, showWelcome, tours }: { role: string | null; roleLabel: string; showWelcome: boolean; tours: RoleTour[] }) {
  const welcome = useRef<HTMLDialogElement>(null);
  const [tour, setTour] = useState<{ role: string; steps: TourStep[]; i: number } | null>(null);

  useEffect(() => {
    if (showWelcome && role && welcome.current && !welcome.current.open) {
      welcome.current.showModal();
      void onboardingEventAction(role, "SEEN");
    }
  }, [showWelcome, role]);

  const begin = useCallback(
    (r: string) => {
      const t = tours.find((x) => x.role === r) ?? tours[0];
      if (!t) return;
      // Keep only steps the user can reach: navigation items must exist in their menu.
      const steps = t.steps.filter((s) => !s.target || !s.target.startsWith("nav:") || !!findTarget(s.target));
      if (!steps.length) return;
      void onboardingEventAction(t.role, "START");
      setTour({ role: t.role, steps, i: 0 });
    },
    [tours],
  );

  useEffect(() => {
    const h = (e: Event) => begin((e as CustomEvent<string>).detail);
    window.addEventListener(START_EVENT, h);
    return () => window.removeEventListener(START_EVENT, h);
  }, [begin]);

  return (
    <>
      {showWelcome && role && (
        <dialog
          ref={welcome}
          className="modal modal-welcome"
          aria-labelledby="welcome-title"
          aria-describedby="welcome-desc"
          onCancel={() => void onboardingEventAction(role, "SKIP")}
        >
          <div className="modal-body">
            <p className="eyebrow" style={{ marginTop: 0 }}>
              {roleLabel}
            </p>
            <h2 id="welcome-title">Welcome to ARAF</h2>
            <p id="welcome-desc" className="muted">
              Your workspace is ready. Take a quick tour to learn how to complete your tasks, track your requests and make the most of your dashboard.
            </p>
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                welcome.current?.close();
                void onboardingEventAction(role, "SKIP");
              }}
            >
              Skip for now
            </button>
            <button
              type="button"
              className="btn btn-primary"
              autoFocus
              onClick={() => {
                welcome.current?.close();
                begin(role);
              }}
            >
              Take a quick tour
            </button>
          </div>
        </dialog>
      )}
      {tour && <TourRunner key={`${tour.role}-${tour.i}`} tour={tour} setTour={setTour} />}
    </>
  );
}

function TourRunner({ tour, setTour }: { tour: { role: string; steps: TourStep[]; i: number }; setTour: (t: { role: string; steps: TourStep[]; i: number } | null) => void }) {
  const router = useRouter();
  const path = usePathname();
  const step = tour.steps[tour.i];
  const [pos, setPos] = useState<{ top: number; left: number; anchored: boolean } | null>(null);
  const [dir, setDir] = useState(1);
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const last = tour.i === tour.steps.length - 1;

  const go = useCallback(
    (to: number) => {
      if (to < 0) return;
      if (to >= tour.steps.length) {
        void onboardingEventAction(tour.role, "COMPLETE", tour.steps.length);
        setTour(null);
        return;
      }
      setDir(to >= tour.i ? 1 : -1);
      void onboardingEventAction(tour.role, "STEP", to);
      setTour({ ...tour, i: to });
    },
    [tour, setTour],
  );
  const skip = useCallback(() => {
    void onboardingEventAction(tour.role, "SKIP", tour.i);
    setTour(null);
  }, [tour, setTour]);

  // Open the step's page if needed.
  useEffect(() => {
    if (step.href && path !== step.href) router.push(step.href);
  }, [step.href, path, router]);

  // Find, highlight and position next to the target (waiting briefly for a page to render it).
  useLayoutEffect(() => {
    let el: HTMLElement | null = null;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const place = () => {
      const width = Math.min(340, window.innerWidth - 32);
      if (el && visible(el)) {
        const r = el.getBoundingClientRect();
        const h = panel.current?.offsetHeight ?? 200;
        let top = r.bottom + 10;
        if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 10);
        let left = r.left;
        if (r.right + width + 16 < window.innerWidth && r.width < 300) {
          left = r.right + 14;
          top = Math.min(Math.max(12, r.top - 8), window.innerHeight - h - 12);
        }
        left = Math.min(Math.max(16, left), window.innerWidth - width - 16);
        setPos({ top, left, anchored: true });
      } else setPos({ top: 0, left: 0, anchored: false });
    };
    const attempt = () => {
      if (step.href && path !== step.href && tries < 30) {
        tries++;
        timer = setTimeout(attempt, 100);
        return;
      }
      el = findTarget(step.target);
      if (step.target && !el && tries < 25) {
        tries++;
        timer = setTimeout(attempt, 100);
        return;
      }
      if (step.target && !el) {
        // Not available here: skip this step in the direction of travel.
        const next = tour.i + dir;
        if (next >= 0 && next < tour.steps.length) setTour({ ...tour, i: next });
        else setTour(null);
        return;
      }
      if (el && visible(el)) {
        el.classList.add("tour-target");
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        setTimeout(place, 260);
      }
      place();
    };
    attempt();
    const onResize = () => place();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      clearTimeout(timer);
      el?.classList.remove("tour-target");
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [step, path, tour, dir, setTour]);

  useEffect(() => {
    heading.current?.focus();
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") skip();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [skip]);

  return (
    <div
      ref={panel}
      className={`tour-panel${pos?.anchored ? "" : " tour-panel-centre"}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby="tour-title"
      aria-describedby="tour-body"
      style={pos?.anchored ? { top: pos.top, left: pos.left } : undefined}
      hidden={!pos}
    >
      <div className="tour-progress" aria-label={`Step ${tour.i + 1} of ${tour.steps.length}`}>
        <span>
          Step {tour.i + 1} of {tour.steps.length}
        </span>
        <span className="tour-bar" aria-hidden="true">
          <span style={{ width: `${((tour.i + 1) / tour.steps.length) * 100}%` }} />
        </span>
      </div>
      <h2 id="tour-title" ref={heading} tabIndex={-1}>
        {step.title}
      </h2>
      <p id="tour-body" aria-live="polite">
        {step.body}
      </p>
      <div className="tour-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={skip}>
          Skip tour
        </button>
        <span className="row" style={{ gap: 6 }}>
          <button type="button" className="btn btn-sm" onClick={() => go(tour.i - 1)} disabled={tour.i === 0}>
            Back
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => go(tour.i + 1)}>
            {last ? "Finish" : "Next"}
          </button>
        </span>
      </div>
    </div>
  );
}

/** "Start tour" button for Help & Guides. */
export function StartTourButton({ role, label }: { role: string; label: string }) {
  return (
    <button type="button" className="btn btn-sm btn-primary" onClick={() => startTour(role)}>
      {label}
    </button>
  );
}
