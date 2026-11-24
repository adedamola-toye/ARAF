-- Staff Salary Advance is retired (business decision, 24 November 2026).
--
-- Additive and non-destructive: no row is deleted and no financial term is changed.
--  * Adds the closing status WITHDRAWN.
--  * Every request that had not yet reached money movement is closed as WITHDRAWN, with a status-history
--    event, a system audit event and an in-app notice to the applicant.
--  * Requests already in DISBURSEMENT_IN_PROGRESS are left as they are: the payment may already be with
--    core banking, so the Disbursement Officer completes (or the Super Admin resolves) them as before.
--  * COMPLETED, DECLINED and OFFER_EXPIRED records are untouched. Repayments on completed advances can
--    still be recorded.

ALTER TABLE staff_requests DROP CONSTRAINT staff_requests_status_check;
ALTER TABLE staff_requests ADD CONSTRAINT staff_requests_status_check CHECK (status IN (
  'DRAFT','SUBMITTED','UNDER_PM_REVIEW','RETURNED_FOR_CORRECTION','UNDER_UNIT_HEAD_REVIEW',
  'UNDER_DIVISIONAL_HEAD_REVIEW','APPROVED','AWAITING_SIGNED_OFFER','OFFER_EXPIRED',
  'ASSIGNED_FOR_DISBURSEMENT','DISBURSEMENT_IN_PROGRESS','COMPLETED','DECLINED','WITHDRAWN'));

CREATE TEMP TABLE retired_staff_requests ON COMMIT DROP AS
SELECT id, ref, applicant_id, status AS from_status
  FROM staff_requests
 WHERE status IN ('DRAFT','SUBMITTED','UNDER_PM_REVIEW','RETURNED_FOR_CORRECTION','UNDER_UNIT_HEAD_REVIEW',
                  'UNDER_DIVISIONAL_HEAD_REVIEW','APPROVED','AWAITING_SIGNED_OFFER','ASSIGNED_FOR_DISBURSEMENT');

UPDATE staff_requests r
   SET status = 'WITHDRAWN', updated_at = now(), lock_version = r.lock_version + 1
  FROM retired_staff_requests t
 WHERE r.id = t.id;

INSERT INTO staff_request_events (request_id, action, from_status, to_status, actor_id, actor_role, queue, outcome, comments, document_ids, details, occurred_at)
SELECT id, 'PRODUCT_RETIRED', from_status, 'WITHDRAWN', NULL, 'SYSTEM', NULL, 'WITHDRAWN',
       'Withdrawn: Staff Salary Advance has been retired.', '{}', jsonb_build_object('migration', '058'), now()
  FROM retired_staff_requests;

INSERT INTO audit_events (occurred_at, actor_role, action, outcome, reason, staff_request_id, details)
SELECT now(), 'SYSTEM', 'STAFF_REQUEST_WITHDRAWN_PRODUCT_RETIRED', 'SUCCESS',
       'Staff Salary Advance has been retired.', id, jsonb_build_object('ref', ref, 'fromStatus', from_status, 'migration', '058')
  FROM retired_staff_requests;

INSERT INTO notifications (recipient_id, kind, title, body, link, dedupe_key, created_at)
SELECT applicant_id, 'STAFF_ADVANCE_RETIRED', 'Salary advance request closed',
       'Your salary advance request ' || ref || ' has been closed because Staff Salary Advance has been retired. No further action is needed.',
       '/staff-request/' || id, 'staff-retired:' || id, now()
  FROM retired_staff_requests
 WHERE from_status <> 'DRAFT'
ON CONFLICT DO NOTHING;
