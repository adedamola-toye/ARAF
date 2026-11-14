"use client";
import { useMemo, useState } from "react";

export interface PickerOption {
  id: string;
  name: string;
  state: string;
  type: "BRANCH" | "ALTSHOP" | "ALTBOX";
  address: string;
  /** Optional extra shown after the name, e.g. stock available. */
  note?: string;
  disabled?: boolean;
}
const TYPE_LABEL = { BRANCH: "Branch", ALTSHOP: "Altshop", ALTBOX: "Altbox" } as const;

/**
 * State → Location type → Location, with the registered address shown read-only. Only the location id is submitted:
 * the address always comes from the location master on the server, never from what the browser sends.
 */
export function LocationPicker({
  name,
  label,
  options,
  types,
  defaultId,
  hint,
  idPrefix = name,
}: {
  name: string;
  label: string;
  options: PickerOption[];
  types: PickerOption["type"][];
  defaultId?: string | null;
  hint?: string;
  idPrefix?: string;
}) {
  const initial = options.find((o) => o.id === defaultId) ?? null;
  const states = useMemo(() => [...new Set(options.map((o) => o.state))].sort(), [options]);
  const [state, setState] = useState(initial?.state ?? (states.length === 1 ? states[0] : ""));
  const typesHere = useMemo(() => types.filter((t) => options.some((o) => o.state === state && o.type === t)), [types, options, state]);
  const [type, setType] = useState<string>(initial?.type ?? (types.length === 1 ? types[0] : ""));
  const effectiveType = typesHere.length === 1 ? typesHere[0] : typesHere.includes(type as PickerOption["type"]) ? type : "";
  const list = options.filter((o) => o.state === state && o.type === effectiveType);
  const [id, setId] = useState(initial?.id ?? "");
  const selected = list.find((o) => o.id === id) ?? null;

  return (
    <fieldset className="loc-picker">
      <legend>{label}</legend>
      <div className="loc-picker-grid">
        <div className="field">
          <label htmlFor={`${idPrefix}-state`}>State</label>
          <select
            id={`${idPrefix}-state`}
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setId("");
            }}
            required
          >
            <option value="">Choose the state</option>
            {states.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {types.length > 1 && (
          <div className="field">
            <label htmlFor={`${idPrefix}-type`}>Location type</label>
            <select
              id={`${idPrefix}-type`}
              value={effectiveType}
              onChange={(e) => {
                setType(e.target.value);
                setId("");
              }}
              disabled={!state}
              required
            >
              <option value="">{state ? "Choose the type" : "Choose the state first"}</option>
              {typesHere.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor={`${idPrefix}-loc`}>{types.length === 1 ? TYPE_LABEL[types[0]] : "Location"}</label>
          <select id={`${idPrefix}-loc`} name={name} value={selected ? id : ""} onChange={(e) => setId(e.target.value)} disabled={!state || !effectiveType} required>
            <option value="">{!state ? "Choose the state first" : !effectiveType ? "Choose the type first" : list.length ? "Choose the location" : "No registered locations here"}</option>
            {list.map((o) => (
              <option key={o.id} value={o.id} disabled={o.disabled}>
                {o.name}
                {o.note ? ` · ${o.note}` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <span className="loc-address-label" id={`${idPrefix}-addr-label`}>
          Registered address
        </span>
        <p className="loc-address" aria-labelledby={`${idPrefix}-addr-label`} aria-live="polite">
          {selected ? selected.address : <span className="muted">Shown when you choose a location</span>}
        </p>
        {hint && <span className="hint">{hint}</span>}
      </div>
    </fieldset>
  );
}
