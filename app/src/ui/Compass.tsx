/**
 * Bearing rose, sized onto the icon-button grid. The needle tracks the map
 * bearing and a click resets to north; the bearing is *also* stated numerically
 * in the Camera card, so rotation is never the only cue.
 */
export function Compass({ bearing, onReset }: { bearing: number; onReset: () => void }) {
  const degrees = Math.round(((bearing % 360) + 360) % 360);
  return (
    <button
      className="icon-btn compass"
      onClick={onReset}
      title={`Bearing ${degrees}° — reset to north`}
      aria-label={`Bearing ${degrees} degrees. Reset to north.`}
    >
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none">
        <circle cx="10" cy="10" r="8" stroke="currentColor" strokeOpacity="0.35" />
        <g transform={`rotate(${-bearing} 10 10)`}>
          <path d="M10 3 L13 12 L10 10.2 L7 12 Z" fill="var(--accent-text)" />
          <path d="M10 17 L13 12 L10 10.2 L7 12 Z" fill="currentColor" fillOpacity="0.4" />
        </g>
      </svg>
    </button>
  );
}
