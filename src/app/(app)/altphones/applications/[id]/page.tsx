import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { requireUser } from "../../../../_lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { ActionForm, SubmitButton } from "@/components/forms";
import { db } from "@/server/db";
import { DomainError } from "@/server/errors";
import { formatLagos } from "@/server/time";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { creditReadiness, currentSettings, routeUnitHead, settingsById, viewableApp, type AltApp } from "@/server/altphones/core";
import { paymentGateway } from "@/server/altphones/integrations";
import { INTERNAL_MANDATE_WORDING, submissionBlockers } from "@/server/altphones/origination";
import { issuableDevices, supplyOptions } from "@/server/altphones/stock";
import { ALT_STATUS_LABELS, formatNaira, REVIEW_STATUSES, SCORE_OUTCOME_LABELS, type AltStatus } from "@/lib/altphones";
import { AltStatusBadge, Check, KindBadge, PhoneImage, ScheduleTable, TermsTable } from "../../ui";
import { AccountFields, CopyLink, TenureCalculator } from "../../AltClient";
import { ALTERNATIVE_BANK_CODE, otherBanks } from "@/server/altphones/banks";
import {
  acceptContractAction,
  cancelAction,
  checkMandateAction,
  checkPaymentAction,
  completeOutrightAction,
  creditCheckAction,
  customerAction,
  decideAction,
  disburseAction,
  internalMandateAction,
  locationsAction,
  refundAction,
  requestPaymentAction,
  retryReservationAction,
  sendOtpAction,
  startMandateAction,
  submitAction,
} from "../../actions";

export const metadata = { title: "Altphones application" };

type Step = { key: string; label: string };
const CREDIT_STEPS: Step[] = [
  { key: "credit", label: "Credit check" },
  { key: "locations", label: "Phone & location" },
  { key: "customer", label: "Customer & accounts" },
  { key: "payment", label: "Down payment" },
  { key: "mandates", label: "Mandates" },
  { key: "contract", label: "Contract" },
  { key: "approval", label: "Approval" },
  { key: "handover", label: "Disbursement" },
];
const OUTRIGHT_STEPS: Step[] = [
  { key: "locations", label: "Phone & location" },
  { key: "customer", label: "Customer" },
  { key: "payment", label: "Payment" },
  { key: "handover", label: "Handover" },
];

function currentStep(app: AltApp): string {
  const st = app.status;
  if (app.kind === "OUTRIGHT") {
    if (st === "COMPLETED") return "done";
    if (st === "PAID") return "handover";
    if (st === "AWAITING_PAYMENT") return "payment";
    if (st === "DRAFT") return !app.supply_location_id ? "locations" : !app.customer_name ? "customer" : "payment";
    return "payment";
  }
  if (st === "DISBURSED") return "done";
  if (st === "CREDIT_DECLINED") return "credit";
  if (st === "APPROVED") return "handover";
  if (REVIEW_STATUSES.includes(st)) return "approval";
  if (st === "AWAITING_DOWN_PAYMENT") return "payment";
  if (st === "DRAFT") return app.seedfi_status !== "COMPLETED" ? "credit" : !app.supply_location_id ? "locations" : !app.details_confirmed_at ? "customer" : "payment";
  if (app.reservation_status !== "RESERVED") return "payment";
  if (app.dd_status !== "ACTIVE" || !app.internal_mandate_confirmed_at) return "mandates";
  if (!app.contract_accepted_at) return "contract";
  return "approval";
}

