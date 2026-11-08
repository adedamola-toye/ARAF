"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Client side of the 5-minute inactivity timeout (the server is authoritative).
 *  - Real user input (keys, pointer, scroll) sends a throttled activity heartbeat.
 *  - Background status polling uses an endpoint that never extends the session.
 *  - On timeout the protected UI is hidden immediately and the user is sent to sign in again.
 */
export function IdleWatcher({ idleSeconds, expiresAt }: { idleSeconds: number; expiresAt: string }) {
  const [expired, setExpired] = useState(false);
  const deadline = useRef(new Date(expiresAt).getTime());
  const lastBeat = useRef(Date.now());

  const expire = useCallback(() => {
    if (expired) return;
    setExpired(true);
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace(`/session-expired?reason=IDLE_TIMEOUT&next=${next}`);
  }, [expired]);

  useEffect(() => {
    deadline.current = new Date(expiresAt).getTime();
  }, [expiresAt]);

  useEffect(() => {
    const onActivity = () => {
      const now = Date.now();
      if (now >= deadline.current) return expire();
      if (now - lastBeat.current < 30_000) return;
      lastBeat.current = now;
      fetch("/api/session/touch", { method: "POST", cache: "no-store" })
        .then((r) => r.json())
        .then((j) => (j.status === "ok" ? (deadline.current = new Date(j.idleExpiresAt).getTime()) : expire()))
        .catch(() => undefined);
    };
    const events = ["keydown", "pointerdown", "wheel", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    const tick = setInterval(() => {
      if (Date.now() >= deadline.current) expire();
    }, 1000);
    const poll = setInterval(() => {
      fetch("/api/session/status", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => {
          if (j.status !== "ok") expire();
          else deadline.current = new Date(j.idleExpiresAt).getTime();
        })
        .catch(() => undefined);
    }, 30_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [expire, idleSeconds]);

  if (!expired) return null;
  return (
    <div className="idle-curtain" role="alert">
      <p>Your session timed out after {Math.round(idleSeconds / 60)} minutes of inactivity. Redirecting to sign in…</p>
    </div>
  );
}
