/**
 * Approval workflow definitions (managed by Super Admins, versioned, pinned on each request at submission).
 *
 * A definition controls the routing decisions that are safe to configure:
 *  - retail business-review stages (Team Lead, Head of Retail Sales, Head of Unit): which apply, in what order,
 *    and amount conditions;
 *  - credit amount bands for WakeelBoost and the standard retail route: band boundaries and the first and second
 *    reviewer roles, within each role's existing credit authority.
 * Each stage's own checks (documents, assessments, photo review, verification checklist) stay in code and are
 * unchanged. Credit review, Unit Head and Divisional Head approvals, Altphones BPM / Product Manager / Unit Head
 * approvals and the originator-independence rules are mandatory and cannot be removed.
 *
 * This module is pure (no database) so the editor, the simulation and live routing all use the same logic.
 */

export type Family = "WAKEELBOOST" | "RETAIL" | "ALTPHONES";
export type BusinessStageType = "TEAM_LEAD_REVIEW" | "HRS_REVIEW" | "HEAD_OF_UNIT_APPROVAL";
export type RetailPolicy = "STANDARD" | "RETAIL_CX_V1";

export interface BusinessStage {
  stage: BusinessStageType;
  /** Applies only when the requested amount is within these bounds (kobo, inclusive); null = no bound. */
  minKobo: number | null;
  maxKobo: number | null;
  /** Head of Unit only: apply when the product configuration requires a distinct Head of Unit stage. */
  followProductConfig?: boolean;
}

export interface CreditBand {
  minKobo: number;
  maxKobo: number;
  firstReviewRoles: string[];
  secondReviewRoles: string[];
}

export interface WorkflowDefinition {
  schema: 1;
  family: Family;
  /** Retail: business-review stages for each approval policy (pinned on the request from its product configuration). */
  standard?: { businessStages: BusinessStage[] };
  cx?: { businessStages: BusinessStage[] };
  /** WakeelBoost and standard retail credit routing. */
  creditBands?: CreditBand[];
}

export const WORKFLOW_PRODUCTS: readonly { code: string; name: string; family: Family }[] = [
  { code: "WAKEELBOOST", name: "WakeelBoost", family: "WAKEELBOOST" },
  { code: "VENDOR_FINANCING", name: "Vendor Financing", family: "RETAIL" },
  { code: "ALT_DRIVE", name: "AltDrive", family: "RETAIL" },
  { code: "ALT_POWER", name: "AltPower", family: "RETAIL" },
  { code: "ALTPHONES", name: "Altphones", family: "ALTPHONES" },
];
export const workflowProduct = (code: string) => WORKFLOW_PRODUCTS.find((p) => p.code === code) ?? null;

/** Audit reference shown to the administrator after publication. */
export const auditReference = (productCode: string, version: number, id: string) => `WF-${productCode}-v${version}-${id.slice(0, 8).toUpperCase()}`;

export const MIN_KOBO = 100; // ₦1.00
export const MAX_KOBO = 5_000_000_000; // ₦50,000,000.00

export const STAGE_NAMES: Record<string, string> = {
  OSS_REVIEW: "Outlet Service Supervisor review",
  TEAM_LEAD_REVIEW: "Team Lead review",
  HRS_REVIEW: "Head of Retail Sales review",
  HEAD_OF_UNIT_APPROVAL: "Head of Unit approval",
  BUSINESS_ENDORSEMENT: "Business endorsement",
  MO_HEAD_REVIEW: "Merchant Officer Head review",
  FIRST_CREDIT_REVIEW: "First credit review",
  CX_CREDIT_REVIEW: "CX credit review",
  SECOND_CREDIT_REVIEW: "Second credit review (concurrence)",
  UNIT_HEAD_REVIEW: "Unit Head approval",
  DIVISIONAL_HEAD_REVIEW: "Divisional Head approval",
  ALT_BPM: "Business Performance Manager review",
  ALT_PM: "Product Manager review",
  ALT_UH: "Unit Head approval",
};

