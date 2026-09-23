import { useEffect, useRef, useState, type ReactNode } from "react";

export function Panel({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel__head">
        <h2 className="panel__title">{title}</h2>
        {badge}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}

/**
 * A bounded scalar. Everything — min, max, step, value — is in *display* units;
 * the caller converts (opacity is passed as 0–100, not 0–1) so this component
 * carries no unit knowledge.
 *
 * The readout is an editable input rather than a chip: typing an exact value is
 * the thing a drag-only control cannot do. It commits on blur and Enter and
 * reverts on Escape, and while it is not being edited it tracks the prop — the
 * pitch field has to follow the camera as the user drags the map.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  decimals = 0,
  title,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  decimals?: number;
  title?: string;
  onChange: (next: number) => void;
}) {
  const shown = value.toFixed(decimals);
  const [draft, setDraft] = useState<string | null>(null);
  // Escape blurs, and blur commits — so the cancel has to be remembered across
  // the two events, and a ref is the only thing the blur handler can read
  // before React has re-rendered the cleared draft.
  const cancelled = useRef(false);

  // Drop a stale draft if the value moves underneath us (a viewpoint flight
  // changes pitch while the field is untouched).
  useEffect(() => {
    setDraft(null);
  }, [shown]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    setDraft(null);
    if (!Number.isFinite(parsed)) return;
    onChange(Math.min(max, Math.max(min, parsed)));
  };

  const fill = ((value - min) / (max - min)) * 100;

  return (
    <div className="field">
      <div className="field__row">
        <span className="field__label" title={title}>
          {label}
        </span>
      </div>
      <div className="field__control">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          title={title}
          style={{ ["--fill" as string]: `${fill}%` }}
          onChange={(e) => onChange(Number(e.currentTarget.value))}
        />
        <input
          type="text"
          className="slider-value"
          value={draft ?? shown}
          aria-label={`${label} value`}
          title={title}
          inputMode="decimal"
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={(e) => {
            if (cancelled.current) {
              cancelled.current = false;
              setDraft(null);
              return;
            }
            commit(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              cancelled.current = true;
              e.currentTarget.blur();
            }
          }}
        />
        <span className="field__unit">{unit}</span>
      </div>
    </div>
  );
}

/** Every flag in the app takes this form. */
export function CheckboxRow({
  label,
  checked,
  onChange,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  title?: string;
}) {
  return (
    <label className="checkbox-row" title={title}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      {label}
    </label>
  );
}

export interface SegmentedItem {
  id: string;
  label: string;
  /** A CSS colour or gradient. Data colour — never a chrome token. */
  swatch?: string;
}

export function Segmented({
  items,
  value,
  columns,
  label,
  onChange,
}: {
  items: SegmentedItem[];
  value: string | null;
  columns: 2 | 3 | 4;
  label: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className={`segmented segmented--${columns}`} role="group" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          aria-pressed={item.id === value}
          onClick={() => onChange(item.id)}
          title={item.label}
        >
          {item.swatch ? (
            <span className="swatch" style={{ background: item.swatch }} aria-hidden />
          ) : null}
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone: "sync" | "loading" | "tile-error";
  children: ReactNode;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden />;
}

export function StatLine({
  k,
  v,
  plain = false,
}: {
  k: string;
  v: string;
  plain?: boolean;
}) {
  return (
    <div className="stat-line">
      <span className="stat-line__k">{k}</span>
      <span className={plain ? "stat-line__v stat-line__v--plain" : "stat-line__v"}>{v}</span>
    </div>
  );
}
