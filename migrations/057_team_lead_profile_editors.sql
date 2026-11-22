-- Phase 5. Team Leads explicitly designated by a Super Admin may correct limited profile fields (full name,
-- business unit) of the people in their own team. Roles, status, region and access are never editable by them.
CREATE TABLE team_lead_profile_editors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      uuid NOT NULL REFERENCES staff(id),
  designated_by uuid NOT NULL REFERENCES staff(id),
  designated_at timestamptz NOT NULL,
  reason        text NOT NULL,
  revoked_by    uuid REFERENCES staff(id),
  revoked_at    timestamptz
);
CREATE UNIQUE INDEX team_lead_profile_editors_active_idx ON team_lead_profile_editors(staff_id) WHERE revoked_at IS NULL;
