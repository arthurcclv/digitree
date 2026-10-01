import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { crownScale, radialWidthM } from "./crown";

const BASE = { heightM: 10, widthM: 8 };

describe("crownScale", () => {
  test("a surveyed width sets the horizontal, the height the vertical", () => {
    expect(crownScale(BASE, { heightM: 15, widthM: 4 }, 1)).toEqual({ y: 1.5, xz: 0.5 });
  });

  test("an unmeasured tree keeps its form's proportions", () => {
    expect(crownScale(BASE, { heightM: 15, widthM: null }, 1)).toEqual({ y: 1.5, xz: 1.5 });
  });

  test("heightScale exaggerates the vertical only, measured or not", () => {
    expect(crownScale(BASE, { heightM: 15, widthM: 4 }, 2)).toEqual({ y: 3, xz: 0.5 });
    expect(crownScale(BASE, { heightM: 15, widthM: null }, 2)).toEqual({ y: 3, xz: 1.5 });
  });

  test("a width is honoured whatever its ratio to the height: no clamping", () => {
    expect(crownScale(BASE, { heightM: 3, widthM: 40 }, 1)).toEqual({ y: 0.3, xz: 5 });
  });
});

describe("radialWidthM", () => {
  test("is twice the farthest vertex's distance from the vertical axis", () => {
    const g = new THREE.BufferGeometry();
    // The y coordinate is ignored: only the horizontal distance counts.
    g.setAttribute("position", new THREE.Float32BufferAttribute([3, 100, 4, -1, 0, 0, 0, -5, 2], 3));
    expect(radialWidthM([g])).toBeCloseTo(10, 6);
  });

  test("is the same whichever way the shape faces", () => {
    const box = () => new THREE.BoxGeometry(6, 1, 2).translate(1, 0, 0);
    const turned = box().rotateY(1.1);
    expect(radialWidthM([turned])).toBeCloseTo(radialWidthM([box()]), 5);
  });

  test("spans every geometry it is given", () => {
    const a = new THREE.BoxGeometry(2, 1, 2);
    const b = new THREE.BoxGeometry(2, 1, 2).translate(5, 0, 0);
    expect(radialWidthM([a, b])).toBeGreaterThan(radialWidthM([a]));
  });
});
