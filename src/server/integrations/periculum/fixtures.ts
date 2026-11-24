/**
 * LABELLED TEST DATA — not Periculum results.
 *
 * An in-memory stand-in for the documented Periculum endpoints (token, PUT /statements, GET /statements/{key},
 * GET /statements/{key}/transactions), used by tests and by PERICULUM_MODE=fixture in development. Responses
 * follow the documented shapes so the real client, validation and pipeline run unchanged; every payload carries
 * `_fixture` and is stored with source FIXTURE, so it is never presented as a Periculum result.
 *
 * A test statement describes itself with a directive in its text, e.g.
 *   PERICULUM-FIXTURE bank=Sterling Bank;account=0123456789;name=ADA OBI;kind=SALARY;salary=450000;months=6;start=2026-05
 * Keys: bank, account, name, kind (SALARY|BUSINESS), salary, turnover, months, start (YYYY-MM), loanRepayment,
 * selfTransferOut, selfTransferTo, otherIncome, spend, status (final processingStatus), password, polls.
 */
const FIXTURE_LABEL = "ARAF test data - not a Periculum result";

interface Spec {
  bank: string;
  account: string;
  name: string;
  kind: "SALARY" | "BUSINESS";
  salary: number;
  turnover: number;
  months: number;
  start: string;
  loanRepayment: number;
  selfTransferOut: number;
  selfTransferTo: string;
  otherIncome: number;
  spend: number;
  status: string;
  password: string | null;
  polls: number;
}

interface Stored {
  key: number;
  name: string;
  statementType: string;
  spec: Spec;
  polls: number;
  createdDate: string;
}

const state = { nextKey: 70_000 + (Date.now() % 10_000), byKey: new Map<number, Stored>(), names: new Set<string>() };

/** Tests: start from a clean fake vendor. */
export function resetFixtureVendor() {
  state.byKey.clear();
  state.names.clear();
}

