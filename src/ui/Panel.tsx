import type { ReactNode } from "react";

export function Panel({
  index,
  title,
  delay = 0,
  children,
}: {
  index: string;
  title: string;
  delay?: number;
  children: ReactNode;
}) {
  return (
    <section className="panel" style={{ animationDelay: `${delay}ms` }}>
      <header className="panel__head">
        <span className="panel__index">{index}</span>
        <h2 className="panel__title">{title}</h2>
        <span className="panel__rule" />
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}

export function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button className="toggle" aria-pressed={on} onClick={() => onChange(!on)}>
      <span className="toggle__label">{label}</span>
      <span className="toggle__lamp" aria-hidden />
    </button>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  format?: (v: number) => string;
  onChange: (next: number) => void;
}) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div className="field">
      <div className="field__row">
        <span className="field__label">{label}</span>
        <span className="field__value">
          {format ? format(value) : value.toFixed(step < 1 ? 2 : 0)}
          {unit ? <small>{unit}</small> : null}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ ["--fill" as string]: `${fill}%` }}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
      <div className="ticks" aria-hidden>
        {Array.from({ length: 9 }, (_, i) => (
          <i key={i} />
        ))}
      </div>
    </div>
  );
}
