"use client";
import { useEffect, useRef, useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { signOnDeviceAction } from "../../closing-actions";

/** Finger / stylus signature pad (pointer events; works with touch, pen and mouse). */
function SignaturePad({ onChange }: { onChange: (png: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const inked = useRef(false);
  useEffect(() => {
    const c = ref.current!;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = w * ratio;
    c.height = h * ratio;
    const g = c.getContext("2d")!;
    g.scale(ratio, ratio);
    g.lineWidth = 2.2;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = "#111";
  }, []);
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  return (
    <div className="sig-pad">
      <canvas
        ref={ref}
        aria-label="Signature area: sign with a finger or stylus"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          const [x, y] = pos(e);
          const g = e.currentTarget.getContext("2d")!;
          g.beginPath();
          g.moveTo(x, y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const [x, y] = pos(e);
          const g = e.currentTarget.getContext("2d")!;
          g.lineTo(x, y);
          g.stroke();
          inked.current = true;
        }}
        onPointerUp={(e) => {
          drawing.current = false;
          if (inked.current) {
            // White background so the signature prints cleanly.
            const c = e.currentTarget;
            const out = document.createElement("canvas");
            out.width = c.width;
            out.height = c.height;
            const g = out.getContext("2d")!;
            g.fillStyle = "#fff";
            g.fillRect(0, 0, out.width, out.height);
            g.drawImage(c, 0, 0);
            onChange(out.toDataURL("image/png"));
          }
        }}
      />
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          const c = ref.current!;
          c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
          inked.current = false;
          onChange(null);
        }}
      >
        Clear
      </button>
    </div>
  );
}

interface Signer {
  name: string;
  role: string;
  png: string | null;
}

export function SignForm({ applicationId, sourceDocumentId, customerName, idTypes, roles }: { applicationId: string; sourceDocumentId: string; customerName: string; idTypes: readonly string[]; roles: readonly string[] }) {
  const [signers, setSigners] = useState<Signer[]>([{ name: customerName, role: "Customer", png: null }]);
  const set = (i: number, patch: Partial<Signer>) => setSigners((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const ready = signers.every((s) => s.png && s.name.trim().length >= 3);
  return (
    <ActionForm action={signOnDeviceAction} className="stack">
      {(st) => (
        <>
          <input type="hidden" name="applicationId" value={applicationId} />
          <input type="hidden" name="sourceDocumentId" value={sourceDocumentId} />
          <input type="hidden" name="signatories" value={JSON.stringify(signers.map((s) => ({ name: s.name, role: s.role, signaturePng: s.png ?? "" })))} />
          <fieldset className="ps-checks">
            <legend>Identity check (by you)</legend>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="sg-idt">ID sighted</label>
                <select id="sg-idt" name="idType" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {idTypes.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                {st.fields?.idType && <span className="err">{st.fields.idType}</span>}
              </div>
              <div className="field">
                <label htmlFor="sg-id4">Last 4 characters of the ID number</label>
                <input id="sg-id4" name="idLast4" required maxLength={4} pattern="[A-Za-z0-9]{4}" autoComplete="off" />
                {st.fields?.idLast4 && <span className="err">{st.fields.idLast4}</span>}
              </div>
            </div>
            <label className="check">
              <input type="checkbox" name="idVerified" required />
              <span>I have checked the customer&apos;s original ID and they are the person named in this document.</span>
            </label>
          </fieldset>
          {signers.map((s, i) => (
            <fieldset key={i} className="ps-checks">
              <legend>Signatory {i + 1}</legend>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor={`sg-n${i}`}>Full name</label>
                  <input id={`sg-n${i}`} value={s.name} onChange={(e) => set(i, { name: e.target.value })} required />
                </div>
                <div className="field">
                  <label htmlFor={`sg-r${i}`}>Signing as</label>
                  <select id={`sg-r${i}`} value={s.role} onChange={(e) => set(i, { role: e.target.value })}>
                    {roles.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </div>
              </div>
              <SignaturePad onChange={(png) => set(i, { png })} />
              {signers.length > 1 && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSigners((xs) => xs.filter((_, j) => j !== i))}>
                  Remove signatory
                </button>
              )}
            </fieldset>
          ))}
          {signers.length < 4 && (
            <div>
              <button type="button" className="btn btn-sm" onClick={() => setSigners((xs) => [...xs, { name: "", role: "Director", png: null }])}>
                Add another signatory
              </button>
            </div>
          )}
          <label className="check">
            <input type="checkbox" name="consent" required />
            <span>The customer has read this document and agrees to sign it electronically.</span>
          </label>
          {st.fields?.consent && <span className="err">{st.fields.consent}</span>}
          <div>
            <SubmitButton disabled={!ready}>Save signed document</SubmitButton>
          </div>
          {!ready && <p className="small muted" style={{ margin: 0 }}>Each signatory signs in their box first.</p>}
        </>
      )}
    </ActionForm>
  );
}
