import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "vite";
import { describe, expect, test } from "vitest";
import { fileProxy, tileProxy } from "./proxy";

// See `specs/proxy.md`, *Invariants*.

const targetOf = (value: string | undefined) => tileProxy({ TILES_PROXY_TARGET: value }).target;

describe("tileProxy", () => {
  test("defaults to Martin on localhost:3000 when unset or empty", () => {
    expect(tileProxy({}).target).toBe("http://localhost:3000");
    expect(targetOf(undefined)).toBe("http://localhost:3000");
    expect(targetOf("")).toBe("http://localhost:3000");
    expect(targetOf("  ")).toBe("http://localhost:3000");
  });

  test("uses a valid origin as given, minus a trailing slash", () => {
    expect(targetOf("http://localhost:3001")).toBe("http://localhost:3001");
    expect(targetOf("http://martin:3000/")).toBe("http://martin:3000");
    expect(targetOf("https://tiles.example.org")).toBe("https://tiles.example.org");
  });

  test.each(["ftp://x", "localhost:3000", "http://h/tiles", "http://h?x=1", "http://h#x", "not a url"])(
    "rejects %s, naming the setting",
    (value) => {
      expect(() => targetOf(value)).toThrow(/TILES_PROXY_TARGET/);
      expect(() => targetOf(value)).toThrow(JSON.stringify(value));
    },
  );

  test("strips the /tiles prefix and nothing else", () => {
    const { rewrite } = tileProxy({});
    expect(rewrite?.("/tiles/trees/15/1/2")).toBe("/trees/15/1/2");
    expect(rewrite?.("/trees/15/1/2")).toBe("/trees/15/1/2");
  });

  test("rewrites the Host header to the target's", () => {
    expect(tileProxy({}).changeOrigin).toBe(true);
  });
});

describe("fileProxy", () => {
  const filesTargetOf = (value: string | undefined) => fileProxy({ FILES_PROXY_TARGET: value }).target;

  test("defaults to the files service on localhost:3080 when unset or empty", () => {
    expect(fileProxy({}).target).toBe("http://localhost:3080");
    expect(filesTargetOf("")).toBe("http://localhost:3080");
  });

  test("uses a valid origin as given, minus a trailing slash", () => {
    expect(filesTargetOf("http://localhost:3081/")).toBe("http://localhost:3081");
  });

  test.each(["ftp://x", "localhost:3080", "http://h/files", "http://h?x=1", "not a url"])(
    "rejects %s, naming the setting",
    (value) => {
      expect(() => filesTargetOf(value)).toThrow(/FILES_PROXY_TARGET/);
    },
  );

  test("strips the /files prefix and nothing else", () => {
    const { rewrite } = fileProxy({});
    expect(rewrite?.("/files/3dgs/a.spz")).toBe("/3dgs/a.spz");
    expect(rewrite?.("/filesystem/x")).toBe("/filesystem/x");
  });

  test("is independent of the tiles setting", () => {
    expect(fileProxy({ TILES_PROXY_TARGET: "http://localhost:9999" }).target).toBe("http://localhost:3080");
    expect(fileProxy({}).changeOrigin).toBe(true);
  });
});

// Spark reads a paged .rad one chunk at a time with HTTP byte ranges, so the
// /files proxy must pass `Range` through and the 206 back. Through a real Vite
// server and its proxy, to a stand-in for the files service.
describe("fileProxy, end to end", () => {
  test("passes a Range request through and its 206 back", async () => {
    const target = createHttpServer((req, res) => {
      res.writeHead(206, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: req.url, range: req.headers.range ?? null }));
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const port = (target.address() as AddressInfo).port;
    const vite = await createServer({
      configFile: false,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, proxy: { "/files": fileProxy({ FILES_PROXY_TARGET: `http://127.0.0.1:${port}` }) } },
    });
    try {
      await vite.listen();
      const { port: vitePort } = vite.httpServer!.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${vitePort}/files/3dgs-lod/a-lod.rad`, { headers: { Range: "bytes=8-15" } });
      expect(res.status).toBe(206);
      expect(await res.json()).toEqual({ url: "/3dgs-lod/a-lod.rad", range: "bytes=8-15" });
    } finally {
      await vite.close();
      target.close();
    }
  });
});
