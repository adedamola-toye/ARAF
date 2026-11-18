-- Weekly Divisional Head report: every Sunday at 18:00 Africa/Lagos, previous week and month to date,
-- to every active Divisional Head (plus any extra recipients the Super Admin adds).
ALTER TABLE schedule_settings DROP CONSTRAINT schedule_settings_code_check;
ALTER TABLE schedule_settings ADD CONSTRAINT schedule_settings_code_check CHECK (code IN ('WEEKLY_DIGEST','MONTHLY_REPORT','DH_WEEKLY_REPORT'));
INSERT INTO schedule_settings (code, enabled, day_of_month, hour, minute) VALUES ('DH_WEEKLY_REPORT', true, NULL, 18, 0)
ON CONFLICT (code) DO NOTHING;
