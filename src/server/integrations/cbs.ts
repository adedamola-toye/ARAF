/**
 * Core banking (CBS) integration boundary. No CBS connection exists yet: this file defines what ARAF
 * will need from one and reports the recorded status. Nothing here fetches or invents data.
 *
 * When a connection is built and verified, an adapter implementing `CoreBankingAdapter` posts repayments
 * through `recordRepayment(..., "INTEGRATION")` (idempotent per facility + reference) and updates
 * `integration_status` (code 'CBS').
 */
import type { Db } from "../db";

export interface CbsRepayment {
  accountNumber: string;
  facilityReference: string;
  valueDate: string; // YYYY-MM-DD
  amountKobo: number;
  reference: string;
  reversal: boolean;
}

export interface CoreBankingAdapter {
  /** Repayments posted on the core banking system since a point in time. */
  repaymentsSince(since: Date): Promise<CbsRepayment[]>;
  /** Outstanding balance per facility as held by core banking (for reconciliation). */
  balance(facilityReference: string): Promise<{ outstandingKobo: number; asOf: Date } | null>;
}

export interface IntegrationStatus {
  code: string;
  name: string;
  status: "NOT_CONNECTED" | "IN_TESTING" | "CONNECTED" | "SUSPENDED";
  last_sync_at: Date | null;
  note: string | null;
}

export async function cbsStatus(q: Db): Promise<IntegrationStatus> {
  const r = (await q.query<IntegrationStatus>("SELECT code, name, status, last_sync_at, note FROM integration_status WHERE code = 'CBS'")).rows[0];
  return r ?? { code: "CBS", name: "Core banking system", status: "NOT_CONNECTED", last_sync_at: null, note: null };
}

/** The adapter in use. There is none until a connection is built and verified. */
export function coreBankingAdapter(): CoreBankingAdapter | null {
  return null;
}
