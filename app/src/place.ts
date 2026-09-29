import type { Place } from "./lib/place";

/**
 * Where this app is. The only place the city is named outside the data
 * sources (`src/sources.ts`): another city is a change to these two files. See
 * `src/lib/place/specs/spec.md`.
 */
export const PLACE: Place = {
  name: "Taipei",
  timeZone: "Asia/Taipei",
  // Asia/Taipei is UTC+8 all year, with no daylight saving since 1979, so a
  // fixed offset is exact here.
  utcOffsetMin: 8 * 60,
  home: {
    id: "xinyi",
    label: "Xinyi",
    sub: "信義 · Taipei 101",
    center: [121.5608, 25.0345],
    zoom: 15.4,
    pitch: 66,
    bearing: -28,
  },
  // The panel's time-of-day range: 05:00–19:00 local.
  daylight: { fromMin: 5 * 60, toMin: 19 * 60 },
};
