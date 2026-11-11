"use client";
import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, RotateCcw, Upload } from "lucide-react";

type Phase = { kind: "idle" } | { kind: "uploading"; pct: number } | { kind: "done"; msg: string } | { kind: "error"; msg: string };

/**
 * Upload control with real progress, error and retry states. It has no <form> of its own, so it can
 * be placed inside other forms. The server enforces every rule (stage, category, assignee, type, scan).
 */
export function UploadPanel({
  applicationId,
  categories,
  replaces,
  title = "Upload a document",
  compact = false,
  withMeta = false,
}: {
  applicationId: string;
  categories: { code: string; label: string }[];
  replaces?: { id: string; label: string }[];
  title?: string;
  compact?: boolean;
  /** Retail uploads: capture photo category and statement/payslip coverage dates. */
  withMeta?: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState(categories[0]?.code ?? "");
  const [replace, setReplace] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [fileName, setFileName] = useState("");
  const [photoCategory, setPhotoCategory] = useState("");
  const [coverageFrom, setCoverageFrom] = useState("");
  const [coverageTo, setCoverageTo] = useState("");
  const needsPhoto = withMeta && category === "BUSINESS_PHOTO";
  const needsCoverage = withMeta && (category === "BANK_STATEMENT" || category === "PAYSLIP");

  const send = () => {
    const f = fileRef.current?.files?.[0];
    if (!f) {
      setPhase({ kind: "error", msg: "Choose a file to upload." });
      fileRef.current?.focus();
      return;
    }
    if (needsPhoto && !photoCategory) {
      setPhase({ kind: "error", msg: "Choose the photograph category (angle) first." });
      return;
    }
    if (needsCoverage && (!coverageFrom || !coverageTo)) {
      setPhase({ kind: "error", msg: "Enter the period the statement or payslip covers (from and to)." });
      return;
    }
    const fd = new FormData();
    fd.set("applicationId", applicationId);
    fd.set("category", category);
    if (needsPhoto) fd.set("photoCategory", photoCategory);
    if (needsCoverage) {
      fd.set("coverageFrom", coverageFrom);
      fd.set("coverageTo", coverageTo);
    }
    if (replace) fd.set("replacesDocumentId", replace);
    fd.set("file", f);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/documents/upload");
    xhr.upload.onprogress = (e) => e.lengthComputable && setPhase({ kind: "uploading", pct: Math.round((e.loaded / e.total) * 100) });
    xhr.onerror = () => setPhase({ kind: "error", msg: "Network error. Your file was not saved. Retry when you are connected." });
    xhr.onload = () => {
      let body: { ok?: boolean; error?: string; version?: number; scanStatus?: string; expired?: boolean } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON */
      }
      if (xhr.status === 401 && body.expired) {
        window.location.replace(`/session-expired?reason=IDLE_TIMEOUT&next=${encodeURIComponent(location.pathname + location.search)}`);
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.ok) {
        setPhase({ kind: "done", msg: body.scanStatus === "CLEAN" ? `Uploaded ${f.name} (version ${body.version}).` : `Uploaded ${f.name}. It stays in quarantine until the scan completes.` });
        if (fileRef.current) fileRef.current.value = "";
        setFileName("");
        router.refresh();
      } else {
        setPhase({ kind: "error", msg: body.error ?? `Upload failed (${xhr.status}).` });
      }
    };
    setPhase({ kind: "uploading", pct: 0 });
    xhr.send(fd);
  };
  const busy = phase.kind === "uploading";
  return (
    <div className="upload" role="group" aria-labelledby={`${id}-t`}>
      <strong id={`${id}-t`} className="small">
        <Upload className="icon" aria-hidden="true" /> {title}
      </strong>
      <div className={compact ? "stack" : "grid-2"}>
        {categories.length > 1 ? (
          <div className="field">
            <label htmlFor={`${id}-c`}>Document type</label>
            <select id={`${id}-c`} value={category} onChange={(e) => setCategory(e.target.value)} disabled={busy}>
              {categories.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            {categories[0]?.label}
          </p>
        )}
        {replaces && replaces.length > 0 && (
          <div className="field">
            <label htmlFor={`${id}-r`}>Replaces (optional)</label>
            <select id={`${id}-r`} value={replace} onChange={(e) => setReplace(e.target.value)} disabled={busy}>
              <option value="">New document</option>
              {replaces.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {needsPhoto && (
        <div className="field">
          <label htmlFor={`${id}-p`}>Photograph category (angle)</label>
          <select id={`${id}-p`} value={photoCategory} onChange={(e) => setPhotoCategory(e.target.value)} disabled={busy}>
            <option value="">Choose…</option>
            <option value="FRONT">Shop front</option>
            <option value="SIGNAGE">Signage / name board</option>
            <option value="INTERIOR">Interior</option>
            <option value="STOCK">Stock / goods</option>
            <option value="SURROUNDINGS">Street / surroundings</option>
            <option value="RM_WITH_BUSINESS">Relationship Manager with the business</option>
          </select>
          <span className="hint">Use a different angle for each photograph. A reviewer confirms what each photograph shows; nothing is verified automatically.</span>
        </div>
      )}
      {needsCoverage && (
        <div className="grid-2">
          <div className="field">
            <label htmlFor={`${id}-cf`}>Covers from</label>
            <input id={`${id}-cf`} type="date" value={coverageFrom} onChange={(e) => setCoverageFrom(e.target.value)} disabled={busy} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-ct`}>Covers to</label>
            <input id={`${id}-ct`} type="date" value={coverageTo} onChange={(e) => setCoverageTo(e.target.value)} disabled={busy} />
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor={`${id}-f`}>File (PDF, PNG, JPG, DOCX or XLSX)</label>
        <input id={`${id}-f`} ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx" disabled={busy} onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")} />
        <span className="hint">Single-file categories keep earlier versions as superseded.</span>
      </div>
      {phase.kind === "uploading" && (
        <div role="status" aria-live="polite">
          <div className="progress-bar" aria-hidden="true">
            <span style={{ width: `${phase.pct}%` }} />
          </div>
          <span className="small muted">
            Uploading {fileName} · {phase.pct}%{phase.pct === 100 ? " · scanning…" : ""}
          </span>
        </div>
      )}
      {phase.kind === "done" && (
        <div className="alert alert-success" role="status">
          <CheckCircle2 className="icon" aria-hidden="true" />
          {phase.msg}
        </div>
      )}
      {phase.kind === "error" && (
        <div className="alert alert-error" role="alert">
          <AlertTriangle className="icon" aria-hidden="true" />
          <span style={{ flex: 1 }}>{phase.msg}</span>
        </div>
      )}
      <div className="row">
        <button type="button" className="btn btn-dark btn-sm" onClick={send} disabled={busy}>
          {phase.kind === "error" ? <RotateCcw className="icon" aria-hidden="true" /> : <Upload className="icon" aria-hidden="true" />}
          {busy ? "Uploading…" : phase.kind === "error" ? "Retry upload" : "Upload"}
        </button>
      </div>
    </div>
  );
}
