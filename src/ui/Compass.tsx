/** Hand-drawn compass rose; the needle tracks the map bearing. Click = north. */
export function Compass({ bearing, onReset }: { bearing: number; onReset: () => void }) {
  return (
    <button
      className="pad compass"
      onClick={onReset}
      title="Reset bearing to north"
      aria-label={`Bearing ${Math.round(((bearing % 360) + 360) % 360)} degrees. Reset to north.`}
    >
      <svg viewBox="0 0 44 52" width="44" height="52" fill="none">
        <g transform={`rotate(${-bearing} 22 27)`}>
          <circle cx="22" cy="27" r="13.5" stroke="currentColor" strokeOpacity="0.28" />
          {Array.from({ length: 12 }, (_, i) => (
            <line
              key={i}
              x1="22"
              y1="14.5"
              x2="22"
              y2={i % 3 === 0 ? "11" : "12.6"}
              stroke="currentColor"
              strokeOpacity={i % 3 === 0 ? 0.6 : 0.3}
              transform={`rotate(${i * 30} 22 27)`}
            />
          ))}
          <path d="M22 16.5 L26 29 L22 26.5 L18 29 Z" fill="var(--accent)" />
          <path d="M22 37.5 L26 29 L22 26.5 L18 29 Z" fill="currentColor" fillOpacity="0.35" />
        </g>
        <text
          x="22"
          y="49"
          textAnchor="middle"
          fontFamily="var(--mono)"
          fontSize="8"
          letterSpacing="1.4"
          fill="currentColor"
          fillOpacity="0.55"
        >
          N
        </text>
      </svg>
    </button>
  );
}
