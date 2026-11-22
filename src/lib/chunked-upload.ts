/**
 * Browser side of resumable uploads (see src/server/uploads.ts). Sends the file in pieces, retries a failed piece
 * with back-off, resumes an interrupted upload (even after a page reload) from the pieces the server already has,
 * and can be cancelled. Progress is reported in bytes sent.
 */
import type { IncidentView } from "./incident-messages";

export interface ChunkedUploadInput {
  file: File;
  target: "APPLICATION" | "STAFF_REQUEST";
  targetId: string;
  category: string;
  fields?: Record<string, string>;
  onProgress?: (pct: number, detail: string) => void;
  signal?: AbortSignal;
}
export type ChunkedUploadResult =
  | { ok: true; result: { documentId?: string; version?: number; scanStatus?: string } }
  | { ok: false; error: string; expired?: boolean; incident?: IncidentView; cancelled?: boolean };

type Json = { ok?: boolean; error?: string; expired?: boolean; incident?: IncidentView; [k: string]: unknown };

const resumeKey = (i: ChunkedUploadInput) => `araf.upload:${i.target}:${i.targetId}:${i.category}:${i.file.name}:${i.file.size}:${i.file.lastModified}`;
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* not remembered */
    }
  },
  del: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(url: string, init: RequestInit): Promise<{ status: number; body: Json }> {
  const res = await fetch(url, { ...init, credentials: "same-origin" });
  let body: Json = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON (e.g. a proxy error page) */
  }
  return { status: res.status, body };
}

export async function chunkedUpload(i: ChunkedUploadInput): Promise<ChunkedUploadResult> {
  const key = resumeKey(i);
  let id = store.get(key);
  let chunkSize = 0;
  let chunkCount = 0;
  let received = new Set<number>();
  try {
    if (id) {
      const st = await call(`/api/uploads/${id}`, { method: "GET", signal: i.signal });
      if (st.status === 200 && st.body.status === "OPEN") {
        chunkSize = Number(st.body.chunkSize);
        chunkCount = Number(st.body.chunkCount);
        received = new Set((st.body.received as number[]) ?? []);
      } else {
        store.del(key);
        id = null;
      }
    }
    if (!id) {
      const s = await call("/api/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: i.target, targetId: i.targetId, category: i.category, filename: i.file.name, size: i.file.size, fields: i.fields ?? {} }),
        signal: i.signal,
      });
      if (s.status === 401) return { ok: false, error: s.body.error ?? "Your session has ended.", expired: true };
      if (!s.body.ok) return { ok: false, error: s.body.error ?? `The upload could not start (${s.status}).`, incident: s.body.incident };
      id = String(s.body.id);
      chunkSize = Number(s.body.chunkSize);
      chunkCount = Number(s.body.chunkCount);
      store.set(key, id);
    }
    let sent = [...received].reduce((a, n) => a + (n === chunkCount - 1 ? i.file.size - chunkSize * n : chunkSize), 0);
    const report = () => i.onProgress?.(Math.min(99, Math.round((sent / i.file.size) * 100)), chunkCount > 1 ? `Sending ${received.size} of ${chunkCount} parts` : "Sending");
    report();
    for (let n = 0; n < chunkCount; n++) {
      if (received.has(n)) continue;
      const blob = i.file.slice(n * chunkSize, Math.min(i.file.size, (n + 1) * chunkSize));
      let attempt = 0;
      for (;;) {
        if (i.signal?.aborted) throw new DOMException("cancelled", "AbortError");
        try {
          const r = await call(`/api/uploads/${id}/chunks/${n}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: blob, signal: i.signal });
          if (r.status === 401) return { ok: false, error: r.body.error ?? "Your session has ended.", expired: true };
          if (r.body.ok) break;
          // Client errors are final (wrong size, upload closed); server errors are retried.
          if (r.status < 500 || attempt >= 4) return { ok: false, error: r.body.error ?? `Part ${n + 1} failed (${r.status}). Retry to continue where it stopped.`, incident: r.body.incident };
        } catch (e) {
          if ((e as Error).name === "AbortError") throw e;
          if (attempt >= 4) return { ok: false, error: "The connection dropped. Retry to continue from where it stopped." };
        }
        attempt++;
        await sleep(500 * 2 ** attempt);
      }
      received.add(n);
      sent += blob.size;
      report();
    }
    i.onProgress?.(99, "Checking the file");
    const done = await call(`/api/uploads/${id}/complete`, { method: "POST", signal: i.signal });
    if (done.status === 401) return { ok: false, error: done.body.error ?? "Your session has ended.", expired: true };
    if (done.body.ok) {
      store.del(key);
      i.onProgress?.(100, "Uploaded");
      return { ok: true, result: done.body as { documentId?: string; version?: number; scanStatus?: string } };
    }
    if (done.status !== 409 && done.status !== 500) store.del(key); // the server ended this upload
    return { ok: false, error: done.body.error ?? `The upload could not be completed (${done.status}).`, incident: done.body.incident };
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      if (id) await fetch(`/api/uploads/${id}`, { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
      store.del(key);
      return { ok: false, error: "Upload cancelled.", cancelled: true };
    }
    return { ok: false, error: "The connection dropped. Retry to continue from where it stopped." };
  }
}

export const formatBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
