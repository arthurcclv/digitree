import { describe, expect, test } from "vitest";
import { createGraph, type GraphEvent } from "./graph";

/** a → b → d, a → c → d: a diamond. */
function diamond() {
  const g = createGraph();
  g.add("a", []);
  g.add("b", ["a"]);
  g.add("c", ["a"]);
  g.add("d", ["b", "c"]);
  return g;
}

function record(g: ReturnType<typeof createGraph>, ids: string[]) {
  const log: [string, GraphEvent][] = [];
  for (const id of ids) g.subscribe(id, (e) => log.push([id, e]));
  return log;
}

describe("add", () => {
  test("rejects a duplicate id, an unknown dep and a cycle", () => {
    const g = createGraph();
    g.add("a", []);
    expect(() => g.add("a", [])).toThrow(/already exists/);
    expect(() => g.add("b", ["nope"])).toThrow(/unknown/);
    expect(() => g.add("self", ["self"])).toThrow(/cycle/);
  });
});

describe("publish and clear", () => {
  test("publish notifies each transitive dependent once, in topological order", () => {
    const g = diamond();
    const log = record(g, ["a", "b", "c", "d"]);
    g.publish("a", 1);
    expect(log.map(([id]) => id)).toEqual(["b", "c", "d"]);
    expect(log.every(([, e]) => e.kind === "upstream" && e.from === "a")).toBe(true);
  });

  test("publish bumps only the published node's version", () => {
    const g = diamond();
    g.publish("b", "x");
    expect(g.version("b")).toBe(1);
    expect(["a", "c", "d"].map((id) => g.version(id))).toEqual([0, 0, 0]);
    expect(g.value("b")).toBe("x");
  });

  test("clear notifies as publish does and leaves the value null", () => {
    const g = diamond();
    g.publish("a", 1);
    const log = record(g, ["b", "c", "d"]);
    g.clear("a");
    expect(g.value("a")).toBeNull();
    expect(g.version("a")).toBe(2);
    expect(log.map(([id]) => id)).toEqual(["b", "c", "d"]);
  });

  test("publish from inside a listener throws", () => {
    const g = diamond();
    g.subscribe("b", () => g.publish("b", 2));
    expect(() => g.publish("a", 1)).toThrow(/inside a notification/);
  });
});

describe("demand", () => {
  test("own demand makes a node and everything upstream of it demanded", () => {
    const g = diamond();
    g.setOwnDemand("b", true);
    expect(["a", "b", "c", "d"].map((id) => g.demanded(id))).toEqual([true, true, false, false]);
  });

  test("releasing downstream demand releases upstream, unless held otherwise", () => {
    const g = diamond();
    g.setOwnDemand("d", true);
    g.setOwnDemand("c", true);
    g.setOwnDemand("d", false);
    // a is still wanted through c; b was wanted only through d.
    expect(["a", "b", "c", "d"].map((id) => g.demanded(id))).toEqual([true, false, true, false]);
    g.setOwnDemand("c", false);
    g.setOwnDemand("a", true);
    g.setOwnDemand("a", true);
    expect(["a", "b", "c", "d"].map((id) => g.demanded(id))).toEqual([true, false, false, false]);
  });

  test("a demand listener fires only when demand actually changes", () => {
    const g = diamond();
    const log = record(g, ["a"]);
    g.setOwnDemand("d", true);
    g.setOwnDemand("b", true); // a already demanded
    g.setOwnDemand("d", false); // still held by b
    g.setOwnDemand("b", false);
    expect(log.map(([, e]) => e)).toEqual([
      { kind: "demand", demanded: true },
      { kind: "demand", demanded: false },
    ]);
  });

  test("unsubscribe stops notifications", () => {
    const g = diamond();
    const seen: GraphEvent[] = [];
    const off = g.subscribe("b", (e) => seen.push(e));
    off();
    g.publish("a", 1);
    expect(seen).toEqual([]);
  });
});

describe("state", () => {
  test("a new node is off", () => {
    expect(diamond().state("a")).toBe("off");
  });

  test("a change notifies each transitive dependent once and leaves the version", () => {
    const g = diamond();
    const log = record(g, ["a", "b", "c", "d"]);
    g.setState("a", "waiting");
    expect(g.state("a")).toBe("waiting");
    expect(log.map(([id]) => id)).toEqual(["b", "c", "d"]);
    expect(log.every(([, e]) => e.kind === "upstream" && e.from === "a")).toBe(true);
    expect(g.version("a")).toBe(0);
  });

  test("an unchanged state notifies nothing", () => {
    const g = diamond();
    g.setState("a", "zoom");
    const log = record(g, ["b", "c", "d"]);
    g.setState("a", "zoom");
    expect(log).toEqual([]);
  });

  test("is allowed inside a notification", () => {
    const g = diamond();
    g.subscribe("a", (e) => {
      if (e.kind === "demand") g.setState("a", e.demanded ? "waiting" : "off");
    });
    const log = record(g, ["b"]);
    g.setOwnDemand("d", true);
    expect(g.state("a")).toBe("waiting");
    expect(log.filter(([, e]) => e.kind === "upstream")).toEqual([["b", { kind: "upstream", from: "a" }]]);
  });
});
