import { describe, expect, test } from "vitest";
import { asset, dict, identifier, layer, num, prop, str, tuples } from "./usda";

describe("num", () => {
  test("trims trailing zeros, rounds to its digits, never prints -0", () => {
    expect(num(1)).toBe("1");
    expect(num(1.5)).toBe("1.5");
    expect(num(0.1234567)).toBe("0.123457");
    expect(num(-0.0000001)).toBe("0");
    expect(num(2.5, 0)).toBe("3");
  });

  test("refuses what USD cannot read", () => {
    expect(() => num(NaN)).toThrow();
    expect(() => num(Infinity)).toThrow();
  });
});

describe("strings and assets", () => {
  test("escape quotes, backslashes and newlines, and keep unicode", () => {
    expect(str('a "b"\\c\nd')).toBe('"a \\"b\\"\\\\c\\nd"');
    expect(str("榕樹")).toBe('"榕樹"');
  });

  test("an asset path cannot hold its own delimiter", () => {
    expect(asset("./a.usdz")).toBe("@./a.usdz@");
    expect(() => asset("a@b")).toThrow();
  });
});

test("tuples split a flat list", () => {
  expect(tuples([1, 2, 3, 4, 5, 6], 3)).toBe("[(1, 2, 3), (4, 5, 6)]");
  expect(() => tuples([1, 2], 3)).toThrow();
});

test("a primvar carries its interpolation as metadata", () => {
  expect(prop("color3f[]", "primvars:displayColor", "[(1, 0, 0)]", { interpolation: "constant" })).toBe(
    'color3f[] primvars:displayColor = [(1, 0, 0)] (\n    interpolation = "constant"\n)',
  );
  expect(prop("token", "subdivisionScheme", '"none"', { uniform: true })).toBe('uniform token subdivisionScheme = "none"');
});

test("dictionaries sort their keys and type their values", () => {
  expect(dict({ b: "x", a: 1.5, c: ["p", "q"], d: { asset: "./v.tif" }, e: { z: true } })).toBe(
    [
      "{",
      "    double a = 1.5",
      '    string b = "x"',
      '    string[] c = ["p", "q"]',
      "    asset d = @./v.tif@",
      "    dictionary e = {",
      "        bool z = 1",
      "    }",
      "}",
    ].join("\n"),
  );
});

test("a layer prints its metadata, then its prims, nested", () => {
  const text = layer({ defaultPrim: "World", upAxis: "Z", metersPerUnit: 1 }, [
    {
      type: "Xform",
      name: "World",
      children: [
        { type: "", name: "A", meta: ["prepend references = @./a.usdz@"] },
        { type: "Mesh", name: "B", props: ['uniform token subdivisionScheme = "none"'] },
      ],
    },
  ]);
  expect(text).toBe(
    [
      "#usda 1.0",
      "(",
      '    defaultPrim = "World"',
      "    metersPerUnit = 1",
      '    upAxis = "Z"',
      ")",
      "",
      'def Xform "World"',
      "{",
      '    def "A" (',
      "        prepend references = @./a.usdz@",
      "    )",
      "    {",
      "    }",
      "",
      '    def Mesh "B"',
      "    {",
      '        uniform token subdivisionScheme = "none"',
      "    }",
      "}",
      "",
    ].join("\n"),
  );
});

test("identifiers are made safe for prim names", () => {
  expect(identifier("date_palm")).toBe("date_palm");
  expect(identifier("9 lives")).toBe("_9_lives");
  expect(identifier("樹")).toBe("_");
});
