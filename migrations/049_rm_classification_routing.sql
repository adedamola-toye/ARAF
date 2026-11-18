-- Relationship Manager classification (DBC / Non-DBC), RBE reporting lines, configured routing approvers and the
-- routing pinned on each request at submission.

-- 1. Classification of each Relationship Manager, set by the Super Admin (never inferred from location).
CREATE TABLE rm_classifications (
  staff_id      uuid PRIMARY KEY REFERENCES staff(id),
  segment       text NOT NULL CHECK (segment IN ('DBC','NON_DBC')),
  dbc_region    text CHECK (dbc_region IN ('SOUTH_WEST','NORTH')),
  business_unit text,
  set_by        uuid REFERENCES staff(id),
  set_at        timestamptz NOT NULL DEFAULT now(),
  reason        text,
  CHECK ((segment = 'DBC') = (dbc_region IS NOT NULL))
);

-- 2. Non-DBC RM -> Regional Business Executive reporting line.
ALTER TABLE org_links DROP CONSTRAINT org_links_relation_check;
ALTER TABLE org_links ADD CONSTRAINT org_links_relation_check CHECK (relation IN ('MO_LEAD','MO_HEAD','UNIT_HEAD','DIVISIONAL_HEAD','RBE'));

-- 3. Configured approvers: the DBC Unit Head for each DBC region and the E-commerce Unit Head (Non-DBC route).
CREATE TABLE routing_assignments (
  key       text PRIMARY KEY CHECK (key IN ('DBC_UNIT_HEAD_SOUTH_WEST','DBC_UNIT_HEAD_NORTH','ECOMMERCE_UNIT_HEAD')),
  staff_id  uuid NOT NULL REFERENCES staff(id),
  set_by    uuid REFERENCES staff(id),
  set_at    timestamptz NOT NULL DEFAULT now(),
  reason    text
);

-- 4. Routing pinned on the request at submission (later reporting-line changes apply to new requests only).
ALTER TABLE applications ADD COLUMN routing_segment text CHECK (routing_segment IN ('DBC','NON_DBC'));
ALTER TABLE applications ADD COLUMN routing_unit_head_id uuid REFERENCES staff(id);
ALTER TABLE applications ADD COLUMN cx_reviewer_id uuid REFERENCES staff(id);

-- 5. DBC Unit Heads named by the business: mapped only when exactly one active staff member with that exact name
--    already holds the Unit Head role. Otherwise nothing is mapped and the Super Admin resolves it (no accounts
--    are created and no similar names are guessed).
INSERT INTO routing_assignments (key, staff_id, reason)
SELECT m.key, (SELECT s.id FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active AND ra.role = 'UNIT_HEAD'
                WHERE s.status = 'ACTIVE' AND lower(trim(s.full_name)) = lower(m.name))
     , 'Initial DBC Unit Head mapping (business owner instruction).'
  FROM (VALUES ('DBC_UNIT_HEAD_SOUTH_WEST','Seun Oladesu'), ('DBC_UNIT_HEAD_NORTH','Abubakar Musa 2')) m(key, name)
 WHERE (SELECT count(*) FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active AND ra.role = 'UNIT_HEAD'
         WHERE s.status = 'ACTIVE' AND lower(trim(s.full_name)) = lower(m.name)) = 1
ON CONFLICT (key) DO NOTHING;
