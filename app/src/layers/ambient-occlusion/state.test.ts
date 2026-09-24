import { describe, expect, test } from "vitest";
import { AO_MIN_ZOOM, aoState } from "./state";

describe("aoState", () => {
  const ok = { visible: true, supported: true, zoom: 16 };

  test("ready when visible, supported and zoomed in", () => {
    expect(aoState(ok)).toBe("ready");
    expect(aoState({ ...ok, zoom: AO_MIN_ZOOM })).toBe("ready");
  });

  test("blocked in order: off, unsupported, zoom", () => {
    expect(aoState({ visible: false, supported: false, zoom: 10 })).toBe("off");
    expect(aoState({ ...ok, supported: false, zoom: 10 })).toBe("unsupported");
    expect(aoState({ ...ok, zoom: AO_MIN_ZOOM - 0.01 })).toBe("zoom");
  });
});
