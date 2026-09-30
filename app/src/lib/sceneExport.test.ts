import { describe, expect, test } from "vitest";
import { sceneExportReady, sceneParticipants, SCENE_STACK } from "./sceneExport";

const none = { buildings: false, sunlight: false, temperature: false, treeMeshes: false };

describe("sceneParticipants", () => {
  test("always has the basemap and the light", () => {
    expect(sceneParticipants(none)).toEqual(["basemap", "light"]);
  });

  test("has everything in stack order when everything is shown", () => {
    expect(sceneParticipants({ buildings: true, sunlight: true, temperature: true, treeMeshes: true })).toEqual([
      "basemap",
      "buildings",
      "sunlight",
      "temperature",
      "trees",
      "light",
    ]);
    expect(SCENE_STACK).toEqual(["basemap", "buildings", "sunlight", "temperature", "trees", "light"]);
  });

  test("each flag adds only its own layer", () => {
    expect(sceneParticipants({ ...none, buildings: true })).toEqual(["basemap", "buildings", "light"]);
    expect(sceneParticipants({ ...none, sunlight: true })).toEqual(["basemap", "sunlight", "light"]);
    expect(sceneParticipants({ ...none, temperature: true })).toEqual(["basemap", "temperature", "light"]);
    expect(sceneParticipants({ ...none, treeMeshes: true })).toEqual(["basemap", "trees", "light"]);
  });
});

describe("sceneExportReady", () => {
  const hidden = { visible: false, state: "off" };
  test("waits for the map", () => {
    expect(sceneExportReady(false, [hidden, hidden])).toBe(false);
    expect(sceneExportReady(true, [hidden, hidden])).toBe(true);
  });

  test("waits for each visible overlay to be ready, and ignores hidden ones", () => {
    expect(sceneExportReady(true, [{ visible: true, state: "computing" }, hidden])).toBe(false);
    expect(sceneExportReady(true, [{ visible: true, state: "ready" }, { visible: true, state: "waiting" }])).toBe(false);
    expect(sceneExportReady(true, [{ visible: true, state: "ready" }, { visible: true, state: "ready" }])).toBe(true);
    expect(sceneExportReady(true, [{ visible: false, state: "computing" }])).toBe(true);
  });
});
