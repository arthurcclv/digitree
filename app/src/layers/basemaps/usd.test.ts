import { expect, test } from "vitest";
import { mercatorBounds } from "../../lib/usd";
import { BASEMAP_PX_PER_M, captureView, groundFrame, hideForCapture } from "./usd";

test("the capture's zoom fits the frame's square to the canvas exactly", () => {
  const frame = { centre: { lng: 121.5654, lat: 25.033 }, sizeM: 2048 };
  const view = captureView(frame, 16384);
  expect(view.px).toBe(2048 * BASEMAP_PX_PER_M);
  // A 10 km square is capped at MapLibre's canvas limit, whatever the GPU says.
  expect(captureView({ ...frame, sizeM: 10_000 }, 16384).px).toBe(4096);
  const b = mercatorBounds(frame);
  // The world is 512 · 2^zoom pixels across; the square must span the canvas.
  expect(512 * 2 ** view.zoom * (b.maxX - b.minX)).toBeCloseTo(view.px, 6);
  expect(view.center).toEqual([121.5654, 25.033]);
});

test("the canvas is capped at the GPU's texture size", () => {
  const view = captureView({ centre: { lng: 121.5654, lat: 25.033 }, sizeM: 4096 }, 4096);
  expect(view.px).toBe(4096);
});

test("the ground square grows to the buildings' extent, never below the frame, around the same centre", () => {
  const frame = { centre: { lng: 121.5654, lat: 25.033 }, sizeM: 2048 };
  expect(groundFrame(frame)).toEqual(frame);
  expect(groundFrame(frame, 900)).toEqual(frame);
  expect(groundFrame(frame, 1100.5)).toEqual({ centre: frame.centre, sizeM: 2201 });
});

test("the capture hides the style's labels, and asks for its buildings to be hidden", () => {
  const hidden: string[] = [];
  const map = {
    getStyle: () => ({
      layers: [
        { id: "water", type: "fill" },
        { id: "place-label", type: "symbol" },
        { id: "road-name", type: "symbol" },
      ],
    }),
    setLayoutProperty: (id: string, name: string, value: unknown) => {
      if (name === "visibility" && value === "none") hidden.push(id);
    },
  };
  let asked = false;
  hideForCapture(map, (m) => {
    asked = m === map;
  });
  expect(asked).toBe(true);
  expect(hidden).toEqual(["place-label", "road-name"]);
});
