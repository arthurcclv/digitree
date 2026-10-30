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
  // Da'an, on Jianguo S Rd just south of Zhongxiao E Rd, north up at z17.36.
  // Why this block: ai/DECISIONS.md, 2026-10-30.
  home: {
    id: "daan",
    label: "Da'an",
    sub: "大安 · Taipei",
    center: [121.539873, 25.039784],
    zoom: 17.36,
    pitch: 66,
    bearing: 0,
  },
  // The panel's time-of-day range: 05:00–19:00 local.
  daylight: { fromMin: 5 * 60, toMin: 19 * 60 },
};
