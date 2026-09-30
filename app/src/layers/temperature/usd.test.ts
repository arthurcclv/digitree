import { afterEach, describe, expect, test, vi } from "vitest";
import { lngLatToMercator, metreInMercator } from "../../lib/tiles";
import type { ExportFrame } from "../../lib/usd";
import { stubPngEncoder } from "../../lib/usd/fakePng";
import type { NearRead } from "../sunlight";
import { petRampAt } from "./pet";
import { PET_NODATA } from "./temperatureLayer";
import { temperaturePackage } from "./usd";

const FRAME: ExportFrame = { centre: { lng: 121.5654, lat: 25.033 }, sizeM: 2 };
const NOON = Date.UTC(2026, 5, 21, 4);

test("with no PET result, the export is not ready", async () => {
  await expect(temperaturePackage(null, FRAME)).rejects.toMatchObject({ reason: "not-ready", layer: "temperature" });
});

describe("the PET package", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The export pass's 2 × 2 read over the frame, in PET: three values and one NoData. */
  const read = (values: number[]): NearRead => {
    const { lng, lat } = FRAME.centre;
    const domain = { centre: [lng, lat] as [number, number], origin: lngLatToMercator(lng, lat), metre: metreInMercator(lat), domainM: 2, size: 2 };
    return { tiff: new Blob(["pet"]), grid: { size: 2, values: Float32Array.from(values), nodata: PET_NODATA, domain, sunTime: NOON, metadata: {} } };
  };

  test("textures the PET ramp, NoData transparent, the GeoTIFF beside it, and records its parameters", async () => {
    const png = stubPngEncoder();
    const pkg = await temperaturePackage({ read: read([30, 40, PET_NODATA, 22]), params: { g0: 800, ta: 32, v: 1 } }, FRAME);
    expect(pkg.sidecars.map((s) => s.name)).toEqual(["temperature.tif"]);
    expect(pkg.attribution).toEqual([]);
    const px = png.pixels();
    expect([...px.subarray(0, 4)]).toEqual([...petRampAt(30).map((c) => Math.round(c * 255)), 255]);
    expect(px[2 * 4 + 3]).toBe(0);
    const text = await pkg.usdz.text();
    expect(text).toContain('string values = "temperature.tif"');
    expect(text).toContain(`double noData = ${PET_NODATA}`);
    expect(text).toContain(`string sunTime = "${new Date(NOON).toISOString()}"`);
    expect(text).toContain('string quantity = "physiological equivalent temperature (PET, degC)"');
    expect(text).toContain("double g0 = 800");
    expect(text).toContain("double ta = 32");
    expect(text).toContain("double v = 1");
    expect(text).toContain("(-1, -1, 0.04)");
  });
});
