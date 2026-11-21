"use client";
import { useState, type ReactNode } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { ticketAction } from "../../actions";

function Op({ op, id, lockVersion, children, multipart }: { op: string; id: string; lockVersion?: number; children: ReactNode; multipart?: boolean }) {
  return (
    <ActionForm action={ticketAction} className="stack" resetOnSuccess encType={multipart ? "multipart/form-data" : undefined}>
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="ticketId" value={id} />
      {lockVersion !== undefined && <input type="hidden" name="lockVersion" value={lockVersion} />}
      {children}
    </ActionForm>
  );
}

/** A collapsed panel opened on demand (keeps the action column short). */
function Fold({ label, children, open: initial = false, danger }: { label: string; children: ReactNode; open?: boolean; danger?: boolean }) {
  const [open, setOpen] = useState(initial);
  if (!open)
    return (
      <button type="button" className={`btn btn-block ${danger ? "btn-danger" : ""}`} onClick={() => setOpen(true)}>
        {label}…
      </button>
    );
  return (
    <div className="card stack" style={{ padding: "var(--space-3)" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{label}</strong>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      {children}
    </div>
  );
}

const files = (id: string) => (
  <div className="field">
    <label htmlFor={id}>Attach files (optional, up to 5)</label>
    <input id={id} type="file" name="files" multiple accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx" />
  </div>
);

export interface ActionProps {
  id: string;
  lockVersion: number;
  status: string;
  isCreator: boolean;
  isAssignee: boolean;
  canManage: boolean;
  /** The assigned officer handing the ticket to a colleague in the same team. */
  canHandOn?: boolean;
  canWork: boolean;
  isCxHead: boolean;
  isMember: boolean;
  officers: { id: string; name: string; role: string }[];
  teams: { id: string; name: string }[];
  currentAssignee: string | null;
}

export function TicketActions(p: ActionProps) {
  const open = !["RESOLVED", "CLOSED"].includes(p.status);
  const blocks: ReactNode[] = [];

  if (p.canHandOn && open)
    blocks.push(
      <Fold key="handon" label="Reassign to a colleague">
        <Op op="assign" id={p.id} lockVersion={p.lockVersion}>
          <div className="field">
            <label htmlFor="ho-off">Colleague in this team</label>
            <select id="ho-off" name="officerId" required defaultValue="">
              <option value="">Choose…</option>
              {p.officers
                .filter((o) => o.id !== p.currentAssignee)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ho-why">Reason (required)</label>
            <textarea id="ho-why" name="reason" rows={2} required minLength={10} />
          </div>
          <div>
            <SubmitButton>Reassign</SubmitButton>
          </div>
        </Op>
      </Fold>,
    );

  if (p.canManage && open)
    blocks.push(
      <div key="assign" className="card stack">
        <h2 style={{ fontSize: 15 }}>{p.currentAssignee ? "Reassign" : "Assign to an officer"}</h2>
        <Op op="assign" id={p.id} lockVersion={p.lockVersion}>
          <div className="field">
            <label htmlFor="as-off">Officer</label>
            <select id="as-off" name="officerId" required defaultValue="">
              <option value="">Choose…</option>
              {p.officers
                .filter((o) => o.id !== p.currentAssignee)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} {o.role === "LEAD" ? "(Team Lead)" : ""}
                  </option>
                ))}
            </select>
          </div>
          {p.currentAssignee && (
            <div className="field">
              <label htmlFor="as-why">Reason for reassigning</label>
              <textarea id="as-why" name="reason" rows={2} required minLength={10} />
            </div>
          )}
          <div>
            <SubmitButton>{p.currentAssignee ? "Reassign" : "Assign"}</SubmitButton>
          </div>
        </Op>
      </div>,
    );

  if (p.isAssignee && ["ASSIGNED", "REOPENED"].includes(p.status))
    blocks.push(
      <Op key="start" op="start" id={p.id} lockVersion={p.lockVersion}>
        <SubmitButton className="btn btn-primary btn-block">Start work</SubmitButton>
      </Op>,
    );

  if (p.canWork && open)
    blocks.push(
      <div key="work" className="stack" style={{ gap: 8 }}>
        <Fold label="Add update" open>
          <Op op="update" id={p.id} multipart>
            <div className="field">
              <label htmlFor="up-body">Update</label>
              <textarea id="up-body" name="body" rows={3} maxLength={5000} placeholder="Investigation progress" />
            </div>
            {files("up-files")}
            <label className="check">
              <input type="checkbox" name="internal" /> Internal note (not shown to the complainant)
            </label>
            <div>
              <SubmitButton>Add update</SubmitButton>
            </div>
          </Op>
        </Fold>
        {["ASSIGNED", "IN_PROGRESS", "REOPENED"].includes(p.status) && (
          <Fold label="Request information">
            <Op op="info" id={p.id} lockVersion={p.lockVersion}>
              <div className="field">
                <label htmlFor="in-q">What do you need from the complainant?</label>
                <textarea id="in-q" name="question" rows={3} required minLength={10} />
              </div>
              <div>
                <SubmitButton>Send request</SubmitButton>
              </div>
            </Op>
          </Fold>
        )}
        {p.currentAssignee && (
          <Fold label="Mark resolved">
            <Op op="resolve" id={p.id} lockVersion={p.lockVersion} multipart>
              <div className="field">
                <label htmlFor="rs-sum">Resolution summary: the action taken and the outcome</label>
                <textarea id="rs-sum" name="summary" rows={4} required minLength={20} />
              </div>
              {files("rs-files")}
              <div>
                <SubmitButton>Mark resolved</SubmitButton>
              </div>
            </Op>
          </Fold>
        )}
        <Fold label="Transfer to another team">
          <Op op="transfer" id={p.id} lockVersion={p.lockVersion}>
            <div className="field">
              <label htmlFor="tr-team">Receiving team</label>
              <select id="tr-team" name="teamId" required defaultValue="">
                <option value="">Choose…</option>
                {p.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="tr-why">Reason (required)</label>
              <textarea id="tr-why" name="reason" rows={2} required minLength={10} />
            </div>
            <div>
              <SubmitButton>{p.isCxHead && !p.isMember ? "Override routing" : "Transfer"}</SubmitButton>
            </div>
          </Op>
        </Fold>
        <Fold label="Escalate" danger>
          <Op op="escalate" id={p.id}>
            <div className="field">
              <label htmlFor="es-why">Why does this need escalation?</label>
              <textarea id="es-why" name="reason" rows={2} required minLength={10} />
            </div>
            <div>
              <SubmitButton className="btn btn-danger">Escalate to Team Lead and CX Head</SubmitButton>
            </div>
          </Op>
        </Fold>
      </div>,
    );

  if (p.isCreator && p.status !== "CLOSED" && !p.canWork)
    blocks.push(
      <div key="info" className="card stack">
        <h2 style={{ fontSize: 15 }}>{p.status === "PENDING_INFO" ? "Reply with the information requested" : "Add information"}</h2>
        <Op op="update" id={p.id} multipart>
          <div className="field">
            <label htmlFor="ci-body">Message</label>
            <textarea id="ci-body" name="body" rows={3} maxLength={5000} />
          </div>
          {files("ci-files")}
          <div>
            <SubmitButton>Send</SubmitButton>
          </div>
        </Op>
      </div>,
    );

  if (p.isCreator && p.status === "RESOLVED")
    blocks.push(
      <div key="confirm" className="card stack">
        <h2 style={{ fontSize: 15 }}>Is the issue resolved?</h2>
        <Op op="confirm" id={p.id}>
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small">How satisfied are you? (optional)</legend>
            <div className="row" style={{ gap: 12 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <label key={n} className="check" style={{ alignItems: "center" }}>
                  <input type="radio" name="score" value={n} /> {n}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="field">
            <label htmlFor="cf-c">Comment (optional)</label>
            <input id="cf-c" name="comment" maxLength={1000} />
          </div>
          <div>
            <SubmitButton>Yes, it is resolved</SubmitButton>
          </div>
        </Op>
      </div>,
    );

  if ((p.isCreator || p.isCxHead) && ["RESOLVED", "CLOSED"].includes(p.status))
    blocks.push(
      <Fold key="reopen" label="The issue persists: reopen" danger>
        <Op op="reopen" id={p.id}>
          <div className="field">
            <label htmlFor="ro-why">What is still wrong?</label>
            <textarea id="ro-why" name="reason" rows={3} required minLength={10} />
          </div>
          <div>
            <SubmitButton className="btn btn-danger">Reopen</SubmitButton>
          </div>
        </Op>
      </Fold>,
    );

  if (p.isCxHead) {
    blocks.push(
      <Fold key="act" label="Request action from the team">
        <Op op="action" id={p.id}>
          <div className="field">
            <label htmlFor="ra-m">Message to the Team Lead</label>
            <textarea id="ra-m" name="message" rows={2} required minLength={10} />
          </div>
          <div>
            <SubmitButton>Send</SubmitButton>
          </div>
        </Op>
      </Fold>,
    );
    if (p.status === "RESOLVED")
      blocks.push(
        <Fold key="cxclose" label="Close (CX Head)">
          <Op op="cxclose" id={p.id}>
            <div className="field">
              <label htmlFor="cc-why">Reason</label>
              <textarea id="cc-why" name="reason" rows={2} required minLength={10} />
            </div>
            <div>
              <SubmitButton>Close ticket</SubmitButton>
            </div>
          </Op>
        </Fold>,
      );
  }

  if (p.canManage || p.isCxHead)
    blocks.push(
      <Fold key="link" label="Link a related ticket">
        <Op op="link" id={p.id}>
          <div className="field">
            <label htmlFor="ln-ref">Ticket reference</label>
            <input id="ln-ref" name="otherRef" required placeholder="ARAF-CRM-000001" />
          </div>
          <label className="check">
            <input type="checkbox" name="asParent" /> Make it this ticket&apos;s parent (one incident affecting several requests or users)
          </label>
          <div>
            <SubmitButton>Link</SubmitButton>
          </div>
        </Op>
      </Fold>,
    );

  if (!blocks.length) return <p className="small muted">No actions are available to you on this ticket.</p>;
  return <div className="stack">{blocks}</div>;
}
