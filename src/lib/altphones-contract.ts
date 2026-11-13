/**
 * Altphones customer contract: the placeholders the wording can use, a plain-language starting draft,
 * and the renderer. The wording is edited in Altphones settings → Contract (Super Admin or Altphones
 * Product Manager); every saved change is a new, audited settings version, and each customer accepts the
 * exact rendered text by OTP (stored with its SHA-256).
 */

export const CONTRACT_PLACEHOLDERS = {
  ref: "Application reference",
  date: "Date the contract is issued",
  customer_name: "Customer's full name",
  customer_email: "Customer's email address",
  customer_phone: "Customer's phone number",
  phone_model: "Phone model and colour",
  price: "Phone price",
  down_payment: "Down payment received",
  financed_amount: "Balance financed (price − down payment)",
  tenure_months: "Number of monthly instalments",
  markup_rate: "Markup rate applied",
  markup_amount: "Total markup",
  total_repayment: "Total of the instalments (balance + markup)",
  monthly_instalment: "Monthly instalment",
  final_instalment: "Final instalment (absorbs rounding)",
  repayment_day: "Chosen day of the month",
  first_repayment_date: "First due date",
  final_repayment_date: "Last due date",
  ab_account: "Customer's Alternative Bank account",
  external_account: "Customer's account at another bank",
  external_bank: "Name of that other bank",
  dd_reference: "Paystack Direct Debit mandate reference",
  schedule: "Full repayment schedule (one line per instalment)",
  support_email: "Altphones team mailbox",
} as const;
export type ContractPlaceholder = keyof typeof CONTRACT_PLACEHOLDERS;
export const CONTRACT_PLACEHOLDER_KEYS = Object.keys(CONTRACT_PLACEHOLDERS) as ContractPlaceholder[];

export function unknownPlaceholders(tpl: string): string[] {
  return [...new Set([...tpl.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]).filter((k) => !(k in CONTRACT_PLACEHOLDERS)))];
}

export function renderContract(tpl: string, values: Partial<Record<ContractPlaceholder, string>>) {
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => values[k as ContractPlaceholder] ?? "");
}

/** Example figures for the editor preview only (never used for a customer). */
export const SAMPLE_CONTRACT_VALUES: Record<ContractPlaceholder, string> = {
  ref: "ALP-2026-000123",
  date: "2026-11-12",
  customer_name: "Amaka Okafor",
  customer_email: "amaka@example.com",
  customer_phone: "+2348031234567",
  phone_model: "Altphone L1 Series — Green",
  price: "₦145,000",
  down_payment: "₦29,000",
  financed_amount: "₦116,000",
  tenure_months: "6",
  markup_rate: "x% per month (example)",
  markup_amount: "₦—",
  total_repayment: "₦—",
  monthly_instalment: "₦—",
  final_instalment: "₦—",
  repayment_day: "25",
  first_repayment_date: "2026-12-25",
  final_repayment_date: "2027-05-25",
  ab_account: "0123456789",
  external_account: "9876543210",
  external_bank: "Example Bank",
  dd_reference: "DD-EXAMPLE",
  schedule: "1. 2026-12-25  ₦—\n2. 2027-01-25  ₦—\n…",
  support_email: "altbox@altbank.ng",
};

/**
 * Plain-language starting draft. It is NOT in force until a Super Admin or the Altphones Product Manager
 * saves it; the bracketed notes mark where the bank's Legal and Shariah teams must confirm wording.
 */
export const CONTRACT_DRAFT = `ALTPHONE FINANCING AGREEMENT
The Alternative Bank · Altphones

[DRAFT FOR LEGAL AND SHARIAH REVIEW — remove this line and complete the bracketed notes before saving for use.]

Reference: {{ref}}
Date: {{date}}


1. WHO THIS AGREEMENT IS BETWEEN

This agreement is between The Alternative Bank ("we", "us") and {{customer_name}} ("you").
Email: {{customer_email}} · Phone: {{customer_phone}}

Please read it carefully. It explains what you are buying, what you will pay and when.


2. WHAT YOU ARE BUYING

You are buying this phone from us: {{phone_model}}.

We buy the phone and sell it to you at its price plus an agreed markup, which you pay in monthly instalments. This is a sale, not a loan: there is no interest, and the amount you pay is fixed today and will not change.

The phone becomes yours when it is handed to you.


3. WHAT YOU PAY

  Phone price ........................... {{price}}
  Down payment (already received) ....... {{down_payment}}
  Balance to pay in instalments ......... {{financed_amount}}
  Markup ({{markup_rate}}) ............... {{markup_amount}}
  Total of your instalments ............. {{total_repayment}}

  Number of instalments ................. {{tenure_months}} monthly instalments
  Each instalment ....................... {{monthly_instalment}}
  Final instalment ...................... {{final_instalment}}

The final instalment may differ by a few kobo so that the total is exact.


4. WHEN YOU PAY

Your instalments are due on day {{repayment_day}} of each month, from {{first_repayment_date}} to {{final_repayment_date}}.

Your schedule:
{{schedule}}

The dates shown are provisional until the phone is handed to you. On handover we fix the schedule from that date and email you the final dates; the amounts do not change. If a due date falls on a weekend or public holiday, or in a month without that day, it moves as shown in your final schedule.


5. HOW YOUR INSTALMENTS ARE COLLECTED

You have authorised two ways for us to collect each instalment:

  a) A direct debit on your {{external_bank}} account {{external_account}} (Paystack mandate {{dd_reference}}); and
  b) A debit on your Alternative Bank account {{ab_account}}.

Please keep enough money in these accounts on each due date. We will not collect more than the instalment due.


6. IF A PAYMENT IS MISSED

If an instalment is not paid on time, we will contact you and continue to try to collect it through your mandates.

[Legal and Shariah to confirm: what happens after a missed payment, any late-payment charity undertaking, and the steps the bank may take.]


7. PAYING EARLY

You may pay off the remaining balance at any time. Contact us for the amount due.

[Legal and Shariah to confirm the early settlement terms.]


8. THE PHONE

The phone comes with the manufacturer's warranty and its standard accessories. Keep your receipt and this agreement.

[Product team to confirm the warranty period and any insurance cover before use.]


9. CANCELLING BEFORE HANDOVER

If this purchase is cancelled or not approved before the phone is handed to you, your down payment will be refunded under the bank's refund process.


10. YOUR INFORMATION

You agreed to a credit check using your BVN. We use your information only to provide this financing and to meet our legal obligations, in line with the Nigeria Data Protection Act.


11. QUESTIONS AND COMPLAINTS

Email {{support_email}}, quoting {{ref}}.


12. ACCEPTING THIS AGREEMENT

By giving the one-time code sent to {{customer_email}} to our officer, you confirm that you have read and understood this agreement and accept it. We keep a record of the exact text you accepted and when.`;
