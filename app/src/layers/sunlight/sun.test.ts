import { describe, expect, test } from "vitest";
import { declinationDeg, sunPosition } from "./sun";

const TAIPEI = { lng: 121.5654, lat: 25.033 };

/** The sun's highest elevation on a day, found by scanning — no solar-noon formula to trust. */
function noon(day: string): { time: Date; elevationDeg: number; azimuthDeg: number } {
  let best = { time: new Date(0), elevationDeg: -90, azimuthDeg: 0 };
  const start = new Date(`${day}T10:00:00+08:00`).getTime();
  for (let s = 0; s <= 4 * 3600; s += 10) {
    const time = new Date(start + s * 1000);
    const p = sunPosition(time, TAIPEI.lng, TAIPEI.lat);
    if (p.elevationDeg > best.elevationDeg) best = { time, ...p };
  }
  return best;
}

describe("sunPosition", () => {
  test.each(["2026-06-21", "2026-12-21", "2026-03-20"])(
    "solar noon elevation on %s is 90 − |φ − δ|",
    (day) => {
      const n = noon(day);
      const expected = 90 - Math.abs(TAIPEI.lat - declinationDeg(n.time));
      expect(Math.abs(n.elevationDeg - expected)).toBeLessThan(0.1);
    },
  );

  test("the June solstice sun at Taipei nearly reaches the zenith", () => {
    // 25.03° N, 23.44° declination: 88.4° at its highest.
    expect(noon("2026-06-21").elevationDeg).toBeGreaterThan(88.2);
    expect(noon("2026-06-21").elevationDeg).toBeLessThan(88.6);
  });

  test("the December solstice sun peaks due south", () => {
    const n = noon("2026-12-21");
    expect(Math.abs(n.azimuthDeg - 180)).toBeLessThan(0.5);
    expect(n.elevationDeg).toBeCloseTo(90 - 25.033 - 23.44, 0);
  });

  test.each([
    // 121.57° E is 6.3 minutes east of the UTC+8 meridian; the equation of time
    // (published: −7.4 min on 20 March, +16.4 min on 3 November) does the rest.
    ["2026-03-20", 12 * 60 + 1.1],
    ["2026-11-03", 12 * 60 - 6.3 - 16.4],
  ])("Taipei's solar noon on %s falls where the equation of time puts it", (day, want) => {
    const local = new Date(noon(day).time.getTime() + 8 * 3600_000);
    const minutes = local.getUTCHours() * 60 + local.getUTCMinutes() + local.getUTCSeconds() / 60;
    expect(Math.abs(minutes - want)).toBeLessThan(1);
  });

  test("morning sun is east of south and afternoon sun west of it", () => {
    const am = sunPosition(new Date("2026-12-21T09:00:00+08:00"), TAIPEI.lng, TAIPEI.lat);
    const pm = sunPosition(new Date("2026-12-21T15:00:00+08:00"), TAIPEI.lng, TAIPEI.lat);
    expect(am.azimuthDeg).toBeGreaterThan(90);
    expect(am.azimuthDeg).toBeLessThan(180);
    expect(pm.azimuthDeg).toBeGreaterThan(180);
    expect(pm.azimuthDeg).toBeLessThan(270);
  });

  test("the sun is below the horizon at midnight", () => {
    const p = sunPosition(new Date("2026-06-21T00:00:00+08:00"), TAIPEI.lng, TAIPEI.lat);
    expect(p.elevationDeg).toBeLessThan(0);
  });

  test("equinox sunrise is due east", () => {
    // Scan for the moment the sun crosses the horizon.
    const start = new Date("2026-03-20T05:00:00+08:00").getTime();
    let rise = null;
    for (let s = 0; s < 3 * 3600; s += 5) {
      const p = sunPosition(new Date(start + s * 1000), TAIPEI.lng, TAIPEI.lat);
      if (p.elevationDeg >= 0) {
        rise = p;
        break;
      }
    }
    expect(rise).not.toBeNull();
    expect(Math.abs(rise!.azimuthDeg - 90)).toBeLessThan(1);
  });
});
