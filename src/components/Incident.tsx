"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Copy, Check, RotateCw, Zap } from "lucide-react";
import { fallbackMessageNo, INCIDENT_FOOTER, messageByNo, statusLabel, type IncidentView } from "@/lib/incident-messages";

export interface FailureReport {
  digest?: string | null;
  name?: string | null;
  message?: string | null;
  /** "network": the browser never got an answer, so the outcome is unknown. */
  kind: "client" | "network";
}

const memo = new Map<string, Promise<IncidentView>>();

/** Ask the incident service which incident this is and which message this user has. Never rejects. */
function fetchIncident(r: FailureReport): Promise<IncidentView> {
  const key = `${r.kind}|${r.digest ?? ""}|${r.name ?? ""}|${(r.message ?? "").slice(0, 80)}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const fallback = (): IncidentView => ({ ref: null, messageNo: fallbackMessageNo(r.digest ?? r.message ?? r.name), status: "UNRECORDED", statusLabel: statusLabel("UNRECORDED", false), routed: false });
  const p = (async () => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 6000);
    try {
      const res = await fetch("/api/incidents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digest: r.digest ?? null, name: r.name ?? null, message: r.message ?? null, kind: r.kind, route: location.pathname }),
        signal: ac.signal,
        cache: "no-store",
      });
      const body = (await res.json()) as { incident?: IncidentView };
      return body.incident && body.incident.messageNo ? body.incident : fallback();
    } catch {
      return fallback();
    } finally {
      clearTimeout(t);
    }
  })();
  memo.set(key, p);
  return p;
}

export function useIncident(report: FailureReport | null, preset?: IncidentView | null): IncidentView | null {
  const [view, setView] = useState<IncidentView | null>(preset ?? null);
  const key = report ? `${report.kind}|${report.digest}|${report.name}|${report.message}` : "";
  useEffect(() => {
    if (preset) return setView(preset);
    if (!report) return;
    let live = true;
    void fetchIncident(report).then((v) => live && setView(v));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, preset]);
  return view;
}

function CopyRef({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLElement>(null);
  return (
    <div className="inc-ref">
      <span className="inc-ref-k">Incident reference</span>
      <code ref={ref} className="inc-ref-v">
        {value}
      </code>
      <button
        type="button"
        className="inc-copy"
        aria-label={done ? "Reference copied" : `Copy reference ${value}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
          } catch {
            const sel = window.getSelection();
            const range = document.createRange();
            if (ref.current && sel) {
              range.selectNodeContents(ref.current);
              sel.removeAllRanges();
              sel.addRange(range);
              document.execCommand?.("copy");
            }
          }
          setDone(true);
          setTimeout(() => setDone(false), 2200);
        }}
      >
        {done ? <Check className="inc-ic" aria-hidden="true" /> : <Copy className="inc-ic" aria-hidden="true" />}
        <span>{done ? "Copied" : "Copy"}</span>
      </button>
      <span className="sr-only" aria-live="polite">
        {done ? "Reference copied to the clipboard." : ""}
      </span>
    </div>
  );
}

const DOT: Record<IncidentView["status"], string> = { DETECTED: "warn", INVESTIGATING: "info", RESOLVED: "ok", CLOSED: "ok", UNRECORDED: "muted" };

/**
 * The incident experience. "page" replaces a crashed screen; "inline" sits inside a form whose submission
 * hit a technical failure (the form's entries stay as they are).
 */
