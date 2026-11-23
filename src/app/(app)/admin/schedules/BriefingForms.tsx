"use client";
import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { briefingSwitchAction, briefingTestAction } from "./briefing-actions";

export function BriefingControls({ enabled, officers }: { enabled: boolean; officers: { id: string; label: string }[] }) {
  const [who, setWho] = useState(officers[0]?.id ?? "");
  return (
    <div className="stack">
      <ActionForm action={briefingSwitchAction} className="row">
        <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
        <SubmitButton className={enabled ? "btn" : "btn btn-primary"}>{enabled ? "Switch personal briefings off" : "Switch personal briefings on"}</SubmitButton>
      </ActionForm>
      {officers.length > 0 ? (
        <div className="stack">
          <div className="field" style={{ maxWidth: 420 }}>
            <label htmlFor="br-who">Preview or test the briefing of</label>
            <select id="br-who" value={who} onChange={(e) => setWho(e.target.value)}>
              {officers.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <a className="btn" href={`/admin/schedules/briefing-preview?staff=${who}`} target="_blank" rel="noopener noreferrer">
              Preview (opens a new tab)
            </a>
            <ActionForm action={briefingTestAction} className="row">
              <input type="hidden" name="staffId" value={who} />
              <SubmitButton className="btn btn-ghost">Send this test to me</SubmitButton>
            </ActionForm>
          </div>
        </div>
      ) : (
        <p className="small muted">No originating officer is profiled yet.</p>
      )}
    </div>
  );
}
