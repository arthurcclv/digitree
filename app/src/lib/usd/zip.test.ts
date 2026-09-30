import { describe, expect, test } from "vitest";
import { crc32, zip } from "./zip";
import { usdz, USDZ_ALIGN } from "./usdz";

/** A reader for what `zip` writes: the central directory, then each local entry. */
function read(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const dec = new TextDecoder();
  const entries: { name: string; method: number; crc: number; dataOffset: number; data: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const local = v.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    const dataOffset = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    entries.push({ name, method, crc, dataOffset, data: bytes.subarray(dataOffset, dataOffset + size) });
    at += 46 + nameLen;
  }
  return entries;
}

test("crc32 matches the standard check value", () => {
  expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
});

describe("zip", () => {
  const a = new TextEncoder().encode("hello");
  const b = new Uint8Array(1000).map((_, i) => i % 251);

  test("stores every entry, and reads back byte for byte", () => {
    const entries = read(zip([{ name: "a.txt", data: a }, { name: "dir/b.bin", data: b }]));
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "dir/b.bin"]);
    for (const e of entries) expect(e.method).toBe(0);
    expect(entries[0].data).toEqual(a);
    expect(entries[1].data).toEqual(b);
    for (const e of entries) expect(e.crc).toBe(crc32(e.data));
  });

  test("aligns every entry's data when asked", () => {
    for (const name of ["x", "abc.png", "a-much-longer-name.usda"]) {
      const entries = read(zip([{ name, data: a }, { name: `2${name}`, data: b }, { name: `3${name}`, data: a }], 64));
      for (const e of entries) expect(e.dataOffset % 64).toBe(0);
    }
  });

  test("is deterministic, and refuses a duplicate name", () => {
    expect(zip([{ name: "a", data: a }])).toEqual(zip([{ name: "a", data: a }]));
    expect(() => zip([{ name: "a", data: a }, { name: "a", data: b }])).toThrow();
  });
});

describe("usdz", () => {
  test("puts the root layer first, stored and 64-byte aligned", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const entries = read(usdz("trees.usda", "#usda 1.0\n", [{ name: "textures/leaf.png", data: png }]));
    expect(entries.map((e) => e.name)).toEqual(["trees.usda", "textures/leaf.png"]);
    for (const e of entries) {
      expect(e.method).toBe(0);
      expect(e.dataOffset % USDZ_ALIGN).toBe(0);
    }
  });

  test("allows only what this app writes", () => {
    expect(() => usdz("a.usda", "", [{ name: "leaf.webp", data: new Uint8Array() }])).toThrow();
    expect(() => usdz("a.tif", "")).toThrow();
  });
});
