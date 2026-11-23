# CRM — Complaints and Resolution Management

The CRM is built into ARAF. It uses ARAF's existing sign-in, roles, audit trail, notifications, email outbox, private file storage, malware scanning and background worker. It changes no financing data.

## Who can do what
| Person | What they get |
|---|---|
| **Every ARAF user** (RM, Team Lead, Delight Officer, Smile Associate, PM, Credit, UH, DH, BPM, Super Admin, …) | CRM Home, Raise Complaint, My Tickets. They can add information and files, reply to information requests, confirm a resolution (with an optional 1–5 rating) or reopen it. They see the public timeline only. |
| **Resolution Officer** (a member of a CRM team) | Assigned to Me (New, In Progress, Pending Information, Resolved). Start work, add updates or internal notes, request information, reassign to a colleague in the same team or transfer to another team (reason required), escalate, resolve with a summary and evidence. |
| **Team Lead / Queue Manager** (a team member with the lead role) | Team Queue: the Unassigned list, the whole team queue, officer workload and team performance. Can assign and reassign (reason required) and link related tickets. |
| **CX Head** (new `CX_HEAD` role) | CX Command Centre, All Complaints (search and filters), SLA Monitoring (overdue), Escalations, Team Performance, CX Reports (CSV and PDF), knowledge base publishing. Can override routing (reason required), ask a team to act, reopen tickets, and close resolved tickets. It carries no Super Admin or financing authority. |
| **Super Admin** | CRM configuration (Administration → CRM configuration). Read-only view of every ticket. |
| **CRM team member** (new `CRM_AGENT` role) | Only for staff who have no other ARAF role. It lets them sign in and work their CRM team's tickets, and grants nothing else. |

The roles are assigned in Users & roles; nobody receives them automatically. CRM team membership is set in CRM configuration → Teams. It never gives access to financing requests. A linked request opens only for people who could already open it, and a reference the complainant cannot open is stored as text.

## Raising a complaint
CRM → Raise Complaint. The complainant chooses the product (from the product registry, plus Altphones, Staff Salary Advance and ARAF Platform / General), then the category, then the specific issue. Issues for a particular product appear only when that product is chosen. They then enter the subject, description, an optional request reference and optional files (up to 5; PDF, PNG, JPG, DOCX or XLSX; scanned for malware). On a financing request page, **Raise a complaint** fills in the reference automatically.

ARAF then does the rest:
- It records the person, their role, the time and the reference **ARAF-CRM-000001**. References come from a database sequence, so they are unique even when submitted at the same moment. A repeated submission returns the ticket already created.
- It sets the priority from the issue's default, or from the matching routing rule. The complainant can tick "urgent"; this is recorded but does not override the priority.
- It routes the ticket and applies the SLA policy.
- It warns if a similar complaint is already open (same issue for the same request, or by the same person in the last 14 days). The complainant can open the existing ticket, or confirm the new one is a different issue.

## Routing
A rule matches when all the conditions it sets match: product, category, issue, and the workflow stage of the linked request. The most specific active rule wins. Complaints that match no rule go to the **fallback queue**. On install, this is a placeholder team called "Unrouted complaints (fallback queue)". Until it has a lead, every ticket that lands there alerts the CX Head and Super Admin. Nothing is ever dropped.

## Lifecycle
Statuses run: New → Unassigned → Assigned → In Progress ↔ Pending Information → Resolved → Closed. Reopened is used when a complainant reopens a ticket. Escalated is a separate flag, so the working status is kept.
- **Every change of owner is recorded as a separate hand-off entry** with the team, the officer, the start and end times, the reason and what ended it (assigned, reassigned, transferred, CX Head override or resolved). History is never rewritten, and the overall clock never restarts on a transfer or a reopening.
- **Resolve** needs a summary of at least 20 characters. The complainant then confirms (Closed) or says the issue persists (Reopened, back to the officer who resolved it, or to the team queue).
- **Closure policy:** by default only the complainant (or the CX Head) closes a ticket. Automatic closure happens only if the Super Admin explicitly sets a timeout.