export function IncidentCard({
  view,
  variant,
  note,
  onRetry,
  retryLabel = "Try again",
  dashboardHref = "/dashboard",
}: {
  view: IncidentView | null;
  variant: "page" | "inline";
  /** Recovery guidance specific to what failed. */
  note?: string;
  /** Present only when retrying is safe. */
  onRetry?: () => void;
  retryLabel?: string;
  dashboardHref?: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (variant === "page" && view) heading.current?.focus();
  }, [variant, view]);
  const H = variant === "page" ? "h1" : "h2";
  if (!view)
    return (
      <section className={`inc inc-${variant} is-loading`} aria-busy="true" aria-live="polite">
        <style dangerouslySetInnerHTML={{ __html: INCIDENT_CSS }} />
        <div className="inc-mark" aria-hidden="true">
          <Zap className="inc-mark-ic" />
        </div>
        <p className="inc-kicker">Technical issue</p>
        <p className="inc-desc">Checking what happened…</p>
      </section>
    );
  const m = messageByNo(view.messageNo);
  return (
    <section className={`inc inc-${variant}`} role="alert" aria-labelledby={`inc-h-${variant}`} aria-describedby={`inc-d-${variant}`}>
      <style dangerouslySetInnerHTML={{ __html: INCIDENT_CSS }} />
      <div className="inc-mark" aria-hidden="true">
        <Zap className="inc-mark-ic" />
      </div>
      <p className="inc-kicker">
        <span className="sr-only">Error. </span>Technical issue
      </p>
      <H id={`inc-h-${variant}`} className="inc-h" ref={heading} tabIndex={-1} data-message={m.no}>
        {m.headline}
      </H>
      <p id={`inc-d-${variant}`} className="inc-desc">
        {m.description}
      </p>
      <p className="inc-status">
        <span className={`inc-dot inc-dot-${DOT[view.status]}`} aria-hidden="true" />
        <span>{view.statusLabel}</span>
      </p>
      {view.ref && <CopyRef value={view.ref} />}
      {note && <p className="inc-note">{note}</p>}
      <div className="inc-actions">
        {onRetry && (
          <button type="button" className="btn btn-primary inc-btn" onClick={onRetry}>
            <RotateCw className="inc-ic" aria-hidden="true" /> {retryLabel}
          </button>
        )}
        <Link className="btn inc-btn" href={dashboardHref}>
          Back to Dashboard
        </Link>
      </div>
      {variant === "page" && <p className="inc-foot">{INCIDENT_FOOTER}</p>}
    </section>
  );
}

/**
 * In-form incident panel. A failure the server recorded can be retried (the action rolled back and the
 * resubmission carries the same idempotency key). A lost response cannot: the outcome is unknown, so the
 * user checks the status first.
 */
export function IncidentPanel({ preset, report, onResubmit, onCheckStatus }: { preset?: (IncidentView & { retry?: boolean }) | null; report?: FailureReport | null; onResubmit?: () => void; onCheckStatus: () => void }) {
  const view = useIncident(preset ? null : (report ?? null), preset ?? null);
  const unknownOutcome = !preset && report?.kind === "network";
  if (unknownOutcome)
    return <IncidentCard view={view} variant="inline" note="We couldn't confirm whether this went through. Check its status before submitting again; your entries are kept." onRetry={onCheckStatus} retryLabel="Check status" />;
  return <IncidentCard view={view} variant="inline" note="This change was not applied. Your entries are kept." onRetry={preset?.retry !== false ? onResubmit : undefined} />;
}

/** Full-screen incident for an error boundary. Retrying re-renders the page (a read: always safe). */
export function IncidentScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const view = useIncident({ kind: "client", digest: error.digest ?? null, name: error.name, message: error.digest ? null : error.message });
  return (
    <div className="inc-wrap">
      <IncidentCard view={view} variant="page" note="Nothing you were viewing has changed. Trying again reloads this page." onRetry={() => reset()} />
    </div>
  );
}

/**
 * Self-contained styles (also used by the root fallback page, which has no stylesheet). Colours come from
 * ARAF's design tokens, with fallbacks matching the V39 palette.
 */
