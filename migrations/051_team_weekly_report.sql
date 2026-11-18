-- Weekly team report: each Unit Head and Team Lead receives their own team's individual figures, sent with the
-- Divisional Head report (same Sunday time). Can be switched off separately by the Super Admin.
ALTER TABLE schedule_settings DROP CONSTRAINT schedule_settings_code_check;
ALTER TABLE schedule_settings ADD CONSTRAINT schedule_settings_code_check CHECK (code IN ('WEEKLY_DIGEST','MONTHLY_REPORT','DH_WEEKLY_REPORT','TEAM_WEEKLY_REPORT'));
INSERT INTO schedule_settings (code, enabled, day_of_month, hour, minute) VALUES ('TEAM_WEEKLY_REPORT', true, NULL, 18, 0)
ON CONFLICT (code) DO NOTHING;
