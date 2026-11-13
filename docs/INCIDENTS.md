# Incidents and the error experience

ARAF shows one of five approved, confident messages when something **technically** fails. Everyone hit by the same failure shares one incident reference (for example `ARAF-2026-0042`), and the five messages are shared out evenly between them.

## 1. What counts as an incident

| Shown as an incident | Shown as an ordinary, specific message (never an incident) |
|---|---|
| A page that crashes while loading | Validation (invalid phone number, wrong BVN length, missing fields) |
| A server action that fails unexpectedly | Missing permissions, wrong or expired sign-in code |
| A failed upload (server side) | Business rules and gates (credit check failed, stage not ready, already approved) |
| A lost response (network), a browser crash | Normal declines and rejections in the approval workflow |

The deciding line is in `src/app/_lib/action.ts` (`toActionError`): `DomainError`s are business outcomes and keep their own message. Next.js redirects pass straight through. Anything else is an incident.

## 2. The five messages

They live in **one** file, `src/lib/incident-messages.ts`, as final product copy. Do not edit the wording. The footer `ARAF • Built for ambition. Powered by brilliance.` is defined there too.

## 3. How users are assigned messages

- Each incident gets its own random order of the five messages (Fisher–Yates with `crypto.randomInt`), stored as `message_order`.
- The k-th affected user (k = 0, 1, 2, …) gets `message_order[k mod 5]`. After N users the counts differ by at most one, and which messages carry the extra users varies by incident.
  - 5 users → five different messages
  - 63 users → 13/13/13/12/12
  - 2,000 users → 400 each
  - 2,003 users → 401/401/401/400/400
- **Concurrency.** The incident row is locked (`SELECT … FOR UPDATE`) while a user is assigned. The assignment is unique on (incident, user) and on (incident, sequence), so simultaneous requests can't double-assign or unbalance the counts.
- **Who a user is.** A signed-in user is their staff id. Before sign-in it's a random per-browser id kept in an http-only cookie (`araf_eid`) and stored only as a hash. The same person always gets the same message for an incident: across refreshes, retries and new sessions.
- **The browser never picks the message.** The only browser-side choice is the fallback in section 7.

## 4. Correlation and lifecycle

- **Fingerprint.** A failure is identified by where it happened (the route with every id removed, e.g. `/requests/:id/edit`) and what failed (category, error type, database code, and the error message with every value stripped).
  - The same failure on different records joins one incident.
  - A different failure on the same screen, or the same failure on another screen, is a different incident. A shared HTTP status alone never merges failures.
  - Database outages (connection refused, too many clients…) are fingerprinted without the route, so one outage is one incident.
- **Correlation window.** A recurrence within `INCIDENT_CORRELATION_MINUTES` (default 30) of the last occurrence joins the open incident.
  - If an unacknowledged incident hasn't recurred within the window, it is marked Resolved ("No recurrence … (automatic)") and the next occurrence opens a new one.
  - An acknowledged (Investigating) incident keeps collecting occurrences until it is resolved.
- **Statuses:**
  - Detected → Investigating → Resolved → Closed
  - Detected → Resolved directly
  - Resolved → Investigating (reopen)
  - Closed is final.
  - A Super Admin changes status in **Administration → Incidents**. Each change is audited, and resolving needs a note.
  - Resolved and closed incidents take no new assignments; people already assigned keep their message. If the failure returns, a new incident opens.
- **What users are told, truthfully, under the message:**

  | State | Users see |
  |---|---|
  | Detected, not routed | "Issue detected." |
  | Detected, alert sent | "Issue detected and reported to the Digital Banking Team." |
  | Investigating | "The Digital Banking Team has acknowledged this issue and is investigating." (only after a Super Admin acknowledges it) |
  | Resolved | "This issue has been resolved. You can try again." |

- **Severity.**
  - It starts at Medium, at High for authentication, approvals, payments and disbursement, and at Critical for database outages.
  - It rises one level at 10 affected users and two levels at 50.

## 5. Alerts (routing)