export const INCIDENT_CSS = `
.inc{--i-surface:var(--surface,#fff);--i-ink:var(--ink,#152B59);--i-ink2:var(--ink-2,#3B4A66);--i-muted:var(--muted,#64718C);--i-line:var(--line,#DEE5F3);--i-brand:var(--brand,#153FAF);--i-soft:var(--accent-soft,#EAF0FF);--i-display:var(--font-display,'Nunito Sans',system-ui,sans-serif);
  position:relative;color:var(--i-ink);text-align:left}
.inc-wrap{min-height:min(78vh,760px);display:grid;place-items:center;padding:clamp(24px,6vw,72px) 16px}
.inc-page{width:100%;max-width:600px;background:var(--i-surface);border:1px solid var(--i-line);border-radius:var(--radius-xl,20px);box-shadow:var(--shadow-card,0 1px 2px rgba(16,24,40,.04),0 12px 32px -12px rgba(16,24,40,.12));padding:clamp(28px,5vw,48px)}
.inc-inline{border:1px solid var(--i-line);border-left:3px solid var(--i-brand);border-radius:var(--radius,12px);background:var(--i-surface);padding:20px 22px;margin:0 0 4px}
.inc-mark{width:48px;height:48px;border-radius:14px;display:grid;place-items:center;background:var(--i-soft);color:var(--link,var(--i-brand));margin-bottom:22px;position:relative}
.inc-mark::after{content:"";position:absolute;inset:-5px;border-radius:18px;border:1px solid var(--link,var(--i-brand));opacity:.2}
.inc-inline .inc-mark{display:none}
.inc-mark-ic{width:22px;height:22px;stroke-width:2.2}
.inc-kicker{margin:0 0 8px;font-size:11.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--i-muted)}
.inc-h{font-family:var(--i-display);font-weight:900;letter-spacing:-.035em;line-height:1.12;margin:0 0 12px;font-size:clamp(25px,3.6vw,32px);outline:none;text-wrap:balance}
.inc-inline .inc-h{font-size:18px;letter-spacing:-.02em;line-height:1.25;margin-bottom:6px}
.inc-desc{margin:0 0 18px;color:var(--i-ink2);line-height:1.65;font-size:15.5px;max-width:52ch}
.inc-inline .inc-desc{font-size:14px;margin-bottom:12px}
.inc-status{display:flex;align-items:center;gap:10px;margin:0 0 18px;font-size:13.5px;color:var(--i-ink2)}
.inc-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--muted,#64718C)}
.inc-dot-warn{background:var(--warn,#B25E09);box-shadow:0 0 0 4px var(--warn-bg,#FFF4E5)}
.inc-dot-info{background:var(--info,#153FAF);box-shadow:0 0 0 4px var(--info-bg,#EAF0FF);animation:inc-pulse 1.8s var(--ease,ease) infinite}
.inc-dot-ok{background:var(--success,#137A4B);box-shadow:0 0 0 4px var(--success-bg,#E6F6EE)}
.inc-ref{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:12px 14px;border:1px dashed var(--line-strong,#C9D3E6);border-radius:var(--radius-sm,10px);background:var(--surface-2,#F7F9FF);margin:0 0 18px}
.inc-ref-k{font-size:12px;color:var(--i-muted);flex:1 1 auto}
.inc-ref-v{font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:14px;font-weight:700;letter-spacing:.02em;color:var(--i-ink)}
.inc-copy{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--i-line);background:var(--i-surface);color:var(--i-ink);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;transition:border-color .15s,background .15s}
.inc-copy:hover{border-color:var(--i-brand)}
.inc-copy:focus-visible,.inc-btn:focus-visible{outline:2px solid var(--focus,#153FAF);outline-offset:2px}
.inc-ic{width:15px;height:15px}
.inc-note{margin:0 0 18px;font-size:13.5px;color:var(--i-muted);line-height:1.55}
.inc-actions{display:flex;flex-wrap:wrap;gap:10px}
.inc-btn{display:inline-flex;align-items:center;gap:8px}
.inc-foot{margin:30px 0 0;padding-top:18px;border-top:1px solid var(--i-line);font-size:12px;color:var(--i-muted);letter-spacing:.02em}
.inc.is-loading .inc-desc{color:var(--i-muted)}
.inc>*{animation:inc-in .42s var(--ease,cubic-bezier(.2,.7,.2,1)) both}
.inc>*:nth-child(3){animation-delay:.04s}.inc>*:nth-child(4){animation-delay:.08s}.inc>*:nth-child(5){animation-delay:.12s}.inc>*:nth-child(6){animation-delay:.16s}.inc>*:nth-child(n+7){animation-delay:.2s}
@keyframes inc-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes inc-pulse{50%{box-shadow:0 0 0 7px var(--info-bg,#EAF0FF)}}
@media (prefers-reduced-motion:reduce){.inc>*,.inc-dot-info{animation:none}}
@media (max-width:480px){.inc-actions .inc-btn{flex:1 1 100%;justify-content:center}.inc-ref-k{flex-basis:100%}}
.sr-only{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;
