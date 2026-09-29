import { describe, expect, test } from "vitest";
import { MIN_SUN_ELEVATION_DEG } from "./sun";
import { blockedState, lpiNodeAction, readoutSun, SUNLIGHT_MIN_ZOOM } from "./state";

const open = { visible: true, supported: true, zoom: 16, elevationDeg: 45 };

describe("blockedState", () => {
  test("lets a visible layer with a high sun work", () => {
    expect(blockedState(open)).toBeNull();
    expect(blockedState({ ...open, zoom: SUNLIGHT_MIN_ZOOM, elevationDeg: MIN_SUN_ELEVATION_DEG })).toBeNull();
  });

  test("blocks below the minimum sun, so nothing is planned or fetched", () => {
    expect(blockedState({ ...open, elevationDeg: MIN_SUN_ELEVATION_DEG - 0.01 })).toBe("low-sun");
    expect(blockedState({ ...open, elevationDeg: -20 })).toBe("low-sun");
  });

  test("blocks below the minimum zoom", () => {
    expect(blockedState({ ...open, zoom: SUNLIGHT_MIN_ZOOM - 0.01 })).toBe("zoom");
  });

  test("reports the first reason, in the order off, unsupported, zoom, low sun", () => {
    const none = { visible: false, supported: false, zoom: 0, elevationDeg: -90 };
    expect(blockedState(none)).toBe("off");
    expect(blockedState({ ...none, visible: true })).toBe("unsupported");
    expect(blockedState({ ...none, visible: true, supported: true })).toBe("zoom");
    expect(blockedState({ ...none, visible: true, supported: true, zoom: 16 })).toBe("low-sun");
  });
});

describe("readoutSun", () => {
  const drawn = { azimuthDeg: 120, elevationDeg: 30 };
  const now = { azimuthDeg: 250, elevationDeg: 4 };

  test("shows the drawn result's sun while ready, even as the set time moves on", () => {
    expect(readoutSun("ready", drawn, now)).toBe(drawn);
  });

  test("shows the sun actually set otherwise, so low sun reads low", () => {
    expect(readoutSun("low-sun", drawn, now)).toBe(now);
    expect(readoutSun("waiting", drawn, now)).toBe(now);
    expect(readoutSun("ready", null, now)).toBe(now);
  });
});

describe("lpiNodeAction", () => {
  test("publishes once per pass that reaches ready", () => {
    expect(lpiNodeAction("waiting", "ready", true)).toBe("publish");
    expect(lpiNodeAction("ready", "ready", true)).toBe("publish");
    // A status refresh without a pass is not a new result.
    expect(lpiNodeAction("ready", "ready", false)).toBeNull();
  });

  test("clears once on leaving ready, and not again", () => {
    for (const next of ["off", "zoom", "low-sun", "unsupported", "waiting"] as const) {
      expect(lpiNodeAction("ready", next, false)).toBe("clear");
      expect(lpiNodeAction(next, next, false)).toBeNull();
    }
  });
});
