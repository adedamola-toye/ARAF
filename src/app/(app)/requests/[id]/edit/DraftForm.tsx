"use client";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle } from "lucide-react";
import { UploadPanel } from "@/components/UploadPanel";
import { useRouter } from "next/navigation";
import { saveDraftAction } from "../../actions";
import { FormMessages } from "@/components/forms";
import { useFormStatus } from "react-dom";

interface Item {
  description: string;
  quantity: string;
  unitCost: string;
}
interface Director {
  id?: string | null;
  fullName: string;
  bvn: string;
  masked?: string;
}
export interface DraftFormData {
  customerName: string;
  businessName: string;
  companyName: string;
  registrationNumber: string;
  phone: string;
  email: string;
  address: string;
  amount: string;
  daoCode: string;
  posSerial: string;
  tenor: string;
  items: Item[];
  supplierName: string;
  supplierAddress: string;
  supplierPhone: string;
  supplierAccount: string;
  invoiceRef: string;
  rentStart: string;
  rentEnd: string;
  statementsCover12Months: boolean;
  rbeId: string | null;
}

function toKobo(s: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s.replace(/[,₦\s]/g, ""));
  if (!m) return 0;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
}
const naira = (k: number) => "₦" + (k / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Field({ id, label, children, hint, f }: { id: string; label: string; children: React.ReactNode; hint?: string; f: Record<string, string> }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
      {f[id] && <span className="err">{f[id]}</span>}
    </div>
  );
}

function Buttons({ isCorrection, setIntent }: { isCorrection: boolean; setIntent: (s: string) => void }) {
  const { pending } = useFormStatus();
  return (
    <div className="row">
      <button type="submit" className="btn" disabled={pending} onClick={() => setIntent("save")}>
        {pending ? "Saving…" : "Save draft"}
      </button>
      <button type="submit" className="btn btn-primary" disabled={pending} onClick={() => setIntent("submit")}>
        {isCorrection ? "Save and resubmit" : "Save and submit for endorsement"}
      </button>
    </div>
  );
}

