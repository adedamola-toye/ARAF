-- Merchant Officer hierarchy, reporting lines, Alaba location, RM disbursement confirmation.

-- 1. Reporting lines (configured by the Super Admin; never hardcoded). One manager per staff member per relation.
--    MO_LEAD: Merchant Officer -> Merchant Officer Lead. MO_HEAD: Merchant Officer Lead -> Merchant Officer Head.
--    UNIT_HEAD: any staff member -> the Unit Head they report into. DIVISIONAL_HEAD: Unit Head -> Divisional Head.
CREATE TABLE org_links (
  staff_id    uuid NOT NULL REFERENCES staff(id),
  relation    text NOT NULL CHECK (relation IN ('MO_LEAD','MO_HEAD','UNIT_HEAD','DIVISIONAL_HEAD')),
  manager_id  uuid NOT NULL REFERENCES staff(id),
  set_by      uuid REFERENCES staff(id),
  set_at      timestamptz NOT NULL DEFAULT now(),
  reason      text,
  PRIMARY KEY (staff_id, relation),
  CHECK (staff_id <> manager_id)
);
CREATE INDEX org_links_manager_idx ON org_links(manager_id, relation);

-- 2. Applications record the Merchant Officer Head who reviewed them (attribution and separation of duties).
ALTER TABLE applications ADD COLUMN mo_head_id uuid REFERENCES staff(id);

-- 3. Location correction: AltLounge Allen Lagos 2 is renamed in place (same record and identifier, history kept).
UPDATE locations SET name = 'AltLounge Alaba Lagos' WHERE name = 'AltLounge Allen Lagos 2'
   AND NOT EXISTS (SELECT 1 FROM locations WHERE name = 'AltLounge Alaba Lagos');

-- 4. Initial Merchant Officer Lead and Head (role assignments; routing uses the roles and reporting lines, not names).
INSERT INTO bank_directory (email, full_name, source) VALUES
  ('abiodun.ayinde@altbank.ng', 'Abiodun Ayinde', 'migration-048'),
  ('alexander.olasinde@altbank.ng', 'Alexander Olasinde', 'migration-048')
ON CONFLICT (email) DO NOTHING;
INSERT INTO staff (email, full_name, created_at, updated_at) VALUES
  ('abiodun.ayinde@altbank.ng', 'Abiodun Ayinde', now(), now()),
  ('alexander.olasinde@altbank.ng', 'Alexander Olasinde', now(), now())
ON CONFLICT (email) DO NOTHING;
INSERT INTO role_assignments (staff_id, role, granted_at)
SELECT s.id, r.role, now() FROM staff s JOIN (VALUES ('abiodun.ayinde@altbank.ng','MERCHANT_OFFICER_LEAD'), ('alexander.olasinde@altbank.ng','MERCHANT_OFFICER_HEAD')) r(email, role) ON r.email = s.email
 WHERE NOT EXISTS (SELECT 1 FROM role_assignments x WHERE x.staff_id = s.id AND x.role = r.role AND x.active);
-- The Lead reports to the Head.
INSERT INTO org_links (staff_id, relation, manager_id, reason)
SELECT l.id, 'MO_HEAD', h.id, 'Initial Merchant Officer hierarchy (business owner instruction, 18 Nov 2026).'
  FROM staff l, staff h WHERE l.email = 'abiodun.ayinde@altbank.ng' AND h.email = 'alexander.olasinde@altbank.ng'
ON CONFLICT DO NOTHING;

-- 5. Merchant Officer Leads and Heads may originate (WakeelBoost and the retail products).
ALTER TABLE applications DROP CONSTRAINT applications_initiator_role_check;
ALTER TABLE applications ADD CONSTRAINT applications_initiator_role_check
  CHECK (initiator_role IN ('RM','ANM','MERCHANT_OFFICER','MERCHANT_OFFICER_LEAD','MERCHANT_OFFICER_HEAD','DELIGHT_OFFICER','TEAM_LEAD','UNIT_HEAD'));
