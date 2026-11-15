import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, memoryFs, NOW, testIo } from "./lens.test-support.ts";
import {
  argValue,
  dig,
  field,
  LENS_ROOT_DIR,
  logLine,
  messageOf,
  mwbStateDir,
  nodeLensFs,
  nodeLensIo,
  pool,
  readJsonOrNull,
  runIfMain,
  screenerRows,
  sleepMs,
  symbolsOf,
  writeAtomic,
  yahooSymbol,
} from "./lens-io.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("nodeLensFs", () => {
  it("reads, writes, lists, renames and removes real files", async () => {
    const root = await mkdtemp(join(tmpdir(), "lens-io-"));
    try {
      const dir = join(root, "a", "b");
      await nodeLensFs.mkdir(dir);
      await nodeLensFs.writeFile(join(dir, "x.json.tmp"), "{}");
      await nodeLensFs.rename(join(dir, "x.json.tmp"), join(dir, "x.json"));
      expect(nodeLensFs.exists(join(dir, "x.json"))).toBe(true);
      expect(await nodeLensFs.readFile(join(dir, "x.json"))).toBe("{}");
      expect(await nodeLensFs.readdir(dir)).toEqual(["x.json"]);
      await nodeLensFs.rm(join(root, "a"));
      expect(nodeLensFs.exists(dir)).toBe(false);
      await nodeLensFs.rm(join(root, "missing"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("nodeLensIo", () => {
  it("binds the process, the clock, sleep and the global fetch", async () => {
    const fetch = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    const io = nodeLensIo();
    expect(io.argv).toBe(process.argv);
    expect(io.env).toBe(process.env);
    expect(io.rootDir).toBe(LENS_ROOT_DIR);
    expect(io.now()).toBeInstanceOf(Date);
    await io.sleep(0);
    const response = await io.fetch("https://example.test/x", {});
    expect(await response.json()).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith("https://example.test/x", {});
  });

  it("puts the root two levels above scripts/research-lenses", async () => {
    await expect(
      readFile(
        join(LENS_ROOT_DIR, "scripts/research-lenses/lens-io.ts"),
        "utf8"
      )
    ).resolves.toContain("LENS_ROOT_DIR");
  });

  it("sleeps for the given time", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const sleeping = sleepMs(50).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(49);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await sleeping;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runIfMain", () => {
  it("does nothing when the module is imported", async () => {
    const run = vi.fn(async () => 0);
    await runIfMain({ main: false, url: "file:///x.ts" }, run);
    await runIfMain({ url: "file:///x.ts" }, run);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs with the given IO and sets the exit code", async () => {
    const { io } = testIo();
    const codes: number[] = [];
    await runIfMain(
      { main: true, url: "file:///x.ts" },
      async (given) => (given === io ? 3 : 9),
      () => io,
      (code) => codes.push(code)
    );
    expect(codes).toEqual([3]);
  });

  it("defaults to process IO and process.exitCode", async () => {
    const previous = process.exitCode;
    try {
      await runIfMain({ main: true, url: "file:///x.ts" }, async (io) =>
        io.argv === process.argv ? 0 : 5
      );
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previous;
    }
  });
});

describe("helpers", () => {
  it("reads --name value like vertex-research, with a default for a bare flag", () => {
    const argv = ["bun", "job.ts", "--out", "x", "--limit"];
    expect(argValue(argv, "--out", "d")).toBe("x");
    expect(argValue(argv, "--limit", "0")).toBe("0");
    expect(argValue(argv, "--missing", "d")).toBe("d");
    // Index 0 is the runtime, never a flag.
    expect(argValue(["--out", "y"], "--out", "d")).toBe("d");
  });

  it("logs one time-stamped line", () => {
    const { io, stderr } = testIo();
    logLine(io, "a", 1);
    expect(stderr).toEqual([`${NOW.toISOString()} a 1\n`]);
  });

  it("names errors", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
    expect(messageOf("plain")).toBe("plain");
  });

  it("writes atomically and reads JSON or null", async () => {
    const { fs, files } = memoryFs({ "/d/bad.json": "{" });
    await writeAtomic(fs, "/d/x/out.json", '{"a":1}');
    expect(files.get("/d/x/out.json")).toBe('{"a":1}');
    expect(files.has("/d/x/out.json.tmp")).toBe(false);
    expect(await readJsonOrNull(fs, "/d/x/out.json")).toEqual({ a: 1 });
    expect(await readJsonOrNull(fs, "/d/bad.json")).toBeNull();
    expect(await readJsonOrNull(fs, "/d/none.json")).toBeNull();
  });

  it("walks untrusted JSON", () => {
    const value = { a: [{ b: 2 }] };
    expect(field(value, "a")).toEqual([{ b: 2 }]);
    expect(field(null, "a")).toBeUndefined();
    expect(field("text", "length")).toBeUndefined();
    expect(dig(value, "a", 0, "b")).toBe(2);
    expect(dig(value, "a", 1, "b")).toBeUndefined();
  });

  it("reads tickers from arrays of strings or {symbol}, or object keys", () => {
    expect(symbolsOf(undefined)).toEqual([]);
    expect(
      symbolsOf(["AAA", { symbol: "BBB" }, { other: 1 }, null, ""])
    ).toEqual(["AAA", "BBB"]);
    expect(symbolsOf({ CCC: {}, DDD: {} })).toEqual(["CCC", "DDD"]);
  });

  it("finds the market-watch-bot state directory", () => {
    expect(mwbStateDir(testIo().io)).toBe("/state");
    expect(mwbStateDir(testIo({ env: {} }).io)).toBe(
      "/home/test/Github/trading/market-watch-bot/state"
    );
    expect(mwbStateDir(testIo({ env: { MWB_STATE_DIR: "" } }).io)).toBe(
      "/home/test/Github/trading/market-watch-bot/state"
    );
  });

  it("runs a bounded worker pool and reports completions", async () => {
    const seen: number[] = [];
    const done: number[] = [];
    let active = 0;
    let peak = 0;
    await pool(
      [1, 2, 3, 4, 5],
      2,
      async (item) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        seen.push(item);
        active -= 1;
      },
      (count) => done.push(count)
    );
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(done).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("maps Nasdaq screener rows and refuses a short download", () => {
    const rows = Array.from({ length: 1000 }, (_, i) =>
      i === 0
        ? {
            industry: "Semis",
            lastsale: "$1,234.50",
            marketCap: "5000000000",
            name: "Alpha",
            sector: "Tech",
            symbol: " abc ",
            volume: "1200",
          }
        : {
            lastsale: "NA",
            marketCap: "",
            name: 7,
            symbol: `S${i}`,
            volume: "x",
          }
    );
    const mapped = screenerRows({ data: { rows } });
    expect(mapped[0]).toEqual({
      industry: "Semis",
      marketCap: 5e9,
      name: "Alpha",
      price: 1234.5,
      sector: "Tech",
      symbol: "ABC",
      volume: 1200,
    });
    expect(mapped[1]).toEqual({
      industry: null,
      marketCap: null,
      name: undefined,
      price: 0,
      sector: null,
      symbol: "S1",
      volume: 0,
    });
    expect(() => screenerRows({ data: { rows: rows.slice(1) } })).toThrow(
      "Nasdaq screener returned too few rows"
    );
    expect(() => screenerRows(null)).toThrow("too few rows");
  });

  it("maps class tickers to Yahoo symbols", () => {
    expect(yahooSymbol("BRK.B")).toBe("BRK-B");
    expect(yahooSymbol("BF/B")).toBe("BF-B");
    expect(yahooSymbol("AAPL")).toBe("AAPL");
  });
});

describe("test doubles", () => {
  it("answers 404 when a test gives no fetch", async () => {
    const { io, requests } = testIo();
    expect((await io.fetch("https://x.test/a", {})).status).toBe(404);
    expect(requests).toEqual(["https://x.test/a"]);
  });

  it("memoryFs lists children, removes trees and reports missing directories", async () => {
    const { fs, files } = memoryFs({ "/c/2026-11-09/A.json": "[]" });
    await fs.mkdir("/c/2026-11-10");
    expect((await fs.readdir("/c")).sort()).toEqual([
      "2026-11-09",
      "2026-11-10",
    ]);
    await fs.mkdir("/empty");
    expect(await fs.readdir("/empty")).toEqual([]);
    await fs.rm("/c/2026-11-09");
    expect(files.size).toBe(0);
    await expect(fs.readdir("/none")).rejects.toThrow("ENOENT");
  });
});
