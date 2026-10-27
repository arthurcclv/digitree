import { StatLine } from "./Panel";

/**
 * The picked tree's card, rendered into the map popup the host anchors at the
 * tree. Knows no tree: the app hands it the title, the kind and the rows.
 */
export function TreeCard({
  title,
  kind,
  kindColor,
  rows,
  onClose,
}: {
  title: string;
  kind: string;
  kindColor: string | undefined;
  rows: { label: string; value: string }[];
  onClose: () => void;
}) {
  return (
    <section className="panel tree-card">
      <header className="panel__head">
        <h2 className="tree-card__title">{title}</h2>
        <span className="badge tree-card__kind" style={kindColor ? { color: kindColor } : undefined}>
          {kind}
        </span>
        <button className="tree-card__close" onClick={onClose} aria-label="Close" title="Close">
          ×
        </button>
      </header>
      <div className="tree-card__rows">
        {rows.map((r) => (
          <StatLine key={r.label} k={r.label} v={r.value} />
        ))}
      </div>
    </section>
  );
}
