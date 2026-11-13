"use client";
import Link from "next/link";
import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Eye, Upload, UserPlus } from "lucide-react";
import { bulkGrantAction, bulkStaffAction } from "../actions";
import type { BulkGrantResult, BulkStaffSummary } from "@/server/domain/admin";
import { ActionForm, SubmitButton, type FormState } from "@/components/forms";

const OUTCOME: Record<string, [string, string]> = { NEW: ["badge-green", "New"], EXISTS: ["", "Already provisioned"], ERROR: ["badge-red", "Problem"] };

/** Upload a list of names and emails → check it (nothing saved) → provision the new staff. */
export function StaffBulkUpload() {
  const [state, action, pending] = useActionState(bulkStaffAction, {});
  const [intent, setIntent] = useState("check");
  const [file, setFile] = useState<File | null>(null);
  const [addToDirectory, setAddToDirectory] = useState(false);
  const [checked, setChecked] = useState<{ file: File; add: boolean } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const router = useRouter();
  const result = useRef<HTMLDivElement>(null);
  const s = state.data as BulkStaffSummary | undefined;
  useEffect(() => {
    if (state.ok || state.error) result.current?.focus();
    if (s?.applied) router.refresh();
  }, [state, s, router]);
  const current = !!checked && checked.file === file && checked.add === addToDirectory;
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const next = submitter?.value === "provision" ? "provision" : "check";
    if (!file) return setLocalError("Choose the staff file first.");
    setLocalError(null);
    setIntent(next);
    if (next === "check") setChecked({ file, add: addToDirectory });
    const fd = new FormData();
    fd.set("intent", next);
    fd.set("file", file);
    if (addToDirectory) fd.set("addToDirectory", "on");
    startTransition(() => action(fd));
  };
  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="bulk-file">Staff list (.xlsx or .csv)</label>
          <input id="bulk-file" type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <span className="hint">
            Columns: Full name and Email (required); State and Business unit optional. Only @altbank.ng addresses. <a href="/api/admin/staff-template">Download the template</a>.
          </span>
        </div>
        <div className="field">
          <span className="label-like" style={{ fontWeight: 700, fontSize: 12.5 }}>Bank directory</span>
          <label className="check">
            <input type="checkbox" checked={addToDirectory} onChange={(e) => setAddToDirectory(e.target.checked)} />
            <span>
              Also add people who are not yet in the <Link href="/admin/directory">bank directory</Link>. Leave unticked to provision only verified directory entries.
            </span>
          </label>
        </div>
      </div>
      <div className="row">
        <button type="submit" value="check" className="btn btn-dark" disabled={pending}>
          <Eye className="icon" aria-hidden="true" /> {pending && intent === "check" ? "Checking…" : "Check file"}
        </button>
        {s && !s.applied && s.toCreate > 0 && current && (
          <button type="submit" value="provision" className="btn btn-primary" disabled={pending}>
            <UserPlus className="icon" aria-hidden="true" /> {pending && intent === "provision" ? "Provisioning…" : `Provision ${s.toCreate} staff`}
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
        {s && !localError && (s.applied || current) && (
          <div className="stack" style={{ marginTop: 8 }}>
            <div className={`alert ${s.applied ? "alert-success" : s.errors ? "alert-warn" : "alert-info"}`} role="status">
              {s.applied ? <CheckCircle2 className="icon" aria-hidden="true" /> : <Eye className="icon" aria-hidden="true" />}
              <span>
                {s.applied ? (
                  <>
                    Provisioned {s.created} staff from {s.filename}. They have no roles yet:{" "}
                    <Link href="/admin/staff?show=noroles#assign">show staff without roles</Link> to assign them.
                  </>
                ) : (
                  <>
                    Checked {s.filename} (nothing saved yet) · {s.totalRows} row{s.totalRows === 1 ? "" : "s"}
                    {s.errors > 0 && " · rows with problems are skipped and listed below"}
                  </>
                )}
              </span>
            </div>
            <div className="metric-grid">
              <div className="metric">
                <div className="k">{s.applied ? "Provisioned" : "New staff"}</div>
                <div className="v">{s.applied ? s.created : s.toCreate}</div>
              </div>
              <div className="metric">
                <div className="k">Already provisioned</div>
                <div className="v">{s.existing}</div>
              </div>
              <div className="metric">
                <div className="k">Added to directory</div>
                <div className="v">{s.addsToDirectory}</div>
              </div>
              <div className="metric">
                <div className="k">Rows with problems</div>
                <div className="v">{s.errors}</div>
              </div>
            </div>
            <div className="table-wrap" style={{ maxHeight: 340, overflowY: "auto" }}>
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Name</th>
                    <th scope="col">Email</th>
                    <th scope="col">State / unit</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {[...s.rows.filter((r) => r.outcome === "ERROR"), ...s.rows.filter((r) => r.outcome !== "ERROR")].slice(0, 300).map((r) => (
                    <tr key={r.row}>
                      <td className="small">{r.row}</td>
                      <td>{r.fullName || "—"}</td>
                      <td className="small">{r.email || "—"}</td>
                      <td className="small">
                        {r.region ?? "—"}
                        {r.businessUnit ? ` · ${r.businessUnit}` : ""}
                      </td>
                      <td>
                        <span className={`badge ${OUTCOME[r.outcome][0]}`}>{OUTCOME[r.outcome][1]}</span>
                        {r.addsToDirectory && <span className="small muted"> · added to directory</span>}
                        {r.message && r.outcome === "ERROR" && <div className="small err">{r.message}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {s.rows.length > 300 && <p className="small muted">Showing the first 300 rows (problems first).</p>}
          </div>
        )}
      </div>
      {!s && (
        <p className="small muted" style={{ margin: 0 }}>
          <Upload className="icon" aria-hidden="true" /> Nothing is saved until you check the file and confirm. No roles are granted by the upload.
        </p>
      )}
    </form>
  );
}

/** "Select all" for the staff list's tick boxes. */
export function SelectAllStaff() {
  return (
    <input
      type="checkbox"
      aria-label="Select all staff shown"
      onChange={(e) => {
        const form = e.currentTarget.form;
        form?.querySelectorAll<HTMLInputElement>('input[name="staffId"]').forEach((c) => (c.checked = e.currentTarget.checked));
      }}
    />
  );
}

/** The bulk role bar plus the staff table (passed in as children); shows who could not be assigned. */
export function BulkAssign({ roles, regions, count, children }: { roles: { value: string; label: string }[]; regions: string[]; count: number; children: React.ReactNode }) {
  return (
    <ActionForm action={bulkGrantAction} className="stack" resetOnSuccess>
      {(state: FormState) => (
        <>
          <div className="bulk-assign">
            <div className="field">
              <label htmlFor="bulk-role">Assign role to ticked staff</label>
              <select id="bulk-role" name="role" required defaultValue="">
                <option value="" disabled>
                  Choose a role
                </option>
                {roles.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="bulk-region">State (if the role needs one)</label>
              <select id="bulk-region" name="region" defaultValue="">
                <option value="">Keep each person&rsquo;s state</option>
                {regions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="bulk-team">Team (RMs and Team Leads)</label>
              <input id="bulk-team" name="team" placeholder="e.g. RETAIL-LAGOS-1" />
            </div>
            <SubmitButton>Assign to selected</SubmitButton>
          </div>
          {(state.data as BulkGrantResult | undefined)?.failed?.length ? (
            <div className="alert alert-warn" role="status">
              <span>
                <strong>Not assigned:</strong> {(state.data as BulkGrantResult).failed.map((f) => `${f.name} (${f.message})`).join("; ")}
              </span>
            </div>
          ) : null}
          <p className="small muted" style={{ margin: 0 }}>
            {count} staff shown. Tick the people to assign, or tick the box in the header to select everyone shown.
          </p>
          {children}
        </>
      )}
    </ActionForm>
  );
}
