-- CRM: complaints and resolution management.
-- Every authorised ARAF user may raise a complaint. Tickets are routed by configurable rules to a team
-- (never discarded: unmatched complaints go to the configured fallback queue), assigned by the team's lead,
-- worked by officers and resolved; the complainant confirms or reopens. Every hand-off is an immutable
-- assignment segment so handling time is attributed to each team and officer. Nothing here changes
-- existing financing data.

-- ------------------------------------------------------------------ catalogue
CREATE TABLE crm_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  name         text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  description  text,
  active       boolean NOT NULL DEFAULT true,
  sort_order   int NOT NULL DEFAULT 100,
  updated_by   uuid REFERENCES staff(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- product_code NULL = the issue applies to every product; otherwise it is shown only for that product.
CREATE TABLE crm_subcategories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id      uuid NOT NULL REFERENCES crm_categories(id),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  product_code     text,
  default_priority text NOT NULL DEFAULT 'NORMAL' CHECK (default_priority IN ('LOW','NORMAL','HIGH','CRITICAL')),
  active           boolean NOT NULL DEFAULT true,
  sort_order       int NOT NULL DEFAULT 100,
  updated_by       uuid REFERENCES staff(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crm_subcategories_uq ON crm_subcategories(category_id, lower(name), coalesce(product_code, ''));

-- Product / platform areas offered on the form in addition to the financing products registry.
CREATE TABLE crm_areas (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 100
);
INSERT INTO crm_areas (code, name, sort_order) VALUES
  ('ALTPHONES', 'Altphones', 50),
  ('STAFF_SALARY_ADVANCE', 'Staff Salary Advance', 60),
  ('PLATFORM', 'ARAF Platform / General', 90);

-- ------------------------------------------------------------------ teams
CREATE TABLE crm_teams (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  description  text,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES staff(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crm_teams_name_uq ON crm_teams(lower(name));

CREATE TABLE crm_team_members (
  team_id      uuid NOT NULL REFERENCES crm_teams(id),
  staff_id     uuid NOT NULL REFERENCES staff(id),
  member_role  text NOT NULL CHECK (member_role IN ('LEAD','OFFICER')),
  active       boolean NOT NULL DEFAULT true,
  added_by     uuid REFERENCES staff(id),
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, staff_id)
);
CREATE INDEX crm_team_members_staff_idx ON crm_team_members(staff_id) WHERE active;

-- A placeholder queue so no complaint is ever lost before the bank configures its teams. It has no members;
-- the CX Head and Super Admin see it and are alerted when tickets land in it.
INSERT INTO crm_teams (id, name, description) VALUES
  ('00000000-0000-4000-8000-00000000c0de', 'Unrouted complaints (fallback queue)', 'Receives complaints no routing rule matches. Add a Team Lead or point the fallback to another team in CRM configuration.');

-- ------------------------------------------------------------------ settings, routing, SLA, escalation
CREATE TABLE crm_settings (
  id                   int PRIMARY KEY CHECK (id = 1),
  fallback_team_id     uuid NOT NULL REFERENCES crm_teams(id),
  -- CONFIRMATION: only the complainant (or CX Head) closes. TIMEOUT: also closes automatically after closure_timeout_hours.
  closure_policy       text NOT NULL DEFAULT 'CONFIRMATION' CHECK (closure_policy IN ('CONFIRMATION','TIMEOUT')),
  closure_timeout_hours int CHECK (closure_timeout_hours IS NULL OR closure_timeout_hours BETWEEN 1 AND 2160),
  working_start        int NOT NULL DEFAULT 8 CHECK (working_start BETWEEN 0 AND 23),
  working_end          int NOT NULL DEFAULT 17 CHECK (working_end BETWEEN 1 AND 24),
  working_days         int[] NOT NULL DEFAULT '{1,2,3,4,5}',
  holidays             date[] NOT NULL DEFAULT '{}',
  pause_on_pending_info boolean NOT NULL DEFAULT false,
  updated_by           uuid REFERENCES staff(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (working_start < working_end),
  CHECK (closure_policy = 'CONFIRMATION' OR closure_timeout_hours IS NOT NULL)
);
INSERT INTO crm_settings (id, fallback_team_id) VALUES (1, '00000000-0000-4000-8000-00000000c0de');

-- A rule matches when every non-null criterion matches; the most specific active rule wins.
CREATE TABLE crm_routing_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code     text,
  category_id      uuid REFERENCES crm_categories(id),
  subcategory_id   uuid REFERENCES crm_subcategories(id),
  stage            text,
  team_id          uuid NOT NULL REFERENCES crm_teams(id),
  priority_override text CHECK (priority_override IN ('LOW','NORMAL','HIGH','CRITICAL')),
  active           boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES staff(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm_sla_policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  product_code          text,
  category_id           uuid REFERENCES crm_categories(id),
  subcategory_id        uuid REFERENCES crm_subcategories(id),
  priority              text CHECK (priority IN ('LOW','NORMAL','HIGH','CRITICAL')),
  team_id               uuid REFERENCES crm_teams(id),
  assignment_minutes    int CHECK (assignment_minutes > 0),
  first_response_minutes int CHECK (first_response_minutes > 0),
  resolution_minutes    int CHECK (resolution_minutes > 0),
  business_hours        boolean NOT NULL DEFAULT true,
  active                boolean NOT NULL DEFAULT true,
  created_by            uuid REFERENCES staff(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (assignment_minutes IS NOT NULL OR first_response_minutes IS NOT NULL OR resolution_minutes IS NOT NULL)
);

CREATE TABLE crm_escalation_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger          text NOT NULL CHECK (trigger IN ('UNASSIGNED_OVER','NOT_STARTED_OVER','APPROACHING_BREACH','RESOLUTION_BREACHED','REASSIGNED_TIMES','CRITICAL_OPEN_OVER')),
  threshold        int NOT NULL CHECK (threshold > 0),
  notify_team_lead boolean NOT NULL DEFAULT true,
  notify_cx_head   boolean NOT NULL DEFAULT true,
  mark_escalated   boolean NOT NULL DEFAULT true,
  active           boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES staff(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ tickets
CREATE SEQUENCE crm_ticket_seq START 1;

CREATE TABLE crm_tickets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                 bigint NOT NULL UNIQUE,
  ref                 text NOT NULL UNIQUE,
  idempotency_key     text NOT NULL,
  creator_id          uuid NOT NULL REFERENCES staff(id),
  creator_role        text,
  product_code        text NOT NULL,
  product_name        text NOT NULL,
  category_id         uuid NOT NULL REFERENCES crm_categories(id),
  subcategory_id      uuid NOT NULL REFERENCES crm_subcategories(id),
  category_name       text NOT NULL,
  subcategory_name    text NOT NULL,
  subject             text NOT NULL CHECK (length(subject) BETWEEN 5 AND 150),
  description         text NOT NULL CHECK (length(description) BETWEEN 10 AND 5000),
  application_id      uuid REFERENCES applications(id),
  related_ref         text,
  application_stage   text,
  priority            text NOT NULL CHECK (priority IN ('LOW','NORMAL','HIGH','CRITICAL')),
  complainant_urgent  boolean NOT NULL DEFAULT false,
  status              text NOT NULL CHECK (status IN ('NEW','UNASSIGNED','ASSIGNED','IN_PROGRESS','PENDING_INFO','RESOLVED','CLOSED','REOPENED')),
  escalated           boolean NOT NULL DEFAULT false,
  escalated_at        timestamptz,
  team_id             uuid NOT NULL REFERENCES crm_teams(id),
  assignee_id         uuid REFERENCES staff(id),
  routing             jsonb NOT NULL DEFAULT '{}',
  sla_policy_id       uuid REFERENCES crm_sla_policies(id),
  sla_business_hours  boolean,
  assignment_due      timestamptz,
  first_response_due  timestamptz,
  resolution_due      timestamptz,
  sla_paused_ms       bigint NOT NULL DEFAULT 0,
  paused_at           timestamptz,
  routed_at           timestamptz,
  first_assigned_at   timestamptz,
  first_response_at   timestamptz,
  started_at          timestamptz,
  resolved_at         timestamptz,
  resolved_by         uuid REFERENCES staff(id),
  resolution_summary  text,
  closed_at           timestamptz,
  closed_by           uuid REFERENCES staff(id),
  closed_how          text CHECK (closed_how IN ('CONFIRMED','TIMEOUT','CX_HEAD')),
  reopen_count        int NOT NULL DEFAULT 0,
  reassign_count      int NOT NULL DEFAULT 0,
  parent_id           uuid REFERENCES crm_tickets(id),
  satisfaction        int CHECK (satisfaction BETWEEN 1 AND 5),
  satisfaction_comment text,
  lock_version        int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  UNIQUE (creator_id, idempotency_key)
);
CREATE INDEX crm_tickets_creator_idx ON crm_tickets(creator_id, created_at DESC);
CREATE INDEX crm_tickets_team_idx ON crm_tickets(team_id, status);
CREATE INDEX crm_tickets_assignee_idx ON crm_tickets(assignee_id, status);
CREATE INDEX crm_tickets_app_idx ON crm_tickets(application_id) WHERE application_id IS NOT NULL;
CREATE INDEX crm_tickets_created_idx ON crm_tickets(created_at);

-- Immutable hand-off history. Exactly one open segment (ended_at IS NULL) per ticket while it is not closed.
CREATE TABLE crm_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     uuid NOT NULL REFERENCES crm_tickets(id),
  team_id       uuid NOT NULL REFERENCES crm_teams(id),
  officer_id    uuid REFERENCES staff(id),
  started_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  ended_at      timestamptz,
  end_reason    text,
  assigned_by   uuid REFERENCES staff(id),
  reason        text
);
CREATE INDEX crm_assignments_ticket_idx ON crm_assignments(ticket_id, started_at);
CREATE INDEX crm_assignments_team_idx ON crm_assignments(team_id, started_at);
CREATE INDEX crm_assignments_officer_idx ON crm_assignments(officer_id, started_at) WHERE officer_id IS NOT NULL;
CREATE UNIQUE INDEX crm_assignments_open_uq ON crm_assignments(ticket_id) WHERE ended_at IS NULL;

-- Timeline. PUBLIC entries are visible to the complainant; INTERNAL notes only to the handling teams, CX Head and Super Admin.
CREATE TABLE crm_events (
  id          bigserial PRIMARY KEY,
  ticket_id   uuid NOT NULL REFERENCES crm_tickets(id),
  at          timestamptz NOT NULL,
  actor_id    uuid REFERENCES staff(id),
  kind        text NOT NULL,
  visibility  text NOT NULL CHECK (visibility IN ('PUBLIC','INTERNAL')),
  body        text,
  details     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX crm_events_ticket_idx ON crm_events(ticket_id, id);

CREATE TABLE crm_attachments (
  id            uuid PRIMARY KEY,
  ticket_id     uuid NOT NULL REFERENCES crm_tickets(id),
  filename      text NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL,
  sha256        text NOT NULL,
  storage_key   text NOT NULL,
  scan_status   text NOT NULL CHECK (scan_status IN ('QUARANTINED','CLEAN','REJECTED')),
  scan_detail   text,
  internal      boolean NOT NULL DEFAULT false,
  purpose       text NOT NULL DEFAULT 'EVIDENCE' CHECK (purpose IN ('EVIDENCE','RESOLUTION')),
  uploaded_by   uuid NOT NULL REFERENCES staff(id),
  uploaded_at   timestamptz NOT NULL
);
CREATE INDEX crm_attachments_ticket_idx ON crm_attachments(ticket_id);

CREATE TABLE crm_ticket_links (
  ticket_id   uuid NOT NULL REFERENCES crm_tickets(id),
  related_id  uuid NOT NULL REFERENCES crm_tickets(id),
  created_by  uuid REFERENCES staff(id),
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (ticket_id, related_id),
  CHECK (ticket_id <> related_id)
);

-- One escalation per ticket per rule (no repeated alerts).
CREATE TABLE crm_escalation_hits (
  ticket_id  uuid NOT NULL REFERENCES crm_tickets(id),
  rule_id    uuid NOT NULL REFERENCES crm_escalation_rules(id),
  hit_at     timestamptz NOT NULL,
  PRIMARY KEY (ticket_id, rule_id)
);

-- ------------------------------------------------------------------ reporting, knowledge base
CREATE TABLE crm_report_schedules (
  frequency      text PRIMARY KEY CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY')),
  enabled        boolean NOT NULL DEFAULT false,
  send_hour      int NOT NULL DEFAULT 7 CHECK (send_hour BETWEEN 0 AND 23),
  include_cx_heads boolean NOT NULL DEFAULT true,
  extra_recipient_ids uuid[] NOT NULL DEFAULT '{}',
  updated_by     uuid REFERENCES staff(id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO crm_report_schedules (frequency) VALUES ('DAILY'), ('WEEKLY'), ('MONTHLY');

CREATE TABLE crm_report_runs (
  frequency    text NOT NULL,
  period_key   text NOT NULL,
  run_at       timestamptz NOT NULL,
  recipients   int NOT NULL,
  PRIMARY KEY (frequency, period_key)
);

CREATE TABLE crm_kb_articles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL CHECK (length(title) BETWEEN 5 AND 150),
  body         text NOT NULL CHECK (length(body) BETWEEN 10 AND 20000),
  category_id  uuid REFERENCES crm_categories(id),
  status       text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  updated_by   uuid NOT NULL REFERENCES staff(id),
  updated_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL
);

-- ------------------------------------------------------------------ initial ARAF complaint catalogue (editable by the Super Admin)
INSERT INTO crm_categories (code, name, sort_order) VALUES
  ('LOGIN_ACCESS', 'Login & Access', 10),
  ('ONBOARDING_KYC', 'Customer Onboarding & KYC', 20),
  ('ORIGINATION', 'Financing Origination', 30),
  ('CREDIT_OFFER', 'Credit Assessment & Offer', 40),
  ('APPROVAL_WORKFLOW', 'Approval & Workflow', 50),
  ('DISBURSEMENT', 'Disbursement & Settlement', 60),
  ('REPAYMENT_MANDATES', 'Repayment & Mandates', 70),
  ('DOCUMENTS_COMPLIANCE', 'Documents & Compliance', 80),
  ('PLATFORM_NOTIFICATIONS', 'Platform & Notifications', 90);

INSERT INTO crm_subcategories (category_id, name, sort_order)
SELECT c.id, s.name, s.ord FROM crm_categories c JOIN (VALUES
  ('LOGIN_ACCESS', 'Unable to log in', 1), ('LOGIN_ACCESS', 'Incorrect role assigned', 2), ('LOGIN_ACCESS', 'Financing product not visible', 3),
  ('LOGIN_ACCESS', 'Unauthorised workspace displayed', 4), ('LOGIN_ACCESS', 'Access denied', 5), ('LOGIN_ACCESS', 'User profile not recognised', 6),
  ('LOGIN_ACCESS', 'Session or authentication issue', 7),
  ('ONBOARDING_KYC', 'BVN validation failure', 1), ('ONBOARDING_KYC', 'Customer name mismatch', 2), ('ONBOARDING_KYC', 'Date of birth mismatch', 3),
  ('ONBOARDING_KYC', 'Customer eligibility issue', 4), ('ONBOARDING_KYC', 'KYC documentation failure', 5), ('ONBOARDING_KYC', 'Credit check not returning', 6),
  ('ONBOARDING_KYC', 'Customer information validation error', 7),
  ('ORIGINATION', 'Unable to initiate financing request', 1), ('ORIGINATION', 'Application not saving', 2), ('ORIGINATION', 'Request submission failure', 3),
  ('ORIGINATION', 'Incorrect customer details', 4), ('ORIGINATION', 'Product unavailable', 5), ('ORIGINATION', 'Missing mandatory fields', 6),
  ('ORIGINATION', 'Supplier information issue', 7), ('ORIGINATION', 'Financing request not appearing in dashboard', 8),
  ('CREDIT_OFFER', 'Seedfi credit check failure', 1), ('CREDIT_OFFER', 'Incorrect credit assessment result', 2), ('CREDIT_OFFER', 'Facility amount discrepancy', 3),
  ('CREDIT_OFFER', 'Incorrect markup calculation', 4), ('CREDIT_OFFER', 'Incorrect tenor calculation', 5), ('CREDIT_OFFER', 'Offer letter not generated', 6),
  ('CREDIT_OFFER', 'Offer letter contains incorrect information', 7), ('CREDIT_OFFER', 'Eligibility or financing limit issue', 8),
  ('APPROVAL_WORKFLOW', 'Request stuck with approver', 1), ('APPROVAL_WORKFLOW', 'Incorrect approval routing', 2), ('APPROVAL_WORKFLOW', 'Approval not reflecting', 3),
  ('APPROVAL_WORKFLOW', 'Approver unable to access request', 4), ('APPROVAL_WORKFLOW', 'Request incorrectly returned', 5), ('APPROVAL_WORKFLOW', 'Approval notification not received', 6),
  ('APPROVAL_WORKFLOW', 'Incorrect approval status', 7), ('APPROVAL_WORKFLOW', 'Approval queue discrepancy', 8),
  ('DISBURSEMENT', 'Approved facility not disbursed', 1), ('DISBURSEMENT', 'Failed disbursement', 2), ('DISBURSEMENT', 'Delayed disbursement', 3),
  ('DISBURSEMENT', 'Incorrect beneficiary information', 4), ('DISBURSEMENT', 'Duplicate disbursement concern', 5), ('DISBURSEMENT', 'Disbursement status not updated', 6),
  ('DISBURSEMENT', 'Settlement or reconciliation discrepancy', 7),
  ('REPAYMENT_MANDATES', 'Repayment schedule discrepancy', 1), ('REPAYMENT_MANDATES', 'Debit mandate setup failure', 2), ('REPAYMENT_MANDATES', 'Debit mandate confirmation issue', 3),
  ('REPAYMENT_MANDATES', 'Repayment not reflecting', 4), ('REPAYMENT_MANDATES', 'Duplicate deduction concern', 5), ('REPAYMENT_MANDATES', 'Outstanding balance discrepancy', 6),
  ('REPAYMENT_MANDATES', 'Incorrect repayment status', 7),
  ('DOCUMENTS_COMPLIANCE', 'Document upload failure', 1), ('DOCUMENTS_COMPLIANCE', 'Missing financing agreement', 2), ('DOCUMENTS_COMPLIANCE', 'Offer letter signature issue', 3),
  ('DOCUMENTS_COMPLIANCE', 'Required document not generated', 4), ('DOCUMENTS_COMPLIANCE', 'Legal & Shariah handoff failure', 5), ('DOCUMENTS_COMPLIANCE', 'Customer ZIP archive not generated', 6),
  ('DOCUMENTS_COMPLIANCE', 'SharePoint storage failure', 7), ('DOCUMENTS_COMPLIANCE', 'Document retrieval issue', 8),
  ('PLATFORM_NOTIFICATIONS', 'ARAF page not loading', 1), ('PLATFORM_NOTIFICATIONS', 'System error', 2), ('PLATFORM_NOTIFICATIONS', 'Slow application performance', 3),
  ('PLATFORM_NOTIFICATIONS', 'Notification not received', 4), ('PLATFORM_NOTIFICATIONS', 'Incorrect dashboard figures', 5), ('PLATFORM_NOTIFICATIONS', 'Reporting discrepancy', 6),
  ('PLATFORM_NOTIFICATIONS', 'File attachment issue', 7), ('PLATFORM_NOTIFICATIONS', 'General platform malfunction', 8)
) AS s(code, name, ord) ON s.code = c.code;

-- Product-specific issues, shown only when that product is selected (sorted after the general issues).
INSERT INTO crm_subcategories (category_id, name, product_code, sort_order)
SELECT c.id, s.name, s.product, 200 + s.ord FROM crm_categories c JOIN (VALUES
  ('ONBOARDING_KYC', 'Merchant eligibility', 'WAKEELBOOST', 1), ('CREDIT_OFFER', 'Turnover assessment', 'WAKEELBOOST', 2),
  ('CREDIT_OFFER', 'Facility limits', 'WAKEELBOOST', 3), ('ORIGINATION', 'Supplier information', 'WAKEELBOOST', 4),
  ('ORIGINATION', 'Stock financing', 'WAKEELBOOST', 5), ('ONBOARDING_KYC', 'Credit checks', 'WAKEELBOOST', 6),
  ('ORIGINATION', 'Financing request processing', 'WAKEELBOOST', 7),
  ('ORIGINATION', 'Supplier bank selection', 'VENDOR_FINANCING', 1), ('DOCUMENTS_COMPLIANCE', 'Invoice validation', 'VENDOR_FINANCING', 2),
  ('ONBOARDING_KYC', 'Team Lead KYC verification', 'VENDOR_FINANCING', 3), ('DOCUMENTS_COMPLIANCE', 'Business photograph evidence', 'VENDOR_FINANCING', 4),
  ('APPROVAL_WORKFLOW', 'Approval thresholds', 'VENDOR_FINANCING', 5), ('DOCUMENTS_COMPLIANCE', 'Financing documentation', 'VENDOR_FINANCING', 6),
  ('DISBURSEMENT', 'Supplier payment', 'VENDOR_FINANCING', 7),
  ('ORIGINATION', 'Vehicle information', 'ALT_DRIVE', 1), ('DOCUMENTS_COMPLIANCE', 'Supplier documentation', 'ALT_DRIVE', 2),
  ('CREDIT_OFFER', 'Asset valuation', 'ALT_DRIVE', 3), ('CREDIT_OFFER', 'Financing offer', 'ALT_DRIVE', 4),
  ('APPROVAL_WORKFLOW', 'Approval', 'ALT_DRIVE', 5), ('DISBURSEMENT', 'Disbursement', 'ALT_DRIVE', 6),
  ('ORIGINATION', 'Equipment quotation', 'ALT_POWER', 1), ('ONBOARDING_KYC', 'Supplier verification', 'ALT_POWER', 2),
  ('ORIGINATION', 'Asset information', 'ALT_POWER', 3), ('CREDIT_OFFER', 'Financing calculation', 'ALT_POWER', 4),
  ('APPROVAL_WORKFLOW', 'Approval', 'ALT_POWER', 5), ('DISBURSEMENT', 'Disbursement', 'ALT_POWER', 6),
  ('ORIGINATION', 'Phone model availability', 'ALTPHONES', 1), ('ORIGINATION', 'Location selection', 'ALTPHONES', 2),
  ('REPAYMENT_MANDATES', '₦29,000 down payment', 'ALTPHONES', 3), ('ORIGINATION', 'Stock reservation', 'ALTPHONES', 4),
  ('REPAYMENT_MANDATES', 'Debit mandates', 'ALTPHONES', 5), ('CREDIT_OFFER', 'Three-, six- and twelve-month financing calculations', 'ALTPHONES', 6),
  ('DISBURSEMENT', 'Stock deduction', 'ALTPHONES', 7), ('APPROVAL_WORKFLOW', 'Approval and fulfilment', 'ALTPHONES', 8),
  ('ONBOARDING_KYC', 'Salary history verification', 'STAFF_SALARY_ADVANCE', 1), ('CREDIT_OFFER', 'Financing eligibility', 'STAFF_SALARY_ADVANCE', 2),
  ('CREDIT_OFFER', 'Fifty-percent salary limit', 'STAFF_SALARY_ADVANCE', 3), ('CREDIT_OFFER', 'Two-percent upfront deductions', 'STAFF_SALARY_ADVANCE', 4),
  ('CREDIT_OFFER', 'Offer letter generation', 'STAFF_SALARY_ADVANCE', 5), ('DOCUMENTS_COMPLIANCE', 'Signature confirmation', 'STAFF_SALARY_ADVANCE', 6),
  ('DISBURSEMENT', 'Disbursement', 'STAFF_SALARY_ADVANCE', 7)
) AS s(code, name, product, ord) ON s.code = c.code;