export const ROLE_NAMES: Record<string, string> = {
  TEAM_LEAD: "Team Lead",
  HEAD_OF_RETAIL_SALES: "Head of Retail Sales",
  HEAD_OF_UNIT: "Head of Unit",
  OUTLET_SERVICE_SUPERVISOR: "Outlet Service Supervisor",
  CREDIT_OFFICER_1: "Credit Officer 1",
  CREDIT_OFFICER_2: "Credit Officer 2",
  CREDIT_OFFICER_3: "Credit Officer 3",
  CREDIT_LEAD_1: "Credit Lead 1",
  CREDIT_LEAD_2: "Credit Lead 2",
  CX_CREDIT_REVIEWER: "CX Credit Reviewer",
  UNIT_HEAD: "Unit Head",
  DIVISIONAL_HEAD: "Divisional Head",
  RBE: "Regional Business Executive",
  MERCHANT_OFFICER_LEAD: "Merchant Officer Lead",
  MERCHANT_OFFICER_HEAD: "Merchant Officer Head",
  CX_GROUP_HEAD: "Group Head, Customer Experience",
  ANM_LEAD_NORTH: "ANM Lead (North)",
  ANM_LEAD_SOUTH: "ANM Lead (South)",
  BUSINESS_PERFORMANCE_MANAGER: "Business Performance Manager",
  ALTPHONES_PRODUCT_MANAGER: "Altphones Product Manager",
};

/** The authorised approver role for each business-review stage (one role per stage type). */
export const BUSINESS_STAGE_ROLE: Record<BusinessStageType, string> = {
  TEAM_LEAD_REVIEW: "TEAM_LEAD",
  HRS_REVIEW: "HEAD_OF_RETAIL_SALES",
  HEAD_OF_UNIT_APPROVAL: "HEAD_OF_UNIT",
};
export const BUSINESS_STAGE_TYPES = Object.keys(BUSINESS_STAGE_ROLE) as BusinessStageType[];

/**
 * Existing delegated credit authority (highest amount, kobo) for each role at each review level, taken from the
 * credit routing in force before workflows became configurable. A band may only be assigned roles whose authority
 * covers the band's upper limit; assigning a more senior role is always allowed.
 */
export const CREDIT_AUTHORITY: { first: Record<string, number>; second: Record<string, number> } = {
  first: { CREDIT_OFFICER_1: 500_000_000, CREDIT_OFFICER_2: 2_000_000_000, CREDIT_OFFICER_3: 5_000_000_000 },
  second: { CREDIT_OFFICER_2: 500_000_000, CREDIT_OFFICER_3: 2_000_000_000, CREDIT_LEAD_1: 5_000_000_000, CREDIT_LEAD_2: 5_000_000_000 },
};

/** The credit routing table in force before configurable workflows (version 1 of every product). */
export const DEFAULT_CREDIT_BANDS: CreditBand[] = [
  { minKobo: 100, maxKobo: 500_000_000, firstReviewRoles: ["CREDIT_OFFICER_1"], secondReviewRoles: ["CREDIT_OFFICER_2", "CREDIT_OFFICER_3"] },
  { minKobo: 500_000_001, maxKobo: 2_000_000_000, firstReviewRoles: ["CREDIT_OFFICER_2"], secondReviewRoles: ["CREDIT_LEAD_1", "CREDIT_LEAD_2", "CREDIT_OFFICER_3"] },
  { minKobo: 2_000_000_001, maxKobo: 5_000_000_000, firstReviewRoles: ["CREDIT_OFFICER_3"], secondReviewRoles: ["CREDIT_LEAD_1", "CREDIT_LEAD_2"] },
];

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Version 1 for each product: exactly the routing in force before workflows became configurable. */
export function defaultDefinition(family: Family): WorkflowDefinition {
  if (family === "WAKEELBOOST") return { schema: 1, family, creditBands: clone(DEFAULT_CREDIT_BANDS) };
  if (family === "ALTPHONES") return { schema: 1, family };
  return {
    schema: 1,
    family,
    standard: {
      businessStages: [
        { stage: "TEAM_LEAD_REVIEW", minKobo: null, maxKobo: null },
        { stage: "HRS_REVIEW", minKobo: null, maxKobo: null },
        { stage: "HEAD_OF_UNIT_APPROVAL", minKobo: null, maxKobo: null, followProductConfig: true },
      ],
    },
    cx: { businessStages: [{ stage: "TEAM_LEAD_REVIEW", minKobo: null, maxKobo: null }] },
    creditBands: clone(DEFAULT_CREDIT_BANDS),
  };
}

