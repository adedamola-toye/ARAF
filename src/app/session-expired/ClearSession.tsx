"use client";
import { useEffect } from "react";

/** Clears the (already revoked) session cookie and any cached protected view. */
export function ClearSession() {
  useEffect(() => {
    fetch("/api/session/logout", { method: "POST" }).catch(() => undefined);
    try {
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
  }, []);
  return null;
}
