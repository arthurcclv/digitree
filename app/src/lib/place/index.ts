/**
 * Where the app is, as opposed to what it shows: the home view, the panel's
 * daylight range, and local time at a fixed UTC offset. Names no city; the
 * app's own place is `src/place.ts`. See `specs/spec.md`.
 */

/** A named camera position. */
export interface Viewpoint {
  id: string;
  label: string;
  sub: string;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface Place {
  /** For labels, such as the time slider's. */
  name: string;
  /** For labels only; the arithmetic reads `utcOffsetMin`. */
  timeZone: string;
  /** Fixed, with no daylight saving. See *Fixed offsets*. */
  utcOffsetMin: number;
  /** The initial camera. */
  home: Viewpoint;
  /** The panel's time-of-day range, in local minutes past midnight. */
  daylight: { fromMin: number; toMin: number };
}

type Offset = Pick<Place, "utcOffsetMin">;

const offsetMs = (place: Offset) => place.utcOffsetMin * 60_000;

/** `YYYY-MM-DD` at the place. */
export function localDate(ms: number, place: Offset): string {
  return new Date(ms + offsetMs(place)).toISOString().slice(0, 10);
}

/** Minutes past local midnight at the place. */
export function localMinutes(ms: number, place: Offset): number {
  const d = new Date(ms + offsetMs(place));
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** The epoch ms of a local date and minute of day at the place. */
export function fromLocal(date: string, minutes: number, place: Offset): number {
  return Date.parse(`${date}T00:00:00Z`) - offsetMs(place) + minutes * 60_000;
}

/** Today at noon, local time at the place. */
export function noonToday(place: Offset, now = Date.now()): number {
  return fromLocal(localDate(now, place), 12 * 60, place);
}

/** The offset as a readout shows it: `+08`, `-05`, `+05:30`. */
export function offsetLabel(place: Offset): string {
  const m = place.utcOffsetMin;
  const abs = Math.abs(m);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : "";
  return `${m < 0 ? "-" : "+"}${hh}${mm}`;
}