// ------------------------------------------------------------------ formatting

export function naira(kobo: number): string {
  const n = kobo / 100;
  return `₦${n.toLocaleString("en-NG", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}
const roleList = (r: string[]) => r.map((x) => ROLE_NAMES[x] ?? x).join(" / ");
export const bandLabel = (b: CreditBand, i: number) => `Route ${i + 1} (${naira(b.minKobo)} – ${naira(b.maxKobo)}): ${roleList(b.firstReviewRoles)} → ${roleList(b.secondReviewRoles)}`;
export function conditionLabel(s: { minKobo: number | null; maxKobo: number | null }): string | null {
  if (s.minKobo === null && s.maxKobo === null) return null;
  if (s.minKobo !== null && s.maxKobo !== null) return `${naira(s.minKobo)} – ${naira(s.maxKobo)}`;
  return s.minKobo !== null ? `from ${naira(s.minKobo)}` : `up to ${naira(s.maxKobo!)}`;
}

// ------------------------------------------------------------------ routing (used by live requests and the simulation)

export interface BusinessRouteInput {
  policy: RetailPolicy;
  amountKobo: number;
  initiatorRole: string;
  /** Product configuration requires a distinct Head of Unit stage. */
  headOfUnitDistinct: boolean;
  /** Relationship Manager classification pinned on the request (NON_DBC follows the confirmed Non-DBC route). */
  segment?: "DBC" | "NON_DBC" | null;
}

const inBounds = (s: { minKobo: number | null; maxKobo: number | null }, amount: number) => (s.minKobo === null || amount >= s.minKobo) && (s.maxKobo === null || amount <= s.maxKobo);

/**
 * Retail business-review stages for a request, in order. Fixed rules: requests started by a Delight Officer
 * (before that channel was retired) begin with the Outlet Service Supervisor on the standard route; under the CX
 * policy a Team Lead's or Unit Head's own request skips Team Lead certification (it is not independent).
 */
export function retailBusinessStages(def: WorkflowDefinition, i: BusinessRouteInput): string[] {
  // Non-DBC Relationship Managers: the assigned RBE, then CX credit review, then credit by amount.
  if (i.segment === "NON_DBC" && i.initiatorRole === "RM") return ["BUSINESS_ENDORSEMENT", "CX_CREDIT_REVIEW"];
  // Merchant Officer hierarchy originators: a Lead's request goes to the Merchant Officer Head; a Head's request
  // has no further business review (it is not reviewed by its own originator) and goes to credit.
  if (i.initiatorRole === "MERCHANT_OFFICER_LEAD") return ["MO_HEAD_REVIEW"];
  if (i.initiatorRole === "MERCHANT_OFFICER_HEAD") return [];
  const list = (i.policy === "RETAIL_CX_V1" ? def.cx : def.standard)?.businessStages ?? [];
  const out: string[] = [];
  if (i.policy !== "RETAIL_CX_V1" && i.initiatorRole === "DELIGHT_OFFICER") out.push("OSS_REVIEW");
  for (const s of list) {
    if (!inBounds(s, i.amountKobo)) continue;
    if (s.stage === "HEAD_OF_UNIT_APPROVAL" && s.followProductConfig && !i.headOfUnitDistinct) continue;
    if (s.stage === "TEAM_LEAD_REVIEW" && i.policy === "RETAIL_CX_V1" && (i.initiatorRole === "TEAM_LEAD" || i.initiatorRole === "UNIT_HEAD")) continue;
    out.push(s.stage);
  }
  return out;
}

/** The business stage after `current` (null = business review is complete; go to credit). */
export function nextBusinessStage(stages: string[], current: string | null): string | null {
  if (current === null) return stages[0] ?? null;
  const i = stages.indexOf(current);
  // A stage no longer on the route (e.g. after a material change): continue with the first stage not yet passed.
  if (i < 0) return null;
  return stages[i + 1] ?? null;
}

export interface Band extends CreditBand {
  route: number;
  label: string;
}

export function bandFor(def: WorkflowDefinition, amountKobo: number): Band | null {
  const bands = def.creditBands ?? DEFAULT_CREDIT_BANDS;
  const i = bands.findIndex((b) => amountKobo >= b.minKobo && amountKobo <= b.maxKobo);
  return i < 0 ? null : { ...bands[i], route: i + 1, label: bandLabel(bands[i], i) };
}

export function bandByRoute(def: WorkflowDefinition, route: number | null): Band | null {
  const bands = def.creditBands ?? DEFAULT_CREDIT_BANDS;
  if (!route || route < 1 || route > bands.length) return null;
  return { ...bands[route - 1], route, label: bandLabel(bands[route - 1], route - 1) };
}

export interface PlannedStage {
  stage: string;
  name: string;
  roles: string[];
  note?: string;
}

export interface SimulationInput {
  amountKobo: number;
  /** Retail: approval policy from the product configuration in force. */
  policy?: RetailPolicy;
  initiatorRole: string;
  headOfUnitDistinct?: boolean;
  /** Altphones: DO (Delight Officer) or SA (Smile Associate). */
  channel?: "DO" | "SA";
  /** Relationship Managers: DBC or Non-DBC classification (null: not yet classified, existing route). */
  segment?: "DBC" | "NON_DBC" | null;
}

/** The expected approval route. Live routing uses the same functions, so this is what a submission would do. */
export function planRoute(def: WorkflowDefinition, i: SimulationInput): { stages: PlannedStage[]; errors: string[] } {
  const errors: string[] = [];
  const stages: PlannedStage[] = [];
  const credit = (): boolean => {
    const b = bandFor(def, i.amountKobo);
    if (!b) {
      errors.push(`No credit route covers ${naira(i.amountKobo)}. The request could not be routed.`);
      return false;
    }
    stages.push({ stage: "FIRST_CREDIT_REVIEW", name: STAGE_NAMES.FIRST_CREDIT_REVIEW, roles: b.firstReviewRoles, note: `Route ${b.route} (${naira(b.minKobo)} – ${naira(b.maxKobo)})` });
    stages.push({ stage: "SECOND_CREDIT_REVIEW", name: STAGE_NAMES.SECOND_CREDIT_REVIEW, roles: b.secondReviewRoles, note: "Assigned at random among the eligible roles; never the first reviewer" });
    return true;
  };
  if (def.family === "ALTPHONES") {
    if (i.channel === "SA") stages.push({ stage: "ALT_BPM", name: STAGE_NAMES.ALT_BPM, roles: ["BUSINESS_PERFORMANCE_MANAGER"], note: "The BPM mapped to the sale's location" });
    stages.push({ stage: "ALT_PM", name: STAGE_NAMES.ALT_PM, roles: ["ALTPHONES_PRODUCT_MANAGER"] });
    stages.push({ stage: "ALT_UH", name: STAGE_NAMES.ALT_UH, roles: ["UNIT_HEAD"] });
    return { stages, errors };
  }
  const nonDbc = i.segment === "NON_DBC" && i.initiatorRole === "RM";
  const unitHead = () =>
    stages.push({
      stage: "UNIT_HEAD_REVIEW",
      name: nonDbc ? "E-commerce Unit Head approval" : STAGE_NAMES.UNIT_HEAD_REVIEW,
      roles: ["UNIT_HEAD"],
      note: nonDbc ? "The configured E-commerce Unit Head" : i.segment === "DBC" && i.initiatorRole === "RM" ? "The DBC Unit Head for the RM's region" : undefined,
    });
  if (nonDbc) {
    // Confirmed Non-DBC route: RBE → CX → Credit Officer by amount (with concurrence) → E-commerce Unit Head → Divisional Head.
    stages.push({ stage: "BUSINESS_ENDORSEMENT", name: "Regional Business Executive approval", roles: ["RBE"], note: "The RM's assigned RBE" });
    stages.push({ stage: "CX_CREDIT_REVIEW", name: STAGE_NAMES.CX_CREDIT_REVIEW, roles: ["CX_CREDIT_REVIEWER"] });
    if (credit()) {
      unitHead();
      stages.push({ stage: "DIVISIONAL_HEAD_REVIEW", name: STAGE_NAMES.DIVISIONAL_HEAD_REVIEW, roles: ["DIVISIONAL_HEAD"] });
    }
    return { stages, errors };
  }
  if (def.family === "WAKEELBOOST") {
    const mo = i.initiatorRole === "MERCHANT_OFFICER" || i.initiatorRole === "MERCHANT_OFFICER_LEAD" || i.initiatorRole === "MERCHANT_OFFICER_HEAD";
    if (!mo || i.initiatorRole === "MERCHANT_OFFICER") {
      const endorser = i.initiatorRole === "MERCHANT_OFFICER" ? ["MERCHANT_OFFICER_LEAD"] : i.initiatorRole === "ANM" ? ["ANM_LEAD_NORTH", "ANM_LEAD_SOUTH"] : ["RBE"];
      stages.push({ stage: "BUSINESS_ENDORSEMENT", name: STAGE_NAMES.BUSINESS_ENDORSEMENT, roles: endorser, note: i.initiatorRole === "ANM" ? "The ANM Lead for the request's zone" : i.initiatorRole === "MERCHANT_OFFICER" ? "The officer's Merchant Officer Lead" : undefined });
    }
    if (i.initiatorRole === "MERCHANT_OFFICER" || i.initiatorRole === "MERCHANT_OFFICER_LEAD") stages.push({ stage: "MO_HEAD_REVIEW", name: STAGE_NAMES.MO_HEAD_REVIEW, roles: ["MERCHANT_OFFICER_HEAD"], note: "The Lead's Merchant Officer Head" });
    if (credit()) {
      unitHead();
      stages.push({ stage: "DIVISIONAL_HEAD_REVIEW", name: STAGE_NAMES.DIVISIONAL_HEAD_REVIEW, roles: ["DIVISIONAL_HEAD"] });
    }
    return { stages, errors };
  }
  const policy = i.policy ?? "STANDARD";
  for (const s of retailBusinessStages(def, { policy, amountKobo: i.amountKobo, initiatorRole: i.initiatorRole, headOfUnitDistinct: !!i.headOfUnitDistinct })) {
    stages.push({ stage: s, name: STAGE_NAMES[s], roles: s === "OSS_REVIEW" ? ["OUTLET_SERVICE_SUPERVISOR"] : s === "MO_HEAD_REVIEW" ? ["MERCHANT_OFFICER_HEAD"] : [BUSINESS_STAGE_ROLE[s as BusinessStageType]] });
  }
  if (policy === "RETAIL_CX_V1") {
    if ((i.initiatorRole === "TEAM_LEAD" || i.initiatorRole === "UNIT_HEAD") && !stages.length) stages.push({ stage: "NOTE", name: "Routing rule", roles: [], note: "The originator's own certification is not independent, so the request goes straight to CX credit review." });
    stages.push({ stage: "CX_CREDIT_REVIEW", name: STAGE_NAMES.CX_CREDIT_REVIEW, roles: ["CX_CREDIT_REVIEWER"], note: "Not routed by amount" });
    if (i.initiatorRole !== "UNIT_HEAD") unitHead();
    stages.push({ stage: "DIVISIONAL_HEAD_REVIEW", name: STAGE_NAMES.DIVISIONAL_HEAD_REVIEW, roles: ["DIVISIONAL_HEAD"], note: i.initiatorRole === "UNIT_HEAD" ? "A Unit Head's own request moves forward to the Divisional Head" : undefined });
    return { stages, errors };
  }
  if (credit()) {
    unitHead();
    stages.push({ stage: "DIVISIONAL_HEAD_REVIEW", name: STAGE_NAMES.DIVISIONAL_HEAD_REVIEW, roles: ["DIVISIONAL_HEAD"] });
  }
  return { stages, errors };
}

// ------------------------------------------------------------------ validation (governance)

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);

/** Problems that block publication. Empty = the definition is valid. */
export function validateDefinition(def: WorkflowDefinition, family: Family): string[] {
  const e: string[] = [];
  if (def.schema !== 1 || def.family !== family) return ["The workflow does not belong to this product."];
  if (family === "ALTPHONES") {
    if (def.standard || def.cx || def.creditBands) e.push("Altphones approvals (BPM, Product Manager, Unit Head) are mandatory and cannot be changed here.");
    return e;
  }
  // Credit bands: complete, non-overlapping coverage; independent first and second review; delegated authority.
  const bands = def.creditBands ?? [];
  if (!bands.length) e.push("Add at least one credit route: requests would have no credit approval route.");
  if (bands.length > 8) e.push("Use at most 8 credit routes.");
  bands.forEach((b, i) => {
    const n = `Route ${i + 1}`;
    if (!isInt(b.minKobo) || !isInt(b.maxKobo) || b.minKobo > b.maxKobo) e.push(`${n}: the lower limit must not be above the upper limit.`);
    if (!b.firstReviewRoles.length) e.push(`${n}: choose at least one first credit reviewer role.`);
    if (!b.secondReviewRoles.length) e.push(`${n}: choose at least one second credit reviewer role (concurrence is mandatory).`);
    for (const r of b.firstReviewRoles) {
      const auth = CREDIT_AUTHORITY.first[r];
      if (auth === undefined) e.push(`${n}: ${ROLE_NAMES[r] ?? r} is not an authorised first credit reviewer.`);
      else if (auth < b.maxKobo) e.push(`${n}: ${ROLE_NAMES[r]} has first-review authority only up to ${naira(auth)}, below this route's ${naira(b.maxKobo)}.`);
    }
    for (const r of b.secondReviewRoles) {
      const auth = CREDIT_AUTHORITY.second[r];
      if (auth === undefined) e.push(`${n}: ${ROLE_NAMES[r] ?? r} is not an authorised second credit reviewer.`);
      else if (auth < b.maxKobo) e.push(`${n}: ${ROLE_NAMES[r]} has concurrence authority only up to ${naira(auth)}, below this route's ${naira(b.maxKobo)}.`);
    }
    const both = b.firstReviewRoles.filter((r) => b.secondReviewRoles.includes(r));
    if (both.length) e.push(`${n}: ${both.map((r) => ROLE_NAMES[r] ?? r).join(", ")} cannot be both first reviewer and concurring reviewer.`);
    if (new Set(b.firstReviewRoles).size !== b.firstReviewRoles.length || new Set(b.secondReviewRoles).size !== b.secondReviewRoles.length) e.push(`${n}: a role is listed twice.`);
  });
  const sorted = [...bands].filter((b) => isInt(b.minKobo) && isInt(b.maxKobo)).sort((a, b) => a.minKobo - b.minKobo);
  if (sorted.length && sorted[0].minKobo !== MIN_KOBO) e.push(`Credit routes must start at ${naira(MIN_KOBO)}: amounts below ${naira(sorted[0].minKobo)} would have no route.`);
  if (sorted.length && sorted[sorted.length - 1].maxKobo !== MAX_KOBO) e.push(`Credit routes must end at ${naira(MAX_KOBO)}: amounts above ${naira(sorted[sorted.length - 1].maxKobo)} would have no route.`);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (b.minKobo <= a.maxKobo) e.push(`Credit routes overlap between ${naira(b.minKobo)} and ${naira(Math.min(a.maxKobo, b.maxKobo))}.`);
    else if (b.minKobo > a.maxKobo + 1) e.push(`No credit route covers ${naira(a.maxKobo + 1)} – ${naira(b.minKobo - 1)}.`);
  }
  if (bands.some((b, i) => i > 0 && b.minKobo < bands[i - 1].minKobo)) e.push("List the credit routes from the lowest amount to the highest.");
  if (family === "WAKEELBOOST") {
    if (def.standard || def.cx) e.push("WakeelBoost business endorsement is fixed by channel and cannot be changed here.");
    return e;
  }
  for (const [key, label] of [["standard", "Standard route"], ["cx", "CX route"]] as const) {
    const stages = def[key]?.businessStages;
    if (!stages) {
      e.push(`${label}: missing.`);
      continue;
    }
    const seen = new Set<string>();
    stages.forEach((s, i) => {
      if (!BUSINESS_STAGE_TYPES.includes(s.stage)) e.push(`${label}: ${s.stage} is not a business-review stage.`);
      if (seen.has(s.stage)) e.push(`${label}: ${STAGE_NAMES[s.stage] ?? s.stage} appears twice, which would loop the request back to the same approver.`);
      seen.add(s.stage);
      if ((s.minKobo !== null && !isInt(s.minKobo)) || (s.maxKobo !== null && !isInt(s.maxKobo))) e.push(`${label}: ${STAGE_NAMES[s.stage]} has an invalid amount condition.`);
      else {
        if (s.minKobo !== null && s.maxKobo !== null && s.minKobo > s.maxKobo) e.push(`${label}: ${STAGE_NAMES[s.stage]} condition: the lower amount is above the upper amount.`);
        if ((s.minKobo !== null && s.minKobo > MAX_KOBO) || (s.maxKobo !== null && s.maxKobo < MIN_KOBO)) e.push(`${label}: ${STAGE_NAMES[s.stage]} can never be reached (its amount condition is outside ${naira(MIN_KOBO)} – ${naira(MAX_KOBO)}).`);
      }
      if (s.followProductConfig && s.stage !== "HEAD_OF_UNIT_APPROVAL") e.push(`${label}: only the Head of Unit stage can follow the product configuration.`);
      if (s.stage === "TEAM_LEAD_REVIEW" && i !== 0) e.push(`${label}: Team Lead review must be the first business review (it certifies the originator's analysis).`);
    });
    const tl = stages.find((s) => s.stage === "TEAM_LEAD_REVIEW");
    if (!tl) e.push(`${label}: Team Lead review is mandatory: it is the independent first-level review of the originator's work.`);
    else if (tl.minKobo !== null || tl.maxKobo !== null) e.push(`${label}: Team Lead review must apply to every amount.`);
  }
  return e;
}