## SLA and escalation
- **SLA policies:** assignment, first-response and resolution targets, set per product, category, issue, priority and/or team. The most specific policy applies. Each policy runs on business hours (working hours, working days and holidays, in Lagos time) or on a continuous clock. With no policy configured, the ticket shows "No target" and no deadline is invented.
- **Pausing:** if the Super Admin enables it, waiting for information from the complainant pauses the resolution clock, and the paused time extends the deadline.
- **Escalation rules:** awaiting assignment over N minutes; assigned but not started over N; resolution time used reaches N%; deadline exceeded by N; reassigned N times; critical ticket unresolved over N. Each rule fires **once per ticket**. It notifies the Team Lead and/or CX Head (in-app and email), marks the ticket escalated if set to, and is recorded on the timeline and in the audit trail. Officers can also escalate manually.

## Measurements
- **Each ticket** (Time measurements on the ticket page, for handlers and the CX Head): creation → routing, waiting for first assignment, first response, investigation (start of work → resolution), time waiting for information, total resolution time (elapsed), SLA-adjusted resolution time (business time less paused time), resolution → closure, SLA breach duration, reassignments and reopenings, plus the time held by each team and officer.
- **Team and officer handling time:** taken from the hand-off history. A ticket that moves through three teams adds each team's own time to that team; the final resolver is not charged for the others.

## CX Head reporting
- **Command Centre:** open, unassigned, in progress, pending, escalated and overdue counts right now. For the period: received, resolved, closed, reopened, escalated, average and median resolution time, SLA-adjusted resolution time, first response, team and officer handling time, SLA compliance and breach rates, reassignment and reopening rates, and satisfaction. Breakdowns by product, category, team, officer, priority, complainant location, day and top issues, plus the oldest unresolved complaints.
- **CX Reports:** yesterday, last week, last month or any date range, with CSV and PDF downloads (every export is audited). They include team and officer tables, repeat complaints and improvement points drawn only from the figures.
- **Scheduled reports:** turned on in CRM configuration → Report scheduling (daily, weekly on Monday, monthly on the 1st, at a chosen hour).
  - They go to active CX Heads and any extra recipients holding CX Head, Super Admin, Reporting Admin or Executive View.
  - Each period is sent once, and a run missed while the worker was down is sent later.
  - Emails go through the existing outbox; Administration → Email delivery shows whether the bank's mail transport sent them.

## Configuration (Super Admin)
CRM configuration has tabs for setup and calendar, complaint categories (and issues per product), teams, routing rules, SLA policies, escalation rules, report scheduling, and audit history. Every change:
- needs a reason;
- takes effect immediately with no maker-checker;
- is recorded in the audit trail with the previous and new values.

Existing tickets keep the category and issue names, team, priority and deadlines they were created with. The Setup tab lists any configuration still missing.

## Security
- **Access checks:** done on the server for every page, action and file read. Complainants never see internal notes or internal files. Ticket pages show only the request reference and stage, never customer records.
- **Attachments:** private, encrypted storage; file type checked against its contents; size limit; malware scan before release; links tied to the viewer and their session for 15 minutes; files served as sandboxed downloads.
- **Inputs and exports:** all inputs are validated with parameterised SQL; React escapes all output; CSV exports are protected against formula injection.
- **Abuse limits:** ticket creation is limited to 30 per person per hour.

## Database (migration 052)
- `crm_categories`, `crm_subcategories` (with the product each issue applies to), `crm_areas`
- `crm_teams`, `crm_team_members`, `crm_settings`
- `crm_routing_rules`, `crm_sla_policies`, `crm_escalation_rules`
- `crm_tickets`, `crm_assignments` (hand-off history), `crm_events` (timeline), `crm_attachments`, `crm_ticket_links`, `crm_escalation_hits`
- `crm_report_schedules`, `crm_report_runs`, `crm_kb_articles`

The initial nine categories and their issues, plus the product-specific issues, are loaded as editable data. No teams, people, routing rules, SLAs or escalation rules are created; the bank configures them.

## Needed before go-live (Super Admin)
1. Assign the **CX Head** role.
2. Create the resolution teams, add Team Leads and officers (give `CRM_AGENT` to anyone with no other ARAF role), and give the fallback queue a lead or point it at a real team.
3. Add routing rules, SLA policies (targets set by the bank) and escalation rules.
4. Set the working calendar and public holidays, and choose whether to pause the clock while waiting for information.
5. Turn on the report schedules.
6. The background worker must be running for escalations, timed closure and scheduled reports.
