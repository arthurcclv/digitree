/**
 * The sun's position — the NOAA solar position algorithm in its spreadsheet
 * formulation, without atmospheric refraction. See *Sun position* in
 * `specs/spec.md`.
 */

export interface SunPosition {
  /** Clockwise from true north, in [0, 360). */
  azimuthDeg: number;
  /** Above the horizon; negative at night. */
  elevationDeg: number;
}

/** Below this the layer computes nothing. */
export const MIN_SUN_ELEVATION_DEG = 10;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const mod = (x: number, m: number) => ((x % m) + m) % m;

export function sunPosition(time: Date, lng: number, lat: number): SunPosition {
  const ms = time.getTime();
  const jd = ms / 86_400_000 + 2_440_587.5;
  const t = (jd - 2_451_545) / 36_525;

  const l0 = mod(280.46646 + t * (36_000.76983 + t * 0.0003032), 360);
  const m = 357.52911 + t * (35_999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));

  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTimeMin =
    4 *
    DEG *
    (y * Math.sin(2 * l0 * RAD) -
      2 * e * Math.sin(m * RAD) +
      4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD) -
      0.5 * y * y * Math.sin(4 * l0 * RAD) -
      1.25 * e * e * Math.sin(2 * m * RAD));

  // Minutes past midnight UTC; the longitude term converts to local solar time.
  const utcMin = mod(ms, 86_400_000) / 60_000;
  const trueSolarMin = mod(utcMin + eqTimeMin + 4 * lng, 1440);
  const hourAngle = trueSolarMin / 4 < 0 ? trueSolarMin / 4 + 180 : trueSolarMin / 4 - 180;

  const phi = lat * RAD;
  const cosZen =
    Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(hourAngle * RAD);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZen)));

  const denom = Math.cos(phi) * Math.sin(zen);
  let azimuthDeg: number;
  if (Math.abs(denom) < 1e-12) {
    azimuthDeg = 180;
  } else {
    const cosAz = (Math.sin(phi) * Math.cos(zen) - Math.sin(decl)) / denom;
    const az = DEG * Math.acos(Math.min(1, Math.max(-1, cosAz)));
    azimuthDeg = hourAngle > 0 ? mod(az + 180, 360) : mod(540 - az, 360);
  }

  return { azimuthDeg, elevationDeg: 90 - zen * DEG };
}

/** The solar declination, in degrees — exposed for the tests' closed-form checks. */
export function declinationDeg(time: Date): number {
  const jd = time.getTime() / 86_400_000 + 2_440_587.5;
  const t = (jd - 2_451_545) / 36_525;
  const l0 = mod(280.46646 + t * (36_000.76983 + t * 0.0003032), 360);
  const m = 357.52911 + t * (35_999.05029 - 0.0001537 * t);
  const c =
    Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  return DEG * Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
}
