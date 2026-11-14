"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { trackerSwitchAction } from "./actions";

export function TrackerSwitch({ enabled }: { enabled: boolean }) {
  return (
    <ActionForm action={trackerSwitchAction}>
      <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
      <div className="row">
        <input name="reason" placeholder="Reason for the change" aria-label="Reason for the change" />
        <span>
          Tracker is <strong>{enabled ? "on" : "off"}</strong> for other users.
        </span>
        <SubmitButton className={enabled ? "btn btn-sm" : "btn btn-primary btn-sm"}>{enabled ? "Turn off" : "Turn on"}</SubmitButton>
      </div>
    </ActionForm>
  );
}