Set `INCIDENT_ALERT_EMAILS` (comma-separated) to route incidents. Alerts go through the existing email outbox:
- one when an incident opens, and one each time its severity rises (deduplicated per incident and level);
- capped at `INCIDENT_ALERTS_PER_HOUR` (default 20) across all incidents, so a widespread outage can't flood the inbox. The dashboard always shows everything.

Without `INCIDENT_ALERT_EMAILS`, incidents are recorded but not routed, and users see "Issue detected." only.

## 6. Data protection

- No customer names, BVNs, account numbers, emails, documents, keys or server paths are stored or logged.
- Error messages are sanitised before storage:
  - emails, ids, quoted values, Postgres key values, numbers of 4+ digits, keys and tokens, and file paths are removed;
  - stack frames keep only the function name and `file:line`.
- Logs are one structured JSON line per event (`araf.incident.opened`, `…investigating`, `…resolved`, `…closed`, `…unrecorded`) with the reference, category, module, severity, fingerprint and counts only.
- The two upload APIs used to print the raw exception. They now go through the same sanitised path.
- Users never see stack traces, queries or internal details. The incident dashboard is Super Admin only.

## 7. Recovery and safety

| Where it failed | What the user can do |
|---|---|
| A page crashed | **Try again** re-renders the page (a read, always safe). **Back to Dashboard** goes to `/dashboard`. |
| A form's server action failed | The panel appears inside the form and the entries stay. **Try again** resubmits exactly what was sent, with the same idempotency key. The action's database transaction had already rolled back. |
| The response was lost (network) | The outcome is unknown, so there is no resubmit. **Check status** refreshes the page so the user can see whether it went through, and the entries stay. |
| An upload failed on the server | The file was not stored. **Retry upload** sends it again. |
| The incident service itself is down | The user still sees one of the approved messages, chosen consistently from the error. There is no reference, and the status says the issue could not be recorded. The rest of ARAF is unaffected. |

Existing safeguards are unchanged:
- idempotent submissions and task actions;
- locked approved terms;
- single-use stock reservations;
- verified payments.

The incident layer only changes how failures are reported, never how money or workflow state moves.

## 8. Code map

| Part | Where |
|---|---|
| Messages, status wording, fallback | `src/lib/incident-messages.ts` |
| Classification, fingerprinting, correlation, allocation, lifecycle, alerts | `src/server/incidents/index.ts` |
| Current user / anonymous id, recording for the current request | `src/server/incidents/subject.ts` |
| Server failures (render, route handlers, actions) by error digest | `src/instrumentation.ts` → `src/server/incidents/hook.ts` |
| Browser asks for its incident and message | `POST /api/incidents` (rate limited, works signed out) |
| Error screen, in-form panel, styles | `src/components/Incident.tsx` |
| Error boundaries | `src/app/(app)/error.tsx` (inside the app shell), `src/app/error.tsx`, `src/app/global-error.tsx` |
| Forms | `ActionForm` / `FormMessages` (`src/components/forms.tsx`), sign-in forms, both uploaders |
| Dashboard | `/admin/incidents` and `/admin/incidents/[id]` |
| Schema | `migrations/017_incidents.sql` |
| Tests | `tests/incidents.test.ts` (distribution, concurrency, correlation, lifecycle, alerts, data protection), `tests/incident-actions.test.ts` (business errors never become incidents) |

## 9. Known limits

- If a browser asks about a crashed page before the server hook has recorded it (it waits up to 1.5 s), that user's report is recorded as a browser-reported incident. The first user of a brand-new failure can then land in a separate incident from later users. The dashboard shows both.
- JSON APIs other than the two uploaders still return their existing error responses. The server hook records the incident, but those callers don't yet show the incident panel.
- "Try again" on a failed form assumes the action does its writes in one database transaction, which is how ARAF's actions are built. An action that calls an outside service before its own write (for example, a Paystack initialisation) may repeat that outside call. ARAF's provider calls are safe to repeat, because nothing is charged until the customer pays.
