-- Staff Personal Financing route positions:
--  * the Unit Head for the staff (salary advance) route is ONE configured person, recorded in the
--    versioned settings (each change is a new, attributed version);
--  * there is ONE Divisional Head in the whole system (enforced when the role is granted).
ALTER TABLE staff_financing_settings ADD COLUMN unit_head_staff_id uuid REFERENCES staff(id);
