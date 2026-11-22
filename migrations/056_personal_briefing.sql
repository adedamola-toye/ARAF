-- Phase 5. Personal Weekly Performance Briefing: each originating officer receives their own week in review,
-- sent with the Sunday reports. Switched OFF until a Super Admin turns it on (Scheduled emails), so no new emails
-- go out on deployment. Additive only.
ALTER TABLE schedule_settings DROP CONSTRAINT schedule_settings_code_check;
ALTER TABLE schedule_settings ADD CONSTRAINT schedule_settings_code_check CHECK (code IN ('WEEKLY_DIGEST','MONTHLY_REPORT','DH_WEEKLY_REPORT','TEAM_WEEKLY_REPORT','PERSONAL_BRIEFING'));
INSERT INTO schedule_settings (code, enabled, day_of_month, hour, minute) VALUES ('PERSONAL_BRIEFING', false, NULL, 18, 0)
ON CONFLICT (code) DO NOTHING;
