"use client";
import { useEffect, useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { tlPhotoSkipAction, tlPhotoUploadAction } from "../retail-actions";

/**
 * Team Lead business photograph verification (Vendor Financing). Choose an existing photograph from the
 * gallery or files (the camera is never opened), or skip with a reason. Either choice lets the review continue.
 */
export function PhotoVerification({ applicationId, minReason }: { applicationId: string; minReason: number }) {
  const [mode, setMode] = useState<"UPLOAD" | "SKIP" | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  return (
    <div className="stack">
      <fieldset className="choice-row" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small" style={{ marginBottom: 6 }}>Choose one</legend>
        <label className="check">
          <input type="radio" name="photoMode" checked={mode === "UPLOAD"} onChange={() => setMode("UPLOAD")} /> Upload a photograph of the business
        </label>
        <label className="check">
          <input type="radio" name="photoMode" checked={mode === "SKIP"} onChange={() => setMode("SKIP")} /> Skip photograph upload
        </label>
      </fieldset>
      {mode === "UPLOAD" && (
        <ActionForm action={tlPhotoUploadAction} encType="multipart/form-data">
          {(st) => (
            <>
              <input type="hidden" name="applicationId" value={applicationId} />
              <div className="field">
                <label htmlFor="tl-photo">Photograph (from your gallery or files)</label>
                {/* No `capture` attribute: phones offer the gallery and files, not only the camera. */}
                <input
                  id="tl-photo"
                  name="photo"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                  aria-invalid={!!st.fields?.photo}
                  onChange={(e) => {
                    const f = e.currentTarget.files?.[0];
                    if (preview) URL.revokeObjectURL(preview);
                    setPreview(f ? URL.createObjectURL(f) : null);
                  }}
                />
                {st.fields?.photo && <p className="err">{st.fields.photo}</p>}
              </div>
              {preview && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview} alt="Selected business photograph (preview)" style={{ maxWidth: "100%", maxHeight: 260, borderRadius: 8, border: "1px solid var(--line)", objectFit: "contain" }} />
              )}
              <label className="check">
                <input type="checkbox" name="confirmed" /> This photograph shows the business presented by the Relationship Manager.
              </label>
              {st.fields?.confirmed && <p className="err">{st.fields.confirmed}</p>}
              <div>
                <SubmitButton>Upload photograph</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
      {mode === "SKIP" && (
        <ActionForm action={tlPhotoSkipAction}>
          {(st) => (
            <>
              <input type="hidden" name="applicationId" value={applicationId} />
              <div className="field">
                <label htmlFor="tl-skip">Reason for Not Uploading Business Photograph</label>
                <textarea id="tl-skip" name="skipReason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={!!st.fields?.skipReason} aria-describedby="tl-skip-hint" />
                <p id="tl-skip-hint" className="hint">Required. The Unit Head is notified and sees this reason before deciding.</p>
                {st.fields?.skipReason && <p className="err">{st.fields.skipReason}</p>}
              </div>
              <div>
                <SubmitButton disabled={reason.replace(/\s+/g, " ").trim().length < minReason}>Skip with this reason</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </div>
  );
}