export function DraftForm(props: {
  applicationId: string;
  taskId: string;
  applicantType: "INDIVIDUAL" | "ENTERPRISE" | "LIMITED";
  initiatorRole: string;
  data: DraftFormData;
  maskedBvn: string | null;
  maskedTin: string | null;
  directors: { id: string; fullName: string; masked: string }[];
  rbes: { id: string; label: string }[];
  isCorrection: boolean;
  correction: { by: string; reason: string; at: string } | null;
  required: { code: string; label: string; done: boolean }[];
  uploadCategories: { code: string; label: string }[];
  uploaded: { id: string; label: string; href: string; quarantined: boolean }[];
}) {
  const [state, action] = useActionState(saveDraftAction, {});
  const router = useRouter();
  const [d, setD] = useState<DraftFormData>(props.data);
  const [items, setItems] = useState<Item[]>(props.data.items.length ? props.data.items : [{ description: "", quantity: "", unitCost: "" }]);
  const [directors, setDirectors] = useState<Director[]>(props.directors.length ? props.directors.map((x) => ({ ...x, bvn: "" })) : [{ fullName: "", bvn: "" }]);
  const [bvn, setBvn] = useState("");
  const [tin, setTin] = useState("");
  const [intent, setIntent] = useState("save");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const banner = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (props.correction) banner.current?.focus();
  }, [props.correction]);
  useEffect(() => {
    if (state.error && state.fields) {
      const first = Object.keys(state.fields)[0];
      const el = first ? (document.getElementById(first) ?? document.getElementById(first.startsWith("doc_") ? "documents-section" : "")) : null;
      (el ?? formRef.current?.querySelector<HTMLElement>(".alert-error"))?.focus();
    }
  }, [state]);
  useEffect(() => {
    if (state.ok) {
      setKey(crypto.randomUUID());
      setBvn("");
      setTin("");
      router.refresh();
    }
  }, [state, router]);
  const assetCost = useMemo(() => items.reduce((s, i) => s + (Number.parseInt(i.quantity || "0", 10) || 0) * toKobo(i.unitCost || "0"), 0), [items]);
  const f = state.fields ?? {};
  const set = (k: keyof DraftFormData) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });
  const T = props.applicantType;

  const payload = JSON.stringify({
    data: {
      customerName: d.customerName,
      businessName: d.businessName,
      companyName: d.companyName,
      registrationNumber: d.registrationNumber,
      phone: d.phone,
      email: d.email,
      address: d.address,
      daoCode: d.daoCode,
      posSerial: d.posSerial,
      supplierName: d.supplierName,
      supplierAddress: d.supplierAddress,
      supplierPhone: d.supplierPhone,
      supplierAccount: d.supplierAccount,
      invoiceRef: d.invoiceRef,
      rentStart: d.rentStart,
      rentEnd: d.rentEnd,
      statementsCover12Months: d.statementsCover12Months,
      rbeId: d.rbeId,
    },
    amount: d.amount,
    tenor: d.tenor,
    items,
    directors: directors.map((x) => ({ id: x.id ?? null, fullName: x.fullName, bvn: x.bvn })),
    bvn,
    tin,
  });

  return (
    <form ref={formRef} action={action} className="stack" noValidate>
      {props.correction && (
        <div ref={banner} tabIndex={-1} className="alert alert-warn" role="alert">
          <AlertTriangle className="icon" aria-hidden="true" />
          <span>
            <strong>Correction requested</strong> by {props.correction.by} ({props.correction.at}): {props.correction.reason}
          </span>
        </div>
      )}
      <input type="hidden" name="applicationId" value={props.applicationId} />
      <input type="hidden" name="taskId" value={props.taskId} />
      <input type="hidden" name="idempotencyKey" value={key} />
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="payload" value={payload} />
      <FormMessages state={state} />

      <section className="card">
        <h2>1. Applicant</h2>
        <div className="grid-2">
          {T === "LIMITED" ? (
            <Field f={f} id="companyName" label="Company name">
              <input id="companyName" value={d.companyName} onChange={set("companyName")} aria-invalid={!!f.companyName} />
            </Field>
          ) : (
            <Field f={f} id="customerName" label={T === "ENTERPRISE" ? "Proprietor legal name" : "Customer name"}>
              <input id="customerName" value={d.customerName} onChange={set("customerName")} aria-invalid={!!f.customerName} />
            </Field>
          )}
          {T === "ENTERPRISE" && (
            <Field f={f} id="businessName" label="Registered business name">
              <input id="businessName" value={d.businessName} onChange={set("businessName")} aria-invalid={!!f.businessName} />
            </Field>
          )}
          {T !== "INDIVIDUAL" && (
            <Field f={f} id="registrationNumber" label="CAC registration number (BN / RC)">
              <input id="registrationNumber" value={d.registrationNumber} onChange={set("registrationNumber")} aria-invalid={!!f.registrationNumber} />
            </Field>
          )}
          <Field f={f} id="phone" label="Phone">
            <input id="phone" type="text" inputMode="tel" value={d.phone} onChange={set("phone")} aria-invalid={!!f.phone} />
          </Field>
          <Field f={f} id="email" label="Email (optional)">
            <input id="email" type="email" value={d.email} onChange={set("email")} aria-invalid={!!f.email} />
          </Field>
          <Field f={f} id="address" label="Business address">
            <input id="address" value={d.address} onChange={set("address")} />
          </Field>
        </div>
      </section>

      <section className="card">
        <h3>Restricted identifiers</h3>
        <p className="small muted">Stored encrypted. Only the last four digits are displayed. Leave blank to keep the saved value.</p>
        <div className="grid-2">
          {T !== "LIMITED" && (
            <Field f={f} id="bvn" label={T === "ENTERPRISE" ? "Proprietor BVN" : "BVN"} hint={props.maskedBvn ? `Saved: ${props.maskedBvn}` : "11 digits"}>
              <input id="bvn" value={bvn} onChange={(e) => setBvn(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={11} aria-invalid={!!f.bvn} placeholder={props.maskedBvn ?? ""} />
            </Field>
          )}
          {T !== "INDIVIDUAL" && (
            <Field f={f} id="tin" label="TIN" hint={props.maskedTin ? `Saved: ${props.maskedTin}` : "Tax identification number"}>
              <input id="tin" value={tin} onChange={(e) => setTin(e.target.value)} autoComplete="off" aria-invalid={!!f.tin} placeholder={props.maskedTin ?? ""} />
            </Field>
          )}
          {T === "INDIVIDUAL" && (
            <Field f={f} id="tin" label="TIN (if applicable)" hint={props.maskedTin ? `Saved: ${props.maskedTin}` : undefined}>
              <input id="tin" value={tin} onChange={(e) => setTin(e.target.value)} autoComplete="off" aria-invalid={!!f.tin} />
            </Field>
          )}
        </div>
        {T === "LIMITED" && (
          <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, marginTop: 12 }}>
            <legend style={{ fontWeight: 700 }}>Directors ({directors.length})</legend>
            {f.directors && <p className="err">{f.directors}</p>}
            {directors.map((x, i) => (
              <div className="grid-2" key={i} style={{ marginBottom: 10, alignItems: "end" }}>
                <Field f={f} id={`directors.${i}.fullName`} label={`Director ${i + 1} full name`}>
                  <input id={`directors.${i}.fullName`} value={x.fullName} onChange={(e) => setDirectors(directors.map((y, j) => (j === i ? { ...y, fullName: e.target.value } : y)))} />
                </Field>
                <div className="row" style={{ alignItems: "end", flexWrap: "nowrap" }}>
                  <div style={{ flex: 1 }}>
                    <Field f={f} id={`directors.${i}.bvn`} label="BVN" hint={x.masked ? `Saved: ${x.masked}` : undefined}>
                      <input id={`directors.${i}.bvn`} value={x.bvn} inputMode="numeric" maxLength={11} autoComplete="off" onChange={(e) => setDirectors(directors.map((y, j) => (j === i ? { ...y, bvn: e.target.value } : y)))} />
                    </Field>
                  </div>
                  {directors.length > 1 && (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDirectors(directors.filter((_, j) => j !== i))} aria-label={`Remove director ${i + 1}`}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => setDirectors([...directors, { fullName: "", bvn: "" }])}>
              Add director
            </button>
          </fieldset>
        )}
      </section>

      <section className="card">
        <h2>2. Facility</h2>
        <div className="grid-3">
          <Field f={f} id="requestedAmountKobo" label="Requested amount (₦)" hint="₦1 – ₦50,000,000">
            <input id="requestedAmountKobo" value={d.amount} onChange={set("amount")} inputMode="decimal" aria-invalid={!!f.requestedAmountKobo} />
          </Field>
          <Field f={f} id="tenorMonths" label="Tenor (months)">
            <input id="tenorMonths" value={d.tenor} onChange={set("tenor")} inputMode="numeric" aria-invalid={!!f.tenorMonths} />
          </Field>
          <Field f={f} id="daoCode" label="DAO code">
            <input id="daoCode" value={d.daoCode} onChange={set("daoCode")} aria-invalid={!!f.daoCode} />
          </Field>
          <Field f={f} id="posSerial" label="POS serial number">
            <input id="posSerial" value={d.posSerial} onChange={set("posSerial")} aria-invalid={!!f.posSerial} />
          </Field>
        </div>
        <h3 style={{ marginTop: 16 }}>Items to finance</h3>
        {f.items && <p className="err">{f.items}</p>}
        {items.map((it, i) => (
          <div key={i} className="row" style={{ marginBottom: 8, alignItems: "end" }}>
            <div className="field" style={{ flex: "2 1 220px" }}>
              <label htmlFor={`item-d-${i}`}>Item {i + 1}</label>
              <input id={`item-d-${i}`} value={it.description} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
            </div>
            <div className="field" style={{ flex: "0 1 110px" }}>
              <label htmlFor={`item-q-${i}`}>Quantity</label>
              <input id={`item-q-${i}`} value={it.quantity} inputMode="numeric" onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
            </div>
            <div className="field" style={{ flex: "1 1 150px" }}>
              <label htmlFor={`item-u-${i}`}>Unit cost (₦)</label>
              <input id={`item-u-${i}`} value={it.unitCost} inputMode="decimal" onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, unitCost: e.target.value } : x)))} />
            </div>
            {items.length > 1 && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label={`Remove item ${i + 1}`}>
                Remove
              </button>
            )}
          </div>
        ))}
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => setItems([...items, { description: "", quantity: "", unitCost: "" }])}>
            Add item
          </button>
          <span className="spacer" />
          <strong>Asset cost: {naira(assetCost)}</strong>
        </div>
      </section>

      <section className="card">
        <h3>Rent and statements</h3>
        <div className="grid-2">
          <Field f={f} id="rentStart" label="Rental coverage start" hint="Coverage must be active on submission (Lagos time).">
            <input id="rentStart" type="date" value={d.rentStart} onChange={set("rentStart")} aria-invalid={!!f.rentStart} />
          </Field>
          <Field f={f} id="rentEnd" label="Rental coverage end">
            <input id="rentEnd" type="date" value={d.rentEnd} onChange={set("rentEnd")} aria-invalid={!!f.rentEnd} />
          </Field>
        </div>
        <label className="check" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={d.statementsCover12Months} onChange={(e) => setD({ ...d, statementsCover12Months: e.target.checked })} />
          The uploaded bank statements cover the last 12 months.
        </label>
        {f.statementsCover12Months && <span className="err">{f.statementsCover12Months}</span>}
      </section>

      {props.initiatorRole === "RM" && (
        <section className="card">
          <h3>Business endorsement</h3>
          <Field f={f} id="rbeId" label="Regional Business Executive" hint="The request goes to this RBE for endorsement.">
            <select id="rbeId" value={d.rbeId ?? ""} onChange={(e) => setD({ ...d, rbeId: e.target.value || null })} aria-invalid={!!f.rbeId}>
              <option value="">Select by name…</option>
              {props.rbes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
        </section>
      )}
      <section className="card">
        <h2>3. Vendor</h2>
        <div className="grid-2">
          <Field f={f} id="supplierName" label="Supplier name">
            <input id="supplierName" value={d.supplierName} onChange={set("supplierName")} aria-invalid={!!f.supplierName} />
          </Field>
          <Field f={f} id="supplierPhone" label="Supplier phone">
            <input id="supplierPhone" value={d.supplierPhone} onChange={set("supplierPhone")} />
          </Field>
          <Field f={f} id="supplierAddress" label="Supplier address">
            <input id="supplierAddress" value={d.supplierAddress} onChange={set("supplierAddress")} />
          </Field>
          <Field f={f} id="supplierAccount" label="Supplier account (for vendor payment)">
            <input id="supplierAccount" value={d.supplierAccount} onChange={set("supplierAccount")} />
          </Field>
          <Field f={f} id="invoiceRef" label="Invoice reference">
            <input id="invoiceRef" value={d.invoiceRef} onChange={set("invoiceRef")} aria-invalid={!!f.invoiceRef} />
          </Field>
        </div>
      </section>

      <section className="card" id="documents-section" tabIndex={-1}>
        <h2>4. Documents</h2>
        <ul className="checklist" style={{ marginBottom: 12 }}>
          {props.required.map((r) => (
            <li key={r.code}>
              <span className={`tick ${r.done ? "ok" : "no"}`} aria-hidden="true">
                {r.done ? <CheckCircle2 className="icon" /> : <Circle className="icon" />}
              </span>
              {r.label}
              <span className="sr-only">{r.done ? "(uploaded)" : "(missing)"}</span>
            </li>
          ))}
        </ul>
        <UploadPanel applicationId={props.applicationId} categories={props.uploadCategories} />
        {props.uploaded.length > 0 && (
          <ul style={{ margin: "12px 0 0", paddingLeft: 18 }}>
            {props.uploaded.map((d) => (
              <li key={d.id} className="small">
                <a href={d.href}>{d.label}</a> {d.quarantined && <span className="badge badge-warn">Quarantined</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
      {Object.keys(f).some((k) => k.startsWith("doc_")) && (
        <div className="alert alert-error">
          {Object.entries(f)
            .filter(([k]) => k.startsWith("doc_"))
            .map(([k, v]) => (
              <div key={k}>{v}</div>
            ))}
        </div>
      )}
      <Buttons isCorrection={props.isCorrection} setIntent={setIntent} />
    </form>
  );
}