// ------------------------------------------------------------------ comparison

export interface Change {
  kind: "ADDED" | "REMOVED" | "MOVED" | "CONDITION" | "THRESHOLD" | "APPROVER" | "ROUTE_ADDED" | "ROUTE_REMOVED";
  text: string;
}

export function diffDefinitions(a: WorkflowDefinition, b: WorkflowDefinition): Change[] {
  const out: Change[] = [];
  for (const [key, label] of [["standard", "Standard route"], ["cx", "CX route"]] as const) {
    const x = a[key]?.businessStages ?? [];
    const y = b[key]?.businessStages ?? [];
    const xs = x.map((s) => s.stage);
    const ys = y.map((s) => s.stage);
    for (const s of y) if (!xs.includes(s.stage)) out.push({ kind: "ADDED", text: `${label}: ${STAGE_NAMES[s.stage]} added${conditionLabel(s) ? ` (${conditionLabel(s)})` : ""}.` });
    for (const s of x) if (!ys.includes(s.stage)) out.push({ kind: "REMOVED", text: `${label}: ${STAGE_NAMES[s.stage]} removed.` });
    const common = xs.filter((s) => ys.includes(s));
    const order = ys.filter((s) => xs.includes(s));
    if (common.join() !== order.join()) out.push({ kind: "MOVED", text: `${label}: business reviews reordered to ${order.map((s) => STAGE_NAMES[s]).join(" → ")}.` });
    for (const s of y) {
      const p = x.find((q) => q.stage === s.stage);
      if (!p) continue;
      if (p.minKobo !== s.minKobo || p.maxKobo !== s.maxKobo) out.push({ kind: "CONDITION", text: `${label}: ${STAGE_NAMES[s.stage]} condition ${conditionLabel(p) ?? "all amounts"} → ${conditionLabel(s) ?? "all amounts"}.` });
      if (!!p.followProductConfig !== !!s.followProductConfig) out.push({ kind: "CONDITION", text: `${label}: ${STAGE_NAMES[s.stage]} ${s.followProductConfig ? "now follows the product configuration" : "now applies regardless of the product configuration"}.` });
    }
  }
  const xb = a.creditBands ?? [];
  const yb = b.creditBands ?? [];
  const n = Math.max(xb.length, yb.length);
  for (let i = 0; i < n; i++) {
    const p = xb[i];
    const q = yb[i];
    if (!p) out.push({ kind: "ROUTE_ADDED", text: `Credit route ${i + 1} added: ${bandLabel(q, i)}.` });
    else if (!q) out.push({ kind: "ROUTE_REMOVED", text: `Credit route ${i + 1} removed (was ${naira(p.minKobo)} – ${naira(p.maxKobo)}).` });
    else {
      if (p.minKobo !== q.minKobo || p.maxKobo !== q.maxKobo) out.push({ kind: "THRESHOLD", text: `Credit route ${i + 1}: ${naira(p.minKobo)} – ${naira(p.maxKobo)} → ${naira(q.minKobo)} – ${naira(q.maxKobo)}.` });
      if (p.firstReviewRoles.join() !== q.firstReviewRoles.join()) out.push({ kind: "APPROVER", text: `Credit route ${i + 1} first review: ${roleList(p.firstReviewRoles)} → ${roleList(q.firstReviewRoles)}.` });
      if (p.secondReviewRoles.join() !== q.secondReviewRoles.join()) out.push({ kind: "APPROVER", text: `Credit route ${i + 1} concurrence: ${roleList(p.secondReviewRoles)} → ${roleList(q.secondReviewRoles)}.` });
    }
  }
  return out;
}

