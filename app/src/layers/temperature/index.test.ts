import { describe, expect, test } from "vitest";
import { createGraph } from "../../lib/dag";
import { LPI_NODE } from "../sunlight";
import {
  DEFAULT_TEMPERATURE_SETTINGS,
  PET_DEPS,
  PET_NODE,
  PET_NODATA,
  TEMPERATURE_NATIVE_LAYER_ID,
  temperatureRecord,
} from "./index";
import { petOf } from "./pet";

describe("temperatureRecord", () => {
  test("is an external-native three.js record, off by default", () => {
    const r = temperatureRecord(DEFAULT_TEMPERATURE_SETTINGS);
    expect(r.visible).toBe(false);
    expect(r.metadata).toMatchObject({
      customLayerType: "threejs",
      nativeLayerIds: [TEMPERATURE_NATIVE_LAYER_ID],
      paintMode: "plugin",
    });
    expect(r.source).toEqual({});
  });

  test("defaults to a clear Taipei summer midday", () => {
    expect(DEFAULT_TEMPERATURE_SETTINGS).toMatchObject({ g0: 800, ta: 32, v: 1, opacity: 0.8 });
  });
});

describe("the DAG edge", () => {
  const graph = () => {
    const g = createGraph();
    g.add(LPI_NODE, []);
    g.add(PET_NODE, PET_DEPS);
    return g;
  };

  test("showing PET makes the direct sun demanded, with its own overlay off", () => {
    const g = graph();
    g.setOwnDemand(PET_NODE, true);
    expect(g.demanded(LPI_NODE)).toBe(true);
    g.setOwnDemand(PET_NODE, false);
    expect(g.demanded(LPI_NODE)).toBe(false);
  });

  test("a new direct-sun result reaches the PET node", () => {
    const g = graph();
    let heard = 0;
    g.subscribe(PET_NODE, (e) => e.kind === "upstream" && e.from === LPI_NODE && heard++);
    g.publish(LPI_NODE, {});
    g.clear(LPI_NODE);
    expect(heard).toBe(2);
  });
});

describe("export NoData", () => {
  test("is below any PET the panel's ranges allow", () => {
    expect(petOf(0, { g0: 0, ta: 15, v: 10 })).toBeGreaterThan(PET_NODATA);
    expect(petOf(0, { g0: 0, ta: 15, v: 10 })).toBeLessThan(-1);
  });
});