export default async function AltApplicationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { session, ctx } = await requireUser();
  let app: AltApp;
  let as: Set<string>;
  try {
    ({ app, as } = await viewableApp(ctx, db, id));
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") redirect("/forbidden");
    if (e instanceof DomainError && e.code === "NOT_FOUND") redirect("/altphones/sales");
    throw e;
  }
  const me = session.staffId;
  const isOriginator = app.originator_id === me && as.has("ORIGINATOR");
  const [appSettings, current, names, locs, payments, reviews, events, schedule, contract, model] = await Promise.all([
    settingsById(db, app.settings_id),
    currentSettings(db),
    db.query<{ id: string; full_name: string }>("SELECT id, full_name FROM staff WHERE id = ANY($1)", [[app.originator_id, app.bpm_reviewer_id, app.pm_reviewer_id, app.unit_head_id, app.internal_mandate_confirmed_by, app.completed_by].filter(Boolean)]).then((r) => new Map(r.rows.map((x) => [x.id, x.full_name]))),
    db.query<{ id: string; name: string; outlet_type: string; state: string; city: string }>("SELECT id, name, outlet_type, state, city FROM locations WHERE id = ANY($1)", [[app.origin_location_id, app.supply_location_id].filter(Boolean)]).then((r) => new Map(r.rows.map((x) => [x.id, x]))),
    db.query("SELECT * FROM altphones_payments WHERE application_id = $1 ORDER BY created_at DESC", [app.id]).then((r) => r.rows),
    db.query("SELECT r.*, s.full_name FROM altphones_reviews r JOIN staff s ON s.id = r.actor_id WHERE r.application_id = $1 ORDER BY r.decided_at DESC", [app.id]).then((r) => r.rows),
    db.query("SELECT e.*, s.full_name FROM altphones_events e LEFT JOIN staff s ON s.id = e.actor_id WHERE e.application_id = $1 ORDER BY e.occurred_at DESC, e.id DESC LIMIT 60", [app.id]).then((r) => r.rows),
    db.query("SELECT seq, to_char(due_date, 'YYYY-MM-DD') AS due_date, amount_kobo, basis FROM altphones_schedule WHERE application_id = $1 ORDER BY seq", [app.id]).then((r) => r.rows),
    app.contract_id ? db.query("SELECT c.*, a.accepted_at FROM altphones_contracts c LEFT JOIN altphones_contract_acceptances a ON a.contract_id = c.id WHERE c.id = $1", [app.contract_id]).then((r) => r.rows[0]) : null,
    app.model_id ? db.query("SELECT id, name, image_key FROM altphones_models WHERE id = $1", [app.model_id]).then((r) => r.rows[0]) : null,
  ]);
  const nm = (x: string | null | undefined) => (x ? (names.get(x) ?? "—") : "—");
  const origin = app.origin_location_id ? locs.get(app.origin_location_id) : null;
  const supply = app.supply_location_id ? locs.get(app.supply_location_id) : null;
  const paid = payments.find((p) => p.status === "SUCCESS");
  const openPay = payments.find((p) => p.status === "INITIATED");
  const gw = paymentGateway();
  const steps = app.kind === "CREDIT" ? CREDIT_STEPS : OUTRIGHT_STEPS;
  const step = currentStep(app);
  const stepIdx = step === "done" ? steps.length : steps.findIndex((s) => s.key === step);
  const stopped = ["CREDIT_DECLINED", "REJECTED", "CANCELLED"].includes(app.status);
  const editing = isOriginator && app.status === "DRAFT" ? sp.edit : undefined;
  const showStep = (k: string) => isOriginator && (editing ? editing === k : step === k) && !stopped;
  const lockVersion = String(app.lock_version);
  const hidden = (
    <>
      <input type="hidden" name="id" value={app.id} />
      <input type="hidden" name="lockVersion" value={lockVersion} />
    </>
  );
  const reviewStage = app.status === "UNDER_BPM_REVIEW" && as.has("BPM") ? "BPM" : app.status === "UNDER_PM_REVIEW" && as.has("PM") ? "PM" : app.status === "UNDER_UNIT_HEAD_REVIEW" && as.has("UNIT_HEAD") ? "UNIT_HEAD" : null;
  const routeUh = REVIEW_STATUSES.includes(app.status) ? await routeUnitHead(db, app) : null;
  const canDecideUh = reviewStage !== "UNIT_HEAD" || routeUh?.id === me;
  const blockers = app.kind === "CREDIT" ? submissionBlockers(app) : [];
  const lastReturn = reviews.find((r) => r.action === "RETURN");

  // Location step data
  const isDo = app.channel === "DO";
  const locationsData = showStep("locations")
    ? {
        models: (await db.query<{ id: string; name: string }>("SELECT id, name FROM altphones_models WHERE active ORDER BY sort_order, name")).rows,
        branches: isDo ? await supplyOptions(db, app.model_id, null).then((r) => r.filter((x) => x.outlet_type === "BRANCH")) : [],
        boxes: isDo ? [] : (await db.query<{ id: string; name: string; city: string; state: string }>("SELECT id, name, city, state FROM locations WHERE active AND outlet_type = 'ALTBOX' ORDER BY state, city, name")).rows,
        supplies: isDo ? [] : await supplyOptions(db, app.model_id, origin ? { state: origin.state, city: origin.city } : await db.query<{ state: string; city: string }>("SELECT region AS state, '' AS city FROM staff WHERE id = $1", [me]).then((r) => r.rows[0] ?? null)),
      }
    : null;
  const devices = isOriginator && (app.status === "APPROVED" || app.status === "PAID") ? await issuableDevices(db, app) : [];

  return (
    <>
      <PageHeader
        eyebrow={`Altphones · ${app.kind === "OUTRIGHT" ? "Outright purchase" : "Credit purchase"} · ${isDo ? "Delight Officer" : "Smile Associate"}`}
        title={
          <>
            <span className="mono">{app.ref}</span> {app.customer_name ? <span className="alt-title-sub">{app.customer_name}</span> : null}
          </>
        }
        crumbs={[{ href: isOriginator ? "/altphones/sales" : "/altphones/reviews", label: isOriginator ? "My sales" : "Altphones reviews" }, { label: app.ref }]}
        actions={
          <>
            <AltStatusBadge status={app.status} />
            <KindBadge kind={app.kind} legacy={app.legacy} />
          </>
        }
      />
      {app.legacy && (
        <div className="alert alert-info">
          <span>Legacy / Imported record ({app.legacy_ref}). Completed outside ARAF; no payments, approvals or notifications were generated.</span>
        </div>
      )}
      {!app.legacy && (
        <ol className="progress alt-progress" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} aria-label="Progress">
          {steps.map((s, i) => (
            <li key={s.key} className={i < stepIdx ? "done" : i === stepIdx ? (stopped ? "stopped" : "current") : ""} aria-current={i === stepIdx ? "step" : undefined}>
              {s.label}
            </li>
          ))}
        </ol>
      )}

      <div className="alt-layout">
        <div className="alt-main stack">
          {/* ---------------------------------------------------------------- originator: current step */}
          {stopped && (
            <div className={`alert ${app.status === "CANCELLED" ? "alert-warn" : "alert-error"}`} role="status">
              <span>
                <strong>{ALT_STATUS_LABELS[app.status as AltStatus]}.</strong> {app.status === "CREDIT_DECLINED" ? "The customer did not pass the SeedFi credit assessment, so this credit sale cannot continue." : app.closed_reason}
                {app.refund_status === "REQUIRED" && " The payment received must be refunded under the approved refund process."}
                {app.refund_status === "RECORDED" && ` Refund recorded (${app.refund_reference}).`}
              </span>
            </div>
          )}
          {isOriginator && app.status === "RETURNED_FOR_CORRECTION" && lastReturn && (
            <div className="alert alert-warn" role="status">
              <span>
                <strong>Returned by the {lastReturn.stage === "BPM" ? "Business Performance Manager" : lastReturn.stage === "PM" ? "Product Manager" : "Unit Head"}:</strong> {lastReturn.comments}
              </span>
            </div>
          )}

          {showStep("credit") && app.kind === "CREDIT" && (
            <section className="card action-panel stack" aria-labelledby="s-credit">
              <h2 id="s-credit">Credit assessment</h2>
              {app.seedfi_status === "UNAVAILABLE" && (
                <div className="alert alert-warn" role="status">
                  <span>
                    <strong>Integration unavailable — not assessed.</strong> {app.seedfi_last_error} The customer has not passed; try again when SeedFi responds.
                  </span>
                </div>
              )}
              <ActionForm action={creditCheckAction} className="stack">
                {hidden}
                <div className="field">
                  <label htmlFor="bvn">Customer BVN</label>
                  <input id="bvn" name="bvn" inputMode="numeric" autoComplete="off" pattern="[0-9]{11}" maxLength={11} required placeholder="11 digits" className="mono alt-bvn" autoFocus />
                  <span className="hint">Sent securely to SeedFi for the Seed Score. Only the last 4 digits are shown afterwards.</span>
                </div>
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="firstName">First name</label>
                    <input id="firstName" name="firstName" required autoComplete="off" defaultValue={app.customer_first_name ?? ""} />
                  </div>
                  <div className="field">
                    <label htmlFor="lastName">Last name</label>
                    <input id="lastName" name="lastName" required autoComplete="off" defaultValue={app.customer_last_name ?? ""} />
                  </div>
                  <div className="field">
                    <label htmlFor="dateOfBirth">Date of birth</label>
                    <input id="dateOfBirth" name="dateOfBirth" type="date" required max={new Date().toISOString().slice(0, 10)} defaultValue={app.customer_dob ? new Date(app.customer_dob).toISOString().slice(0, 10) : ""} />
                  </div>
                  <div className="field">
                    <label htmlFor="gender">Gender</label>
                    <select id="gender" name="gender" required defaultValue={app.customer_gender ?? ""}>
                      <option value="">As on the BVN record</option>
                      <option value="female">Female</option>
                      <option value="male">Male</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="cphone">Phone number</label>
                    <input id="cphone" name="phone" type="tel" required autoComplete="off" placeholder="0803 123 4567" defaultValue={app.customer_phone ? `0${String(app.customer_phone).slice(4)}` : ""} />
                  </div>
                </div>
                <label className="check">
                  <input type="checkbox" name="consent" required /> The customer consents to a credit check with SeedFi.
                </label>
                <div className="action-bar">
                  <SubmitButton>Run credit check</SubmitButton>
                </div>
              </ActionForm>
            </section>
          )}

          {showStep("locations") && locationsData && (
            <section className="card action-panel stack" aria-labelledby="s-loc">
              <h2 id="s-loc">Phone and location</h2>
              <ActionForm action={locationsAction} className="stack" doneHref={`/altphones/applications/${app.id}`}>
                {hidden}
                <div className="field">
                  <label htmlFor="modelId">Phone</label>
                  <select id="modelId" name="modelId" defaultValue={app.model_id ?? ""} required>
                    {locationsData.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
                {isDo ? (
                  <div className="field">
                    <label htmlFor="originId">Your Alternative Bank Branch</label>
                    <select id="originId" name="originId" defaultValue={app.origin_location_id ?? ""} required>
                      <option value="">Choose the Branch</option>
                      {locationsData.branches.map((b) => (
                        <option key={b.id} value={b.id} disabled={b.available < 1}>
                          {b.name} — {b.city} · {b.available > 0 ? `${b.available} in stock` : "out of stock"}
                        </option>
                      ))}
                    </select>
                    <span className="hint">The phone is supplied from this Branch&rsquo;s stock.</span>
                  </div>
                ) : (
                  <>
                    <div className="field">
                      <label htmlFor="originId">Your BOX</label>
                      <select id="originId" name="originId" defaultValue={app.origin_location_id ?? ""} required>
                        <option value="">Choose the BOX you are selling from</option>
                        {locationsData.boxes.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name} — {b.city}, {b.state}
                          </option>
                        ))}
                      </select>
                      <span className="hint">BOX locations do not hold stock. The sale is credited to you and this BOX.</span>
                    </div>
                    <div className="field">
                      <label htmlFor="supplyId">Supplying Shop or Branch</label>
                      <select id="supplyId" name="supplyId" defaultValue={app.supply_location_id ?? ""} required>
                        <option value="">Choose where the phone comes from</option>
                        {locationsData.supplies.map((s) => (
                          <option key={s.id} value={s.id} disabled={s.available < 1}>
                            {s.name} ({s.outlet_type === "BRANCH" ? "Branch" : "Shop"}) — {s.city}, {s.state} · {s.available > 0 ? `${s.available} in stock` : "out of stock"}
                            {s.same_city ? " · nearby" : ""}
                          </option>
                        ))}
                      </select>
                      <span className="hint">Nearest locations first. Stock is deducted from this location, not the BOX.</span>
                    </div>
                  </>
                )}
                <div className="action-bar">
                  <SubmitButton>Continue</SubmitButton>
                  {editing && (
                    <Link className="btn btn-ghost" href={`/altphones/applications/${app.id}`}>
                      Cancel change
                    </Link>
                  )}
                </div>
              </ActionForm>
            </section>
          )}

          {showStep("customer") && (
            <section className="card action-panel stack" aria-labelledby="s-cust">
              <h2 id="s-cust">{app.kind === "CREDIT" ? "Customer and accounts" : "Customer"}</h2>
              <ActionForm action={customerAction} className="stack" doneHref={`/altphones/applications/${app.id}`}>
                {hidden}
                <div className="grid-2">
                  <div className="field" style={{ gridColumn: "1 / -1" }}>
                    <label htmlFor="name">Full name</label>
                    <input id="name" name="name" defaultValue={app.customer_name ?? ""} required autoComplete="off" />
                  </div>
                  <div className="field">
                    <label htmlFor="email">Email address</label>
                    <input id="email" name="email" type="email" defaultValue={app.customer_email ?? ""} required autoComplete="off" />
                    <span className="hint">{app.kind === "CREDIT" ? "The contract code is sent here." : "The receipt is sent here."}</span>
                  </div>
                  <div className="field">
                    <label htmlFor="phone">Phone number</label>
                    <input id="phone" name="phone" type="tel" defaultValue={app.customer_phone ? `0${String(app.customer_phone).slice(4)}` : ""} required autoComplete="off" placeholder="0803 123 4567" />
                  </div>
                </div>
                {app.kind === "CREDIT" && (
                  <>
                    <div className="grid-2">
                      <AccountFields
                        banks={gw ? await otherBanks() : null}
                        abAccount={app.ab_account_number ?? ""}
                        externalAccount={app.external_account_number ?? ""}
                        externalBankCode={app.external_bank_code ?? ""}
                        externalBankName={app.external_bank_name ?? ""}
                        abBankCode={ALTERNATIVE_BANK_CODE}
                      />
                      <div className="field">
                        <label htmlFor="repaymentDay">Repayment day</label>
                        <select id="repaymentDay" name="repaymentDay" defaultValue={app.repayment_day ?? ""} required>
                          <option value="">Day of the month</option>
                          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                            <option key={d} value={d}>
                              {d}
                            </option>
                          ))}
                        </select>
                        <span className="hint">
                          {current.short_month_rule === "LAST_DAY_OF_MONTH" ? "In shorter months, the last day of the month." : "In shorter months, the first day of the next month."}{" "}
                          {current.weekend_rule === "NEXT_BUSINESS_DAY" ? "Weekends and holidays move to the next business day." : current.weekend_rule === "PREVIOUS_BUSINESS_DAY" ? "Weekends and holidays move to the previous business day." : ""}
                        </span>
                      </div>
                    </div>
                    <TenureCalculator priceKobo={Number(current.outright_price_kobo)} downKobo={Number(current.down_payment_kobo)} rates={current.markup_rates} basis={current.markup_basis} tenures={current.tenures} defaultTenure={app.tenure_months} />
                    <label className="check">
                      <input type="checkbox" name="accountsConfirmed" required />
                      <span>
                        {gw ? (
                          <>I have confirmed with the customer that both account names shown belong to them.</>
                        ) : (
                          <>
                            I have confirmed that the Alternative Bank account belongs to this customer. <span className="muted small">(Manual officer confirmation — Paystack is not configured, so the names cannot be looked up.)</span>
                          </>
                        )}
                      </span>
                    </label>
                  </>
                )}
                <div className="action-bar">
                  <SubmitButton>Continue</SubmitButton>
                  {editing && (
                    <Link className="btn btn-ghost" href={`/altphones/applications/${app.id}`}>
                      Cancel change
                    </Link>
                  )}
                </div>
              </ActionForm>
            </section>
          )}

          {isOriginator && !editing && step === "payment" && !stopped && (
            <section className="card action-panel stack" aria-labelledby="s-pay">
              <h2 id="s-pay">{app.kind === "CREDIT" ? "Collect the down payment" : "Collect payment"}</h2>
              {paid && app.reservation_status !== "RESERVED" ? (
                <>
                  <div className="alert alert-warn" role="status">
                    <span>Payment verified, but no {app.model_name} is available to reserve at {supply?.name}. The Altphones team has been alerted to add stock.</span>
                  </div>
                  <ActionForm action={retryReservationAction}>
                    {hidden}
                    <div className="action-bar">
                      <SubmitButton>Try the reservation again</SubmitButton>
                    </div>
                  </ActionForm>
                </>
              ) : (
                <>
                  <div className="alt-amount">
                    <span className="alt-amount-v">{formatNaira(app.kind === "OUTRIGHT" ? (app.price_kobo ?? current.outright_price_kobo) : (app.down_payment_kobo ?? current.down_payment_kobo))}</span>
                    <span className="small muted">{app.kind === "CREDIT" ? "fixed down payment · cannot be changed" : "full price"}</span>
                  </div>
                  {!gw && (
                    <div className="alert alert-warn" role="status">
                      <span>
                        <strong>Paystack is not configured.</strong> Payments cannot be collected until an administrator sets up the integration. Nothing is recorded as paid without Paystack&rsquo;s confirmation.
                      </span>
                    </div>
                  )}
                  {openPay?.checkout_url ? (
                    <>
                      <p className="small" style={{ margin: 0 }}>
                        Share this Paystack link with the customer. They pay by bank transfer; the payment is confirmed automatically once Paystack notifies us.
                      </p>
                      <CopyLink url={openPay.checkout_url} />
                      <p className="small muted" style={{ margin: 0 }}>
                        Reference <span className="mono">{openPay.reference}</span> · created {formatLagos(openPay.created_at)}
                      </p>
                      <div className="action-bar">
                        <ActionForm action={checkPaymentAction} className="inline-form">
                          {hidden}
                          <SubmitButton>Check payment status</SubmitButton>
                        </ActionForm>
                        <ActionForm action={requestPaymentAction} className="inline-form">
                          {hidden}
                          <SubmitButton className="btn btn-ghost">New payment link</SubmitButton>
                        </ActionForm>
                      </div>
                    </>
                  ) : (
                    <ActionForm action={requestPaymentAction}>
                      {hidden}
                      {app.kind === "CREDIT" && app.status === "DRAFT" && <p className="small muted" style={{ marginTop: 0 }}>Creating the payment fixes the financing terms shown on the right for this customer.</p>}
                      <div className="action-bar">
                        <SubmitButton disabled={!gw}>Create Paystack payment</SubmitButton>
                      </div>
                    </ActionForm>
                  )}
                </>
              )}
            </section>
          )}

          {isOriginator && step === "handover" && app.kind === "OUTRIGHT" && (
            <section className="card action-panel stack" aria-labelledby="s-hand">
              <h2 id="s-hand">Hand over the phone</h2>
              <ActionForm action={completeOutrightAction} className="stack">
                {hidden}
                <ImeiField devices={devices} />
                <label className="check">
                  <input type="checkbox" name="handedOver" required /> I have handed the {app.model_name} to {app.customer_name}.
                </label>
                <div className="action-bar">
                  <SubmitButton>Complete sale and send receipt</SubmitButton>
                </div>
              </ActionForm>
            </section>
          )}

          {isOriginator && step === "mandates" && (
            <section className="card action-panel stack" aria-labelledby="s-mand">
              <h2 id="s-mand">Repayment mandates</h2>
              <p className="small muted" style={{ margin: 0 }}>
                Both mandates are required before the contract.
              </p>
              <div className="alt-mandates">
                <div className="alt-mandate">
                  <div className="card-head">
                    <h3>Paystack Direct Debit</h3>
                    <span className={`badge ${app.dd_status === "ACTIVE" ? "badge-green" : app.dd_status === "PENDING" ? "badge-warn" : ""}`}>{app.dd_status === "ACTIVE" ? "Active — verified by Paystack" : app.dd_status === "PENDING" ? "Awaiting customer authorisation" : "Not started"}</span>
                  </div>
                  <p className="small" style={{ marginTop: 0 }}>
                    On {app.external_bank_name} account ending {String(app.external_account_number ?? "").slice(-4)}.
                  </p>
                  {app.dd_status !== "ACTIVE" &&
                    (!gw || !gw.directDebit ? (
                      <div className="alert alert-warn">
                        <span>Paystack Direct Debit is not enabled yet. It must be confirmed with Paystack and enabled by an administrator.</span>
                      </div>
                    ) : (
                      <>
                        {app.dd_redirect_url && app.dd_status === "PENDING" && <CopyLink url={app.dd_redirect_url} />}
                        <div className="action-bar">
                          {app.dd_status === "PENDING" && (
                            <ActionForm action={checkMandateAction} className="inline-form">
                              {hidden}
                              <SubmitButton>Check mandate status</SubmitButton>
                            </ActionForm>
                          )}
                          <ActionForm action={startMandateAction} className="inline-form">
                            {hidden}
                            <SubmitButton className={app.dd_status === "PENDING" ? "btn btn-ghost" : "btn btn-primary"}>{app.dd_status === "PENDING" ? "New authorisation link" : "Set up Direct Debit"}</SubmitButton>
                          </ActionForm>
                        </div>
                      </>
                    ))}
                </div>
                <div className="alt-mandate">
                  <div className="card-head">
                    <h3>Alternative Bank internal mandate</h3>
                    <span className={`badge ${app.internal_mandate_confirmed_at ? "badge-blue" : ""}`}>{app.internal_mandate_confirmed_at ? "Officer Confirmed" : "Not confirmed"}</span>
                  </div>
                  {app.internal_mandate_confirmed_at ? (
                    <p className="small" style={{ margin: 0 }}>
                      Confirmed by {nm(app.internal_mandate_confirmed_by)} on {formatLagos(app.internal_mandate_confirmed_at)}. Not API verified.
                    </p>
                  ) : (
                    <ActionForm action={internalMandateAction} className="stack">
                      {hidden}
                      <label className="check">
                        <input type="checkbox" name="confirmed" required /> <span>{INTERNAL_MANDATE_WORDING}</span>
                      </label>
                      <div className="action-bar">
                        <SubmitButton>Confirm</SubmitButton>
                      </div>
                    </ActionForm>
                  )}
                </div>
              </div>
            </section>
          )}

          {isOriginator && step === "contract" && (
            <section className="card action-panel stack" aria-labelledby="s-con">
              <h2 id="s-con">Customer contract</h2>
              {!contract ? (
                <>
                  <p className="small" style={{ margin: 0 }}>
                    Review the terms on the right with the customer. Sending emails them the contract and a one-time code to accept it.
                  </p>
                  {!current.contract_template && (
                    <div className="alert alert-warn">
                      <span>The approved contract wording is not loaded yet. The Altphones Product Manager must load it.</span>
                    </div>
                  )}
                  <ActionForm action={sendOtpAction}>
                    {hidden}
                    <div className="action-bar">
                      <SubmitButton disabled={!current.contract_template}>Send contract and code to {app.customer_email}</SubmitButton>
                    </div>
                  </ActionForm>
                </>
              ) : (
                <>
                  <details className="alt-contract">
                    <summary className="small">
                      Contract version {contract.version} sent {formatLagos(contract.generated_at)} · <span className="mono">{String(contract.sha256).slice(0, 12)}</span>
                    </summary>
                    <pre className="alt-contract-body">{contract.body}</pre>
                  </details>
                  <ActionForm action={acceptContractAction} className="stack" resetOnSuccess>
                    {hidden}
                    <div className="field">
                      <label htmlFor="code">Code from the customer&rsquo;s email</label>
                      <input id="code" name="code" className="otp-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
                      <span className="hint">The customer gives you the code only if they accept the contract. Codes expire after a few minutes and allow limited attempts.</span>
                    </div>
                    <div className="action-bar">
                      <SubmitButton>Record acceptance</SubmitButton>
                    </div>
                  </ActionForm>
                  <ActionForm action={sendOtpAction}>
                    {hidden}
                    <SubmitButton className="btn btn-ghost btn-sm">Send a new code</SubmitButton>
                  </ActionForm>
                </>
              )}
            </section>
          )}

          {isOriginator && step === "approval" && (app.status === "IN_PREPARATION" || app.status === "RETURNED_FOR_CORRECTION") && (
            <section className="card action-panel stack" aria-labelledby="s-sub">
              <h2 id="s-sub">Submit for approval</h2>
              <p className="small muted" style={{ margin: 0 }}>
                {isDo ? "Goes to the Product Manager, then the Unit Head." : "Goes to the Business Performance Manager, the Product Manager, then the Unit Head."} It comes back to you for disbursement.
              </p>
              <ActionForm action={submitAction} className="stack">
                {hidden}
                <div className="field">
                  <label htmlFor="comments">Note for the reviewers (optional)</label>
                  <textarea id="comments" name="comments" rows={2} />
                </div>
                <div className="action-bar">
                  <SubmitButton disabled={blockers.length > 0}>{app.status === "RETURNED_FOR_CORRECTION" ? "Resubmit" : "Submit for approval"}</SubmitButton>
                </div>
              </ActionForm>
            </section>
          )}

          {isOriginator && REVIEW_STATUSES.includes(app.status) && (
            <div className="alert alert-info" role="status">
              <span>
                <strong>{ALT_STATUS_LABELS[app.status as AltStatus]}.</strong> You&rsquo;ll be notified when it is approved and ready for disbursement.
              </span>
            </div>
          )}

          {isOriginator && app.status === "APPROVED" && (
            <section className="card action-panel stack" aria-labelledby="s-disb">
              <h2 id="s-disb">
                <ShieldCheck className="icon" aria-hidden="true" /> Approved — Ready for Disbursement
              </h2>
              <ActionForm action={disburseAction} className="stack">
                {hidden}
                <label className="check">
                  <input type="checkbox" name="modelConfirmed" required /> The phone is a <strong>{app.model_name}</strong>.
                </label>
                <ImeiField devices={devices} />
                <label className="check">
                  <input type="checkbox" name="locationConfirmed" required /> It comes from <strong>{supply?.name}</strong>.
                </label>
                <label className="check">
                  <input type="checkbox" name="handedOver" required /> I have physically handed the phone to {app.customer_name}.
                </label>
                <div className="action-bar">
                  <SubmitButton>Confirm Disbursement</SubmitButton>
                </div>
              </ActionForm>
            </section>
          )}

          {(app.status === "COMPLETED" || app.status === "DISBURSED") && !app.legacy && (
            <div className="alert alert-success" role="status">
              <span>
                <strong>{ALT_STATUS_LABELS[app.status as AltStatus]}.</strong> {app.model_name} · IMEI <span className="mono">{app.imei}</span> · {formatLagos(app.completed_at)}.{" "}
                <Link href={`/altphones/applications/${app.id}/receipt`}>{app.kind === "OUTRIGHT" ? "View receipt" : "View completion record"}</Link>
              </span>
            </div>
          )}

          {/* ---------------------------------------------------------------- reviewer */}
          {reviewStage && (
            <section className="card action-panel stack" aria-labelledby="s-rev">
              <h2 id="s-rev">{reviewStage === "BPM" ? "Business Performance Manager review" : reviewStage === "PM" ? "Product and financing review" : "Final approval"}</h2>
              <ul className="alt-checks">
                <Check ok={app.seedfi_outcome === "PASS" || app.seedfi_outcome === "FAIR"} label="Credit assessment" detail={app.seedfi_outcome ? `${SCORE_OUTCOME_LABELS[app.seedfi_outcome as "PASS"]} · Seed Score ${Number(app.seedfi_score)}${app.seedfi_overall_score !== null && Number(app.seedfi_overall_score) !== Number(app.seedfi_score) ? ` (overall ${Number(app.seedfi_overall_score)})` : ""}${app.seedfi_has_history === false ? " · no credit history" : ""}` : "not completed"} />
                <Check ok={!!paid} label="Down payment" detail={paid ? `${formatNaira(paid.amount_kobo)} verified by Paystack · ${paid.reference}` : "not verified"} />
                <Check ok={app.dd_status === "ACTIVE"} label="Paystack Direct Debit" detail={app.dd_status === "ACTIVE" ? `active · ${app.dd_bank_name ?? app.external_bank_name} ••${app.dd_account_last4 ?? ""} · ${app.dd_reference}` : app.dd_status.toLowerCase().replace("_", " ")} />
                <Check ok={!!app.internal_mandate_confirmed_at} label="Alternative Bank mandate" detail={app.internal_mandate_confirmed_at ? `Officer Confirmed by ${nm(app.internal_mandate_confirmed_by)}` : "not confirmed"} />
                <Check ok={!!app.contract_accepted_at} label="Contract accepted by OTP" detail={contract ? `version ${contract.version} · ${formatLagos(contract.accepted_at)}` : "not accepted"} />
                <Check ok={app.reservation_status === "RESERVED"} label="Phone reserved" detail={supply ? `${app.model_name} at ${supply.name}` : ""} />
                <Check ok={schedule.length === app.tenure_months} label="Repayment schedule" detail={`${schedule.length} instalments`} />
              </ul>
              {reviewStage === "UNIT_HEAD" && !canDecideUh ? (
                <div className="alert alert-warn">
                  <span>Only the Unit Head configured for the Altphones route ({routeUh?.name ?? "not configured"}) can decide this application.</span>
                </div>
              ) : (
                <ActionForm action={decideAction} className="stack">
                  {hidden}
                  <div className="field">
                    <label htmlFor="rcomments">Comments</label>
                    <textarea id="rcomments" name="comments" rows={3} placeholder="Required to return or reject" />
                  </div>
                  <label className="check">
                    <input type="checkbox" name="reviewed" /> I have reviewed the items above.
                  </label>
                  <div className="action-bar">
                    <SubmitButton name="decision" value="APPROVE">
                      {reviewStage === "UNIT_HEAD" ? "Approve" : "Approve and forward"}
                    </SubmitButton>
                    <SubmitButton name="decision" value="RETURN" className="btn">
                      Return for correction
                    </SubmitButton>
                    <SubmitButton name="decision" value="REJECT" className="btn btn-danger">
                      Reject
                    </SubmitButton>
                  </div>
                </ActionForm>
              )}
            </section>
          )}

          {as.has("ADMIN") && app.refund_status === "REQUIRED" && (
            <section className="card stack" aria-labelledby="s-ref">
              <h2 id="s-ref">Record the refund</h2>
              <ActionForm action={refundAction} className="stack">
                <input type="hidden" name="id" value={app.id} />
                <div className="field">
                  <label htmlFor="reference">Refund transaction reference</label>
                  <input id="reference" name="reference" required />
                </div>
                <div className="action-bar">
                  <SubmitButton>Record refund</SubmitButton>
                </div>
              </ActionForm>
            </section>
          )}

          {/* ---------------------------------------------------------------- completed sections */}
          {app.kind === "CREDIT" && app.financed_kobo && (
            <section className="card" aria-labelledby="s-sched">
              <h2 id="s-sched">Repayment schedule</h2>
              <ScheduleTable rows={schedule} />
            </section>
          )}

          <details className="card alt-history">
            <summary>
              <h2 id="s-hist">History</h2>
              <span className="small muted">{events.length} event{events.length === 1 ? "" : "s"} · latest {events[0] ? formatLagos(events[0].occurred_at) : "—"}</span>
            </summary>
            <ol className="timeline">
              {events.map((e) => (
                <li key={e.id} className="done">
                  <strong>{e.action.replace(/_/g, " ").toLowerCase().replace(/^./, (c: string) => c.toUpperCase())}</strong>
                  {e.to_status && <span className="small muted"> → {ALT_STATUS_LABELS[e.to_status as AltStatus] ?? e.to_status}</span>}
                  <div className="small muted">
                    {formatLagos(e.occurred_at)} · {e.full_name ?? "System"}
                    {e.actor_role ? ` (${ROLE_LABELS[e.actor_role as Role] ?? e.actor_role})` : ""}
                  </div>
                  {e.comments && <div className="small">{e.comments}</div>}
                </li>
              ))}
            </ol>
          </details>
        </div>

        {/* ---------------------------------------------------------------- summary */}
        <aside className="alt-side stack" aria-label="Summary">
          <section className="card alt-summary">
            {model && (
              <div className="alt-summary-phone">
                <PhoneImage modelId={model.id} hasImage={!!model.image_key} name={model.name} size="thumb" />
                <div>
                  <strong>{app.model_name}</strong>
                  <div className="small muted">{app.kind === "OUTRIGHT" ? formatNaira(app.price_kobo ?? appSettings.outright_price_kobo) : "On credit"}</div>
                </div>
              </div>
            )}
            <dl className="alt-kv">
              <div>
                <dt>{isDo ? "Branch" : "BOX"}</dt>
                <dd>
                  {origin?.name ?? "—"}
                  {isOriginator && app.status === "DRAFT" && app.supply_location_id && (
                    <Link className="alt-change" href={`?edit=locations`}>
                      Change
                    </Link>
                  )}
                </dd>
              </div>
              {!isDo && (
                <div>
                  <dt>Supplied by</dt>
                  <dd>{supply?.name ?? "—"}</dd>
                </div>
              )}
              <div>
                <dt>Officer</dt>
                <dd>{nm(app.originator_id) !== "—" ? nm(app.originator_id) : (app.legacy_officer ?? "—")}</dd>
              </div>
              <div>
                <dt>Customer</dt>
                <dd>
                  {app.customer_name ?? "—"}
                  {isOriginator && app.status === "DRAFT" && app.customer_name && (
                    <Link className="alt-change" href={`?edit=customer`}>
                      Change
                    </Link>
                  )}
                  {app.customer_email && <div className="small muted">{app.customer_email}</div>}
                  {app.customer_phone && <div className="small muted">{app.customer_phone}</div>}
                </dd>
              </div>
              {app.kind === "CREDIT" && (
                <>
                  <div>
                    <dt>Seed Score (SeedFi)</dt>
                    <dd>
                      {app.seedfi_outcome ? (
                        <>
                          <span className={`badge ${app.seedfi_outcome === "FAIL" ? "badge-red" : app.seedfi_outcome === "FAIR" ? "badge-warn" : "badge-green"}`}>{SCORE_OUTCOME_LABELS[app.seedfi_outcome as "PASS"]}</span> <span className="small">Seed Score {Number(app.seedfi_score)}</span>
                          {app.seedfi_overall_score !== null && Number(app.seedfi_overall_score) !== Number(app.seedfi_score) && <div className="small">Overall {Number(app.seedfi_overall_score)}, reviewed down to {Number(app.seedfi_score)}</div>}
                          {app.seedfi_has_history !== null && <div className="small muted">{app.seedfi_has_history ? "Has credit history" : "No credit history"}</div>}
                          {app.seedfi_details?.isDummyData && <span className="badge badge-warn">SeedFi test data</span>}
                          {app.seedfi_details?.validUntil && <div className="small muted">Score valid until {app.seedfi_details.validUntil}</div>}
                          <div className="small muted">
                            {app.seedfi_reference} · {formatLagos(app.seedfi_assessed_at)}
                          </div>
                        </>
                      ) : app.seedfi_status === "UNAVAILABLE" ? (
                        <span className="badge badge-warn">Integration unavailable</span>
                      ) : (
                        "Not assessed"
                      )}
                      {app.bvn_last4 && <div className="small muted">BVN •••••••{app.bvn_last4}</div>}
                    </dd>
                  </div>
                  {app.ab_account_number && (
                    <div>
                      <dt>Accounts</dt>
                      <dd className="small">
                        Alternative Bank <span className="mono">{app.ab_account_number}</span>
                        {app.ab_account_name && <div className="muted">{app.ab_account_name}</div>}
                        <div>
                          {app.external_bank_name} <span className="mono">{app.external_account_number}</span>
                        </div>
                        {app.external_account_name && <div className="muted">{app.external_account_name}</div>}
                        <div className="muted">{app.accounts_verified_via === "PAYSTACK" ? "Names verified by Paystack; officer confirmed" : "Officer confirmed"}</div>
                      </dd>
                    </div>
                  )}
                </>
              )}
              {paid && (
                <div>
                  <dt>{app.kind === "CREDIT" ? "Down payment" : "Payment"}</dt>
                  <dd className="small">
                    {formatNaira(paid.amount_kobo)} · verified {formatLagos(paid.verified_at)}
                    <div className="mono muted">{paid.reference}</div>
                  </dd>
                </div>
              )}
              {app.reservation_status !== "NONE" && (
                <div>
                  <dt>Stock</dt>
                  <dd className="small">{app.reservation_status === "RESERVED" ? `Reserved at ${supply?.name}` : app.reservation_status === "CONSUMED" ? `Issued from ${supply?.name}` : "Reservation released"}</dd>
                </div>
              )}
            </dl>
          </section>
          {app.kind === "CREDIT" && (
            <section className="card">
              <h2 className="alt-side-h">Financing terms</h2>
              {app.financed_kobo ? (
                <>
                  <TermsTable app={app} />
                  <p className="small muted" style={{ marginBottom: 0 }}>
                    Fixed {formatLagos(app.terms_locked_at)} (settings version {appSettings.version}). Later pricing changes do not apply.
                  </p>
                </>
              ) : (
                <p className="small muted" style={{ margin: 0 }}>
                  Terms are fixed when the down payment is requested.
                  {creditReadiness(current).length ? " Credit settings are incomplete." : ""}
                </p>
              )}
            </section>
          )}
          {reviews.length > 0 && (
            <section className="card">
              <h2 className="alt-side-h">Decisions</h2>
              <ul className="alt-decisions">
                {reviews.map((r) => (
                  <li key={r.id}>
                    <span className={`badge ${r.action === "APPROVE" ? "badge-green" : r.action === "REJECT" ? "badge-red" : "badge-warn"}`}>{r.action === "APPROVE" ? "Approved" : r.action === "REJECT" ? "Rejected" : "Returned"}</span>{" "}
                    <strong>{r.stage === "BPM" ? "BPM" : r.stage === "PM" ? "Product Manager" : "Unit Head"}</strong>
                    <div className="small muted">
                      {r.full_name} · {formatLagos(r.decided_at)}
                    </div>
                    {r.comments && <div className="small">{r.comments}</div>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {isOriginator && ["DRAFT", "AWAITING_PAYMENT", "AWAITING_DOWN_PAYMENT", "PAID", "IN_PREPARATION", "RETURNED_FOR_CORRECTION"].includes(app.status) && (
            <details className="alt-cancel">
              <summary className="small">Cancel this sale</summary>
              <ActionForm action={cancelAction} className="stack">
                {hidden}
                <div className="field">
                  <label htmlFor="reason">Reason</label>
                  <input id="reason" name="reason" required />
                  {paid && <span className="hint">The payment received will be flagged for refund and the reserved phone released.</span>}
                </div>
                <SubmitButton className="btn btn-danger btn-sm">Cancel sale</SubmitButton>
              </ActionForm>
            </details>
          )}
        </aside>
      </div>
    </>
  );
}

function ImeiField({ devices }: { devices: { id: string; imei: string; status: string }[] }) {
  const reserved = devices.find((d) => d.status === "RESERVED");
  return (
    <div className="field">
      <label htmlFor="imei">Device IMEI</label>
      <input id="imei" name="imei" list="imei-list" inputMode="numeric" maxLength={15} pattern="[0-9]{15}" required defaultValue={reserved?.imei ?? ""} className="mono" autoComplete="off" />
      <datalist id="imei-list">
        {devices.map((d) => (
          <option key={d.id} value={d.imei}>
            {d.status === "RESERVED" ? "Reserved for this customer" : "In stock"}
          </option>
        ))}
      </datalist>
      <span className="hint">{reserved ? "The reserved unit is filled in. Change it only if you hand over a different unit from the same location." : "Scan or type the 15-digit IMEI from the box (or dial *#06# on the phone)."}</span>
    </div>
  );
}
