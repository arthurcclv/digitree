// WGS 84 <-> UTM, Krüger's series to n³: under 1 mm within a zone. Shared by
// control-points.mjs (GNSS fixes into a PLY's frame) and splat-align.mjs (the
// same, to fit the trajectory); the inverse is for the tests' fixtures.
const A_WGS84 = 6378137, F_WGS84 = 1 / 298.257223563, K0 = 0.9996;
const n = F_WGS84 / (2 - F_WGS84);
const A = (A_WGS84 / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64);
const ALPHA = [n / 2 - (2 * n ** 2) / 3 + (5 * n ** 3) / 16, (13 * n ** 2) / 48 - (3 * n ** 3) / 5, (61 * n ** 3) / 240];
const BETA = [n / 2 - (2 * n ** 2) / 3 + (37 * n ** 3) / 96, n ** 2 / 48 + n ** 3 / 15, (17 * n ** 3) / 480];
const DELTA = [2 * n - (2 * n ** 2) / 3 - 2 * n ** 3, (7 * n ** 2) / 3 - (8 * n ** 3) / 5, (56 * n ** 3) / 15];
const centralMeridian = (zone) => zone * 6 - 183;

export function utm(latDeg, lonDeg, zone, north) {
  const e = (2 * Math.sqrt(n)) / (1 + n);
  const phi = (latDeg * Math.PI) / 180;
  const lam = ((lonDeg - centralMeridian(zone)) * Math.PI) / 180;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam));
  const eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let E = eta, N = xi;
  ALPHA.forEach((a, j) => {
    E += a * Math.cos(2 * (j + 1) * xi) * Math.sinh(2 * (j + 1) * eta);
    N += a * Math.sin(2 * (j + 1) * xi) * Math.cosh(2 * (j + 1) * eta);
  });
  return [500000 + K0 * A * E, K0 * A * N + (north ? 0 : 10000000)];
}

export function utmInverse(E, N, zone, north) {
  const xi = (N - (north ? 0 : 10000000)) / (K0 * A);
  const eta = (E - 500000) / (K0 * A);
  let xi1 = xi, eta1 = eta;
  BETA.forEach((b, j) => {
    xi1 -= b * Math.sin(2 * (j + 1) * xi) * Math.cosh(2 * (j + 1) * eta);
    eta1 -= b * Math.cos(2 * (j + 1) * xi) * Math.sinh(2 * (j + 1) * eta);
  });
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let phi = chi;
  DELTA.forEach((d, j) => { phi += d * Math.sin(2 * (j + 1) * chi); });
  const lam = Math.atan2(Math.sinh(eta1), Math.cos(xi1));
  return [(phi * 180) / Math.PI, centralMeridian(zone) + (lam * 180) / Math.PI];
}

// The zone and hemisphere of a WGS 84 / UTM EPSG code, or null for any other.
export function utmZone(epsg) {
  if (epsg >= 32601 && epsg <= 32660) return { zone: epsg - 32600, north: true };
  if (epsg >= 32701 && epsg <= 32760) return { zone: epsg - 32700, north: false };
  return null;
}
