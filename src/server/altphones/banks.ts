/**
 * Bank list and account name enquiry through Paystack. The list is cached in memory for 12 hours.
 * Alternative Bank's own accounts resolve with its NUBAN code (000304).
 */
import { config } from "../config";
import { IntegrationUnavailable, paymentGateway, type BankOption } from "./integrations";

export const ALTERNATIVE_BANK_CODE = "000304";
const TEST_BANK: BankOption = { code: "001", name: "Test Bank (Paystack test mode)" };

let cache: { at: number; banks: BankOption[]; gw: object } | null = null;
export function clearBankCache() {
  cache = null;
}

/** Banks for the "other bank" picker (Alternative Bank excluded). Empty when Paystack is unavailable. */
export async function otherBanks(): Promise<BankOption[]> {
  const gw = paymentGateway();
  if (!gw) return [];
  if (!cache || cache.gw !== gw || Date.now() - cache.at > 12 * 3600_000) {
    try {
      const list = (await gw.listBanks()).filter((b) => b.code !== ALTERNATIVE_BANK_CODE).sort((a, b) => a.name.localeCompare(b.name));
      cache = { at: Date.now(), banks: list, gw };
    } catch (e) {
      if (!(e instanceof IntegrationUnavailable)) console.error("[paystack] bank list failed", e);
      return cache?.banks ?? [];
    }
  }
  return config.paystack.testMode ? [TEST_BANK, ...cache.banks] : cache.banks;
}

export type Resolution = { status: "FOUND"; accountName: string } | { status: "NOT_FOUND" } | { status: "UNAVAILABLE"; message: string };

export async function resolveAccount(accountNumber: string, bankCode: string): Promise<Resolution> {
  const gw = paymentGateway();
  if (!gw) return { status: "UNAVAILABLE", message: "Paystack is not configured." };
  if (!/^\d{10}$/.test(accountNumber) || !/^[0-9A-Za-z]{2,10}$/.test(bankCode)) return { status: "NOT_FOUND" };
  // Test keys resolve only Paystack's Test Bank, so Alternative Bank lookups use it in test mode.
  const code = config.paystack.testMode && bankCode === ALTERNATIVE_BANK_CODE ? TEST_BANK.code : bankCode;
  try {
    const r = await gw.resolveAccount(accountNumber, code);
    return r ? { status: "FOUND", accountName: r.accountName } : { status: "NOT_FOUND" };
  } catch (e) {
    return { status: "UNAVAILABLE", message: e instanceof IntegrationUnavailable ? e.message : "The account lookup failed." };
  }
}
