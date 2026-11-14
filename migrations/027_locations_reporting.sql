-- Locations as a structured reporting dimension.
--  * AltLounge as a location type.
--  * Business unit, and whether Relationship Managers can choose the location when originating a request.
--  * The location an RM originated a request at (kept on the request for reporting; never overwritten by later edits
--    to the location itself).
--  * The six initial origination locations (not duplicated when an equivalent location already exists).
ALTER TABLE locations DROP CONSTRAINT locations_outlet_type_check;
ALTER TABLE locations ADD CONSTRAINT locations_outlet_type_check CHECK (outlet_type IN ('BRANCH','ALTBOX','ALTSHOP','ALTLOUNGE'));
ALTER TABLE locations
  ADD COLUMN business_unit  text,
  ADD COLUMN rm_origination boolean NOT NULL DEFAULT false;

ALTER TABLE applications ADD COLUMN origination_location_id uuid REFERENCES locations(id);
CREATE INDEX applications_origination_location_idx ON applications (origination_location_id) WHERE origination_location_id IS NOT NULL;

INSERT INTO locations (state, city, outlet_type, name, business_unit, rm_origination, active, created_at, updated_at)
SELECT v.state, v.city, v.type, v.name, 'Retail', true, true, now(), now()
  FROM (VALUES
    ('LAGOS', 'Lagos', 'ALTLOUNGE', 'AltLounge Allen Lagos 1'),
    ('LAGOS', 'Lagos', 'ALTLOUNGE', 'AltLounge Allen Lagos 2'),
    ('OYO', 'Ibadan', 'ALTLOUNGE', 'AltLounge Jericho Ibadan'),
    ('KWARA', 'Ilorin', 'ALTLOUNGE', 'AltLounge Tanke Ilorin'),
    ('KANO', 'Kano', 'BRANCH', 'Altbank Kano'),
    ('FCT (ABUJA)', 'Abuja', 'BRANCH', 'Altbank Abuja')
  ) AS v(state, city, type, name)
 WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.state = v.state AND lower(l.name) = lower(v.name));
-- An equivalent location that already existed becomes selectable for RMs.
UPDATE locations SET rm_origination = true
 WHERE (state, lower(name)) IN (('LAGOS','altlounge allen lagos 1'),('LAGOS','altlounge allen lagos 2'),('OYO','altlounge jericho ibadan'),('KWARA','altlounge tanke ilorin'),('KANO','altbank kano'),('FCT (ABUJA)','altbank abuja'));
