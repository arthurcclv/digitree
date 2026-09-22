import { useEffect, useRef, useState } from "react";

export interface LayerToggle {
  id: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

/**
 * The viewport's layer-visibility popover. Toggling keeps it open; it closes on
 * outside click, Escape, or re-clicking the button.
 *
 * Every flag here also lives in its own panel — this is the fast path, not a
 * second source of truth.
 */
export function LayerMenu({ layers }: { layers: LayerToggle[] }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="menu-anchor" ref={anchorRef}>
      <button
        className="icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Layers"
        title="Layers"
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none">
          <path
            d="M10 4.5 L17 8.5 L10 12.5 L3 8.5 Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path
            d="M3.6 11.6 L10 15.3 L16.4 11.6"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <ul className="menu" role="menu">
          {layers.map((layer) => (
            <li key={layer.id} role="none">
              <label className="menu-row" role="menuitemcheckbox" aria-checked={layer.checked}>
                <input
                  type="checkbox"
                  checked={layer.checked}
                  onChange={(e) => layer.onChange(e.currentTarget.checked)}
                />
                {layer.label}
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
