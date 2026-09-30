import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExportFrame } from "../../lib/usd";
import { stubPngEncoder } from "../../lib/usd/fakePng";
import { makeDomain } from "./frame";
import type { NearRead } from "./lpi";
import { sunlightRampAt } from "./ramp";
import { sunPosition } from "./sun";
import { lightPackage, sunlightPackage } from "./usd";

const FRAME: ExportFrame = { centre: { lng: 121.5654, lat: 25.033 }, sizeM: 2000 };
const NOON = Date.UTC(2026, 5, 21, 4); // 12:00 at UTC+8
const MIDNIGHT = Date.UTC(2026, 5, 21, 16);

describe("the light package", () => {
  test("is one DomeLight at /Light/Dome, intensity 1000", async () => {
    const pkg = lightPackage(FRAME, NOON);
    expect(pkg.name).toBe("light");
    expect(pkg.prim).toBe("Light");
    const text = await pkg.usdz.text();
    expect(text).toContain('defaultPrim = "Light"');
    expect(text).toContain('def Xform "Light"');
    expect(text).toContain('def DomeLight "Dome"');
    expect(text).toContain("float inputs:intensity = 1000");
    expect(text).not.toMatch(/DistantLight|xformOp:orient/);
  });

  test("records the set sun as metadata", async () => {
    const text = await lightPackage(FRAME, NOON).usdz.text();
    const { azimuthDeg } = sunPosition(new Date(NOON), FRAME.centre.lng, FRAME.centre.lat);
    expect(text).toContain(`string sunTime = "${new Date(NOON).toISOString()}"`);
    expect(text).toContain(`double azimuthDeg = ${azimuthDeg.toFixed(9).replace(/\.?0+$/, "")}`);
  });

  test("is written at night too", async () => {
    expect(sunPosition(new Date(MIDNIGHT), FRAME.centre.lng, FRAME.centre.lat).elevationDeg).toBeLessThan(0);
    expect(await lightPackage(FRAME, MIDNIGHT).usdz.text()).toContain('def DomeLight "Dome"');
  });
});

/** An export pass's 2 × 2 read over a 2 m frame: three values and one NoData. */
function fakeRead(frame: ExportFrame, values: number[], nodata: number, sunTime: number): NearRead {
  const domain = makeDomain(frame.centre.lng, frame.centre.lat, 2, frame.sizeM);
  return {
    tiff: new Blob(["tif"]),
    grid: { size: 2, values: Float32Array.from(values), nodata, domain, sunTime, metadata: {} },
  };
}

describe("the direct-sun package", () => {
  let png: ReturnType<typeof stubPngEncoder>;
  beforeEach(() => (png = stubPngEncoder()));
  afterEach(() => vi.unstubAllGlobals());
  const frame: ExportFrame = { ...FRAME, sizeM: 2 };

  test("textures the ramp, NoData transparent, and writes the GeoTIFF beside the package", async () => {
    const pkg = await sunlightPackage(fakeRead(frame, [1, 0.5, -1, 0], -1, NOON), frame, ["© trees", "© buildings"]);
    expect(pkg.sidecars.map((s) => s.name)).toEqual(["sunlight.tif"]);
    expect(await pkg.sidecars[0].blob.text()).toBe("tif");
    expect(pkg.attribution).toEqual(["© trees", "© buildings"]);
    expect(pkg.sunTime).toBe(NOON);
    const px = png.pixels();
    expect([...px.subarray(0, 4)]).toEqual([...sunlightRampAt(1).map((c) => Math.round(c * 255)), 255]);
    expect(px[2 * 4 + 3]).toBe(0);
    const text = await pkg.usdz.text();
    expect(text).toContain("textures/sunlight.png");
    expect(text).toContain('string values = "sunlight.tif"');
    expect(text).toContain("double noData = -1");
    expect(text).toContain(`string sunTime = "${new Date(NOON).toISOString()}"`);
    expect(text).toContain('string quantity = "direct-sun transmittance (index, 0-1)"');
    expect(text).toContain('string[] attribution = ["© trees", "© buildings"]');
    expect(text).toContain("(-1, -1, 0.02)");
  });

  test("rejects a grid not centred on the frame as failed", async () => {
    const off: ExportFrame = { centre: { lng: frame.centre.lng + 0.001, lat: frame.centre.lat }, sizeM: 2 };
    await expect(sunlightPackage(fakeRead(frame, [0, 0, 0, 0], -1, NOON), off, [])).rejects.toMatchObject({
      reason: "failed",
      layer: "sunlight",
    });
  });
});
