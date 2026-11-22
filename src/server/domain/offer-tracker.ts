/**
 * Offer letter tracker for originators: the offer generated from the approved terms, the signed acceptance, and
 * how long acceptance has been outstanding. Records only.
 *
 * No acceptance period is configured for WakeelBoost or retail products, so nothing here expires an offer.
 * (Staff Salary Advance keeps its own 24-hour offer window, unchanged.)
 */
import type { Db } from "../db";

export type OfferStatus = "PREPARING" | "AWAITING_ACCEPTANCE" | "ACCEPTED";
export const OFFER_STATUS_LABEL: Record<OfferStatus, string> = {
  PREPARING: "Offer being generated",
  AWAITING_ACCEPTANCE: "Awaiting signed acceptance",
  ACCEPTED: "Signed acceptance received",
};

export interface OfferRow {
  application_id: string;
  ref: string;
  customer_name: string | null;
  product_label: string | null;
  amount_kobo: string;
  stage: string;
  task_id: string | null;
  mine: boolean;
  approved_at: Date | null;
  offer_doc_id: string | null;
  offer_at: Date | null;
  signed_doc_id: string | null;
  signed_at: Date | null;
  status: OfferStatus;
}

export async function offerTracker(q: Db, staffId: string): Promise<OfferRow[]> {
  const rows = (
    await q.query<Omit<OfferRow, "status">>(
      `SELECT a.id AS application_id, a.ref, a.customer_name, a.product_label, coalesce(a.requested_amount_kobo, 0)::text AS amount_kobo, a.stage,
              t.id AS task_id, (t.assignee_id = $1) AS mine,
              (SELECT max(d.created_at) FROM decisions d WHERE d.application_id = a.id AND d.stage = 'DIVISIONAL_HEAD_REVIEW' AND d.action = 'APPROVE' AND d.invalidated_at IS NULL) AS approved_at,
              og.id AS offer_doc_id, og.uploaded_at AS offer_at, sg.id AS signed_doc_id, sg.uploaded_at AS signed_at
         FROM applications a
         LEFT JOIN tasks t ON t.application_id = a.id AND t.status = 'OPEN'
         LEFT JOIN LATERAL (SELECT id, uploaded_at FROM documents x WHERE x.application_id = a.id AND x.category IN ('GENERATED_OFFER_PDF','GENERATED_OFFER') AND x.superseded_at IS NULL AND x.scan_status = 'CLEAN' AND x.purged_at IS NULL
                             ORDER BY (x.category = 'GENERATED_OFFER_PDF') DESC, x.uploaded_at DESC LIMIT 1) og ON true
         LEFT JOIN LATERAL (SELECT id, uploaded_at FROM documents x WHERE x.application_id = a.id AND x.category = 'SIGNED_OFFER' AND x.superseded_at IS NULL AND x.scan_status = 'CLEAN' AND x.purged_at IS NULL
                             ORDER BY x.uploaded_at DESC LIMIT 1) sg ON true
        WHERE (a.initiator_id = $1 OR a.assigned_rm_id = $1)
          AND a.stage IN ('OFFER_PREPARATION','CO3_PACK_REVIEW','DISBURSEMENT_CHECK','DISBURSEMENT_CORRECTION','DISBURSEMENT_BOOKING')
        ORDER BY approved_at ASC NULLS LAST`,
      [staffId],
    )
  ).rows;
  return rows.map((r) => ({ ...r, status: r.signed_doc_id ? "ACCEPTED" : r.offer_doc_id ? "AWAITING_ACCEPTANCE" : "PREPARING" }));
}
