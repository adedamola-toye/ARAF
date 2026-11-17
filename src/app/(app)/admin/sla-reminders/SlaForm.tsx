"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { saveSlaPolicyAction } from "./actions";

const DAYS: [number, string][] = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]];

export interface SlaFormValues {
  reminderHours: string;
  repeatHours: string;
  hourMode: string;
  workingStart: number;
  workingEnd: number;
  workingDays: number[];
  holidays: string;
  queues: { key: string; label: string; on: boolean }[];
  ccEmails: string;
  subjectTemplate: string;
  bodyTemplate: string;
  enabled: boolean;
}

export function SlaForm({ v }: { v: SlaFormValues }) {
  return (
    <ActionForm action={saveSlaPolicyAction}>
      {(st) => (
        <>
          <label className="check">
            <input type="checkbox" name="enabled" defaultChecked={v.enabled} />
            <span>Send SLA reminders</span>
          </label>
          <div className="grid-3">
            <div className="field">
              <label htmlFor="sla-h">Remind after (hours)</label>
              <input id="sla-h" name="reminderHours" inputMode="decimal" defaultValue={v.reminderHours} required />
              {st.fields?.reminderHours && <span className="err">{st.fields.reminderHours}</span>}
            </div>
            <div className="field">
              <label htmlFor="sla-r">Repeat every (hours, optional)</label>
              <input id="sla-r" name="repeatHours" inputMode="decimal" defaultValue={v.repeatHours} placeholder="No repeat" />
              {st.fields?.repeatHours && <span className="err">{st.fields.repeatHours}</span>}
            </div>
            <div className="field">
              <label htmlFor="sla-m">Count</label>
              <select id="sla-m" name="hourMode" defaultValue={v.hourMode}>
                <option value="CALENDAR">Continuous (calendar) hours</option>
                <option value="WORKING">Working hours only</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="sla-ws">Working day starts (hour)</label>
              <input id="sla-ws" name="workingStart" type="number" min={0} max={23} defaultValue={v.workingStart} />
            </div>
            <div className="field">
              <label htmlFor="sla-we">Working day ends (hour)</label>
              <input id="sla-we" name="workingEnd" type="number" min={1} max={24} defaultValue={v.workingEnd} />
              {st.fields?.workingEnd && <span className="err">{st.fields.workingEnd}</span>}
            </div>
          </div>
          <fieldset className="ps-checks">
            <legend>Working days</legend>
            <div className="ps-check-row">
              {DAYS.map(([d, l]) => (
                <label key={d} className="check small">
                  <input type="checkbox" name="workingDays" value={d} defaultChecked={v.workingDays.includes(d)} />
                  <span>{l}</span>
                </label>
              ))}
            </div>
            {st.fields?.workingDays && <span className="err">{st.fields.workingDays}</span>}
          </fieldset>
          <div className="field">
            <label htmlFor="sla-hol">Public holidays (YYYY-MM-DD, one per line)</label>
            <textarea id="sla-hol" name="holidays" rows={3} defaultValue={v.holidays} />
            {st.fields?.holidays && <span className="err">{st.fields.holidays}</span>}
          </div>
          <fieldset className="ps-checks">
            <legend>Queues reminded</legend>
            <div className="ps-check-row">
              {v.queues.map((q) => (
                <label key={q.key} className="check small">
                  <input type="checkbox" name={`queue_${q.key}`} defaultChecked={q.on} />
                  <span>{q.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="field">
            <label htmlFor="sla-cc">Also copy (emails, optional)</label>
            <input id="sla-cc" name="ccEmails" defaultValue={v.ccEmails} placeholder="supervisor@altbank.ng" />
            {st.fields?.ccEmails && <span className="err">{st.fields.ccEmails}</span>}
          </div>
          <div className="field">
            <label htmlFor="sla-sub">Email subject</label>
            <input id="sla-sub" name="subjectTemplate" defaultValue={v.subjectTemplate} />
          </div>
          <div className="field">
            <label htmlFor="sla-body">Email body</label>
            <textarea id="sla-body" name="bodyTemplate" rows={14} defaultValue={v.bodyTemplate} className="mono" />
            <span className="hint">Placeholders: [Officer Name], [Customer Name], [Reference], [Facility Reference], [Product], [Action], [Date and Time], [Secure Link to Request]</span>
          </div>
          <div className="field">
            <label htmlFor="sla-reason">Reason for the change</label>
            <textarea id="sla-reason" name="reason" rows={2} required minLength={20} />
            {st.fields?.reason && <span className="err">{st.fields.reason}</span>}
          </div>
          <div>
            <SubmitButton>Save SLA reminder settings</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
