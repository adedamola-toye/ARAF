/**
 * Customer categories for Relationship Manager origination. The stored values are the existing product-configuration
 * profiles (applications.customer_profile), so historical records keep their meaning.
 */
export type CustomerCategory = "BUSINESS_OWNER" | "SALARY_EARNER";

export const CUSTOMER_CATEGORIES: { code: CustomerCategory; slug: string; title: string; description: string }[] = [
  { code: "BUSINESS_OWNER", slug: "business", title: "Business Owner", description: "Financing solutions for business owners and entrepreneurs." },
  { code: "SALARY_EARNER", slug: "salaried", title: "Salaried Individual", description: "Financing solutions for customers in paid employment." },
];

export const categoryBySlug = (slug: string | null | undefined) => CUSTOMER_CATEGORIES.find((c) => c.slug === slug) ?? null;
export const categoryByCode = (code: string | null | undefined) => CUSTOMER_CATEGORIES.find((c) => c.code === code) ?? null;

/** WakeelBoost is merchant financing: business owners only (it has no product-configuration profiles). */
export const BUSINESS_ONLY_PRODUCTS = ["WAKEELBOOST"];

export const EMPLOYMENT_STATUSES: [string, string][] = [
  ["PERMANENT", "Permanent"],
  ["CONTRACT", "Contract"],
  ["PROBATION", "On probation"],
  ["OTHER", "Other"],
];
export const SALARY_FREQUENCIES: [string, string][] = [
  ["MONTHLY", "Monthly"],
  ["BI_WEEKLY", "Every two weeks"],
  ["WEEKLY", "Weekly"],
];
export const label = (list: [string, string][], v: string | null | undefined) => list.find(([k]) => k === v)?.[1] ?? "";
