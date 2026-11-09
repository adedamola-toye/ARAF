"use client";
import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Eye, Upload } from "lucide-react";
import { directoryImportAction } from "../actions";
import type { ImportSummary } from "@/server/domain/directory";

/** Upload → preview (dry run) → confirm import. The selected file is kept between the two steps. */
export function DirectoryUpload() {
  const [state, action, pending] = useActionState(directoryImportAction, {});
  const [intent, setIntent] = useState("preview");
  const [mode, setMode] = useState("MERGE");
  // React resets a form after its action runs, which would clear the chosen file between preview and
  // import. The file is therefore held in state and the form data is built here.
  const [file, setFile] = useState<File | null>(null);
  const [previewed, setPreviewed] = useState<{ file: File; mode: string } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const router = useRouter();
  const result = useRef<HTMLDivElement>(null);
  const s = state.data as ImportSummary | undefined;
  useEffect(() => {
    if (state.ok || state.error) result.current?.focus();
    if (s?.applied) router.refresh();
  }, [state, s, router]);
  const previewCurrent = !!previewed && previewed.file === file && previewed.mode === mode;
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const next = submitter?.value === "import" ? "import" : "preview";
    if (!file) {
      setLocalError("Choose the directory file first.");
      return;
    }
    setLocalError(null);
    setIntent(next);
    if (next === "preview") setPreviewed({ file, mode });
    const fd = new FormData();
    fd.set("intent", next);
    fd.set("mode", mode);
    fd.set("file", file);
    startTransition(() => action(fd));
  };
  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="dir-file">Directory file (.xlsx or .csv)</label>
          <input id="dir-file" type="file" name="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <span className="hint">Columns: Email and Full name (required); Department, Group mailbox (yes/no) and Active (yes/no) optional. Only @altbank.ng addresses.</span>
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>How to import</legend>
          <label className="check">
            <input type="radio" name="mode" value="MERGE" checked={mode === "MERGE"} onChange={() => setMode("MERGE")} />
            <span><strong>Add and update</strong>: add new people and update existing ones; nobody is removed.</span>
          </label>
          <label className="check">
            <input type="radio" name="mode" value="REPLACE" checked={mode === "REPLACE"} onChange={() => setMode("REPLACE")} />
            <span><strong>Full replace</strong>: the file is the complete directory; anyone missing from it is marked inactive.</span>
          </label>
        </fieldset>
      </div>
      <div className="row">
        <button type="submit" name="intent" value="preview" className="btn btn-dark" disabled={pending}>
          <Eye className="icon" aria-hidden="true" /> {pending && intent === "preview" ? "Checking…" : "Preview changes"}
        </button>
        {s && !s.applied && s.errors.length === 0 && previewCurrent && (
          <button type="submit" name="intent" value="import" className="btn btn-primary" disabled={pending}>
            <Upload className="icon" aria-hidden="true" /> {pending && intent === "import" ? "Importing…" : `Import ${s.added + s.updated} change(s)${s.deactivated ? ` and deactivate ${s.deactivated}` : ""}`}
          </button>
        )}
      </div>
      <div ref={result} tabIndex={-1} aria-live="polite">
        {(localError || state.error) && (
          <div className="alert alert-error" role="alert">
            <AlertTriangle className="icon" aria-hidden="true" />
            <span>{localError ?? state.error}</span>
          </div>
        )}
        {s && !localError && (s.applied || previewCurrent) && (
          <div className="stack" style={{ marginTop: 8 }}>
            <div className={`alert ${s.applied ? "alert-success" : s.errors.length ? "alert-warn" : "alert-info"}`} role="status">
              {s.applied ? <CheckCircle2 className="icon" aria-hidden="true" /> : <Eye className="icon" aria-hidden="true" />}
              <span>
                {s.applied ? "Imported" : "Preview (not saved)"} · {s.filename} · {s.mode === "REPLACE" ? "full replace" : "add and update"} · {s.totalRows} row(s) read
                {Object.keys(s.columns).length > 0 && <> · columns used: {Object.entries(s.columns).map(([k, v]) => `${v} → ${k}`).join(", ")}</>}
              </span>
            </div>
            <div className="metric-grid">
              <div className="metric"><div className="k">New</div><div className="v">{s.added}</div></div>
              <div className="metric"><div className="k">Updated</div><div className="v">{s.updated}</div></div>
              <div className="metric"><div className="k">Unchanged</div><div className="v">{s.unchanged}</div></div>
              <div className="metric"><div className="k">Deactivated</div><div className="v">{s.deactivated}</div></div>
              <div className="metric"><div className="k">Rows with errors</div><div className="v">{s.errors.length}</div></div>
            </div>
            {s.errors.length > 0 && (
              <div className="card" style={{ margin: 0 }}>
                <h3>Fix these rows, then preview again (nothing is imported while errors remain)</h3>
                <ul className="small" style={{ margin: 0, paddingLeft: 18, maxHeight: 240, overflowY: "auto" }}>
                  {s.errors.slice(0, 200).map((e, i) => (
                    <li key={i}>Row {e.row}: {e.message}</li>
                  ))}
                  {s.errors.length > 200 && <li>… and {s.errors.length - 200} more</li>}
                </ul>
              </div>
            )}
            {s.staffNotInDirectory.length > 0 && (
              <div className="alert alert-warn">
                <AlertTriangle className="icon" aria-hidden="true" />
                <span>
                  {s.staffNotInDirectory.length} provisioned staff member(s) would be missing or inactive in the directory: {s.staffNotInDirectory.slice(0, 15).map((x) => `${x.fullName} (${x.email})`).join(", ")}
                  {s.staffNotInDirectory.length > 15 ? "…" : ""}. Their Work Desk access is not changed automatically; review them under Users &amp; roles and suspend anyone who has left.
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