/** Normalise untrusted input (from the editor) into a definition, or throw a message. */
export function parseDefinition(raw: unknown, family: Family): WorkflowDefinition {
  if (!raw || typeof raw !== "object") throw new Error("The workflow could not be read.");
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : typeof v === "number" ? v : Number.NaN);
  const stages = (v: unknown): BusinessStage[] =>
    Array.isArray(v)
      ? v.map((s) => {
          const o = (s ?? {}) as Record<string, unknown>;
          const st: BusinessStage = { stage: String(o.stage) as BusinessStageType, minKobo: num(o.minKobo), maxKobo: num(o.maxKobo) };
          if (o.followProductConfig === true) st.followProductConfig = true;
          return st;
        })
      : [];
  const def: WorkflowDefinition = { schema: 1, family };
  if (family === "RETAIL") {
    def.standard = { businessStages: stages((r.standard as Record<string, unknown> | undefined)?.businessStages) };
    def.cx = { businessStages: stages((r.cx as Record<string, unknown> | undefined)?.businessStages) };
  }
  if (family !== "ALTPHONES") {
    def.creditBands = Array.isArray(r.creditBands)
      ? r.creditBands.map((b) => {
          const o = (b ?? {}) as Record<string, unknown>;
          const roles = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
          return { minKobo: num(o.minKobo) ?? Number.NaN, maxKobo: num(o.maxKobo) ?? Number.NaN, firstReviewRoles: roles(o.firstReviewRoles), secondReviewRoles: roles(o.secondReviewRoles) };
        })
      : [];
  }
  return def;
}

/** Key-order-independent JSON (stored definitions come back from jsonb with their keys reordered). */
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object")
    return `{${Object.keys(x as Record<string, unknown>)
      .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(x);
}
export const sameDefinition = (a: WorkflowDefinition, b: WorkflowDefinition) => canonical(a) === canonical(b);
