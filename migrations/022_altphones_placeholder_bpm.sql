-- Placeholder BPM: an SA application from an Altshop or Altbox with no usable BPM (no mapping, or the mapped BPM is not
-- set up) is routed to the Placeholder BPM and waits at the BPM stage. Nobody can approve as the placeholder; when a
-- BPM mapping covering the location takes effect, waiting applications are re-routed to that BPM.
ALTER TABLE altphones_applications ADD COLUMN routed_to_placeholder boolean NOT NULL DEFAULT false;
ALTER TABLE altphones_applications ADD CONSTRAINT altphones_placeholder_or_bpm CHECK (NOT (routed_to_placeholder AND routed_bpm_id IS NOT NULL));
CREATE INDEX altphones_app_placeholder_idx ON altphones_applications (status) WHERE routed_to_placeholder;
