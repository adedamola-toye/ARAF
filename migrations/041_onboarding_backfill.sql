-- People who already used ARAF before onboarding existed are not first-time users: record their existing roles
-- as seen so the welcome does not appear for them; it remains available under Help & Guides. New users and
-- newly assigned roles still get the welcome automatically.
INSERT INTO onboarding_states (staff_id, role, guide_version, first_seen_at, updated_at)
SELECT DISTINCT ra.staff_id, ra.role, 1, now(), now()
  FROM role_assignments ra
 WHERE ra.active AND EXISTS (SELECT 1 FROM sessions s WHERE s.staff_id = ra.staff_id)
ON CONFLICT DO NOTHING;