export function parseFixtureSpec(text: string): Spec {
  const m = /PERICULUM-FIXTURE ([^\n)]*)/.exec(text);
  const kv: Record<string, string> = {};
  for (const part of (m?.[1] ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) kv[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  const n = (k: string, d = 0) => (kv[k] !== undefined && kv[k] !== "" ? Number(kv[k]) : d);
  return {
    bank: kv.bank ?? "Test Bank",
    account: kv.account ?? "0000000000",
    name: kv.name ?? "TEST CUSTOMER",
    kind: kv.kind === "BUSINESS" ? "BUSINESS" : "SALARY",
    salary: n("salary", kv.kind === "BUSINESS" ? 0 : 300_000),
    turnover: n("turnover", 0),
    months: Math.max(1, Math.min(24, n("months", 6))),
    start: kv.start ?? "2026-05",
    loanRepayment: n("loanRepayment"),
    selfTransferOut: n("selfTransferOut"),
    selfTransferTo: kv.selfTransferTo ?? "",
    otherIncome: n("otherIncome"),
    spend: n("spend", 50_000),
    status: kv.status ?? "PROCESSED",
    password: kv.password ?? null,
    polls: Math.max(0, n("polls", 1)),
  };
}

const MONTHS = ["January", "Febuary", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]; // vendor spelling
const pad = (x: number) => String(x).padStart(2, "0");

function monthList(spec: Spec) {
  const [y0, m0] = spec.start.split("-").map(Number);
  return Array.from({ length: spec.months }, (_, i) => {
    const t = (m0 - 1 + i) % 12;
    return { y: y0 + Math.floor((m0 - 1 + i) / 12), m: t + 1 };
  });
}

/** Deterministic transactions in the documented shape (date, amount, type, description, balance). */
export function fixtureTransactions(spec: Spec) {
  const tx: { date: string; amount: number; type: "credit" | "debit"; description: string; balance: number }[] = [];
  let bal = 25_000;
  const push = (date: string, amount: number, type: "credit" | "debit", description: string) => {
    if (amount <= 0) return;
    bal = Math.round((bal + (type === "credit" ? amount : -amount)) * 100) / 100;
    tx.push({ date, amount, type, description, balance: bal });
  };
  for (const { y, m } of monthList(spec)) {
    const d = (day: number) => `${y}-${pad(m)}-${pad(day)}`;
    if (spec.salary) push(d(25), spec.salary, "credit", `salary ${MONTHS[m - 1].toLowerCase()} payroll credit`);
    if (spec.turnover) {
      push(d(5), Math.round(spec.turnover * 0.4), "credit", "nip transfer from customer invoice payment");
      push(d(15), Math.round(spec.turnover * 0.35), "credit", "pos settlement credit");
      push(d(22), spec.turnover - Math.round(spec.turnover * 0.4) - Math.round(spec.turnover * 0.35), "credit", "trf from distributor for goods");
    }
    if (spec.otherIncome) push(d(10), spec.otherIncome, "credit", "trf rental income");
    if (spec.loanRepayment) push(d(27), spec.loanRepayment, "debit", "loan repayment renmoney");
    if (spec.selfTransferOut) push(d(26), spec.selfTransferOut, "debit", `trf to self ${spec.name.toLowerCase()} ${spec.selfTransferTo}`.trim());
    if (spec.spend) push(d(28), spec.spend, "debit", "pos purchase supermarket");
  }
  return tx;
}

function fixtureAnalytics(s: Stored, status: string) {
  const spec = s.spec;
  const tx = fixtureTransactions(spec);
  const months = monthList(spec);
  const credits = tx.filter((t) => t.type === "credit");
  const debits = tx.filter((t) => t.type === "debit");
  const sum = (a: { amount: number }[]) => Math.round(a.reduce((x, t) => x + t.amount, 0) * 100) / 100;
  const per = (type: "credit" | "debit") => months.map(({ y, m }) => ({ year: String(y), month_name: MONTHS[m - 1], amount: sum(tx.filter((t) => t.type === type && t.date.startsWith(`${y}-${pad(m)}`))) }));
  const salaryTx = credits.filter((t) => t.description.startsWith("salary"));
  const loanTx = debits.filter((t) => t.description.startsWith("loan repayment"));
  const selfOut = debits.filter((t) => t.description.startsWith("trf to self"));
  const first = tx[0]?.date ?? null;
  const last = tx[tx.length - 1]?.date ?? null;
  return {
    _fixture: FIXTURE_LABEL,
    key: s.key,
    uniqueCode: null,
    name: s.name,
    source: "PDF",
    clientFullName: spec.name,
    accountType: spec.kind === "BUSINESS" ? "CURRENT" : "SAVINGS",
    accountBalance: tx[tx.length - 1]?.balance ?? 0,
    accountId: spec.account,
    accountName: spec.name,
    bankName: spec.bank,
    statementType: s.statementType,
    startDate: first ? `${first}T00:00:00` : null,
    endDate: last ? `${last}T00:00:00` : null,
    createdDate: s.createdDate,
    processingStatus: status,
    confidenceOnParsing: 0.98,
    cashFlowAnalysis: {
      totalCreditTurnover: sum(credits),
      totalDebitTurnOver: sum(debits),
      averageMonthlyCredits: Math.round((sum(credits) / months.length) * 100) / 100,
      averageMonthlyDebits: Math.round((sum(debits) / months.length) * 100) / 100,
      numberOfTransactingMonths: months.length,
      monthlyInflow: per("credit"),
      monthlyOutflow: per("debit"),
      firstDateInStatement: first,
      lastDateInStatement: last,
      closingBalance: tx[tx.length - 1]?.balance ?? 0,
    },
    incomeAnalysis: {
      salaryTransactions: salaryTx.map((t) => ({ date: `${t.date} 00:00:00`, description: t.description, amount: t.amount })),
      averagePredictedSalary: salaryTx.length ? sum(salaryTx) / salaryTx.length : 0,
      isSalaryEarner: salaryTx.length ? "Yes" : "No",
      numberOfSalaryPayments: salaryTx.length,
      hasOtherIncome: spec.otherIncome ? "Yes" : "No",
      averageOtherIncome: spec.otherIncome,
    },
    behavioralAnalysis: {
      totalLoanRepaymentAmount: sum(loanTx),
      averageMonthlyLoanRepaymentAmount: loanTx.length ? sum(loanTx) / months.length : 0,
      numberRepaymentTransactions: loanTx.length,
      loanRepaymentTransactions: loanTx.map((t) => ({ date: `${t.date} 00:00:00`, amount: t.amount, description: t.description })),
    },
    transactionPatternAnalysis: {
      totalNumberOfTransactions: tx.length,
      noOfSelfTransferOutflows: selfOut.length,
      selfTransferOutflowAmount: sum(selfOut),
      selfTransferOutflowTransactions: selfOut.map((t) => ({ date: `${t.date} 00:00:00`, amount: t.amount })),
      noOfSelfTransferInflows: 0,
      selfTransferInflowAmount: 0,
      selfTransferInflowTransactions: [],
    },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The fake vendor (same signature as fetch). */
export async function fixtureFetch(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url);
  const method = (init.method ?? "GET").toUpperCase();
  if (u.pathname.endsWith("/protocol/openid-connect/token")) {
    return json(200, { access_token: "fixture-token", expires_in: 86400, refresh_expires_in: 0, token_type: "Bearer", scope: "profile audience email" });
  }
  if (method === "PUT" && u.pathname === "/statements") {
    const form = init.body as FormData;
    const file = form.get("file") as File | null;
    if (!file) return json(400, { message: "Please Upload a File" });
    const text = Buffer.from(await file.arrayBuffer()).toString("latin1");
    if (!text.startsWith("%PDF")) return json(400, { message: "Kindly upload a PDF file" });
    const spec = parseFixtureSpec(text);
    if (spec.password && String(form.get("password") ?? "") !== spec.password) return json(400, { message: "PDF is protected - Password required or incorrect password." });
    if (state.names.has(file.name)) return json(400, { message: "A statement with the same name has already been analyzed. Please rename and upload this statement again." });
    state.names.add(file.name);
    const s: Stored = { key: state.nextKey++, name: file.name, statementType: String(form.get("statementType") ?? "CONSUMER").toUpperCase(), spec, polls: 0, createdDate: new Date().toISOString() };
    state.byKey.set(s.key, s);
    return json(200, {
      ...fixtureAnalytics(s, "UPLOADED"),
      cashFlowAnalysis: null,
      incomeAnalysis: null,
      behavioralAnalysis: null,
      transactionPatternAnalysis: null,
      startDate: null,
      endDate: null,
      bankName: null,
      accountId: null,
      accountName: null,
    });
  }
  const m = /^\/statements\/(\d+)(\/transactions)?$/.exec(u.pathname);
  if (method === "GET" && m) {
    const s = state.byKey.get(Number(m[1]));
    if (!s) return json(404, { message: "Statement not found" });
    if (m[2]) return json(200, fixtureTransactions(s.spec));
    s.polls++;
    const status = s.polls <= s.spec.polls ? "PROCESSING" : s.spec.status;
    if (status === "PROCESSED" || status === "ALTERED") return json(200, fixtureAnalytics(s, status));
    return json(200, { ...fixtureAnalytics(s, status), cashFlowAnalysis: null, incomeAnalysis: null, behavioralAnalysis: null, transactionPatternAnalysis: null });
  }
  return json(404, { message: "Not found" });
}
