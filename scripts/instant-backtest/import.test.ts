import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runMarketBarsImport } from "./import.ts";

const fakes = vi.hoisted(() => {
  const replaceSeries = vi.fn(
    async (
      series: { symbol: string; timeframe: string },
      bars: { t: number }[]
    ) => ({
      id: `${series.symbol}:${series.timeframe}`,
      barCount: bars.length,
      firstT: bars[0]?.t,
      lastT: bars.at(-1)?.t,
    })
  );
  const close = vi.fn(async () => undefined);
  return {
    replaceSeries,
    close,
    createNodeDatabase: vi.fn(() => ({ db: { fake: true }, close })),
    createMarketBarsRepository: vi.fn(() => ({ replaceSeries })),
  };
});

vi.mock("@darkfactory/db/server", () => ({
  createNodeDatabase: fakes.createNodeDatabase,
  createMarketBarsRepository: fakes.createMarketBarsRepository,
}));

const BARS = "t,o,h,l,c,v\n1000,10,11,9,10.5,100\n2000,10.5,12,10,11,\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const manifest = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    symbol: "SPY",
    timeframe: "1d",
    source: "Test source",
    sourceSha256: "c".repeat(64),
    normalizedSha256: sha(BARS),
    ...overrides,
  });

let directory = "";
let out: string[] = [];
let err: string[] = [];

const write = (name: string, text: string) => {
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
};

const runScript = async (
  args: string[],
  databaseUrl: string | null = "postgresql://test"
) =>
  await runMarketBarsImport(args, {
    env: databaseUrl === null ? {} : { DATABASE_URL: databaseUrl },
    stdout: { write: (text: string) => out.push(text) > 0 },
    stderr: { write: (text: string) => err.push(text) > 0 },
  });

const errorText = () => err.join("");

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "market-bars-import-"));
  out = [];
  err = [];
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe("runMarketBarsImport", () => {
  it("replaces the series named in the manifest and closes the pool", async () => {
    const code = await runScript([
      write("bars.csv", BARS),
      write("m.json", manifest()),
    ]);
    expect(code).toBe(0);
    expect(fakes.createNodeDatabase).toHaveBeenCalledWith({
      connectionString: "postgresql://test",
    });
    expect(fakes.replaceSeries).toHaveBeenCalledWith(
      {
        symbol: "SPY",
        timeframe: "1d",
        source: "Test source",
        sourceSha256: "c".repeat(64),
      },
      [
        { t: 1000, o: 10, h: 11, l: 9, c: 10.5, v: 100 },
        { t: 2000, o: 10.5, h: 12, l: 10, c: 11, v: null },
      ]
    );
    expect(fakes.close).toHaveBeenCalledTimes(1);
    expect(out.join("")).toBe(
      '{"id":"SPY:1d","barCount":2,"firstT":1000,"lastT":2000}\n'
    );
  });

  it("closes the pool when the write fails", async () => {
    fakes.replaceSeries.mockRejectedValueOnce(new Error("write failed"));
    const code = await runScript([
      write("bars.csv", BARS),
      write("m.json", manifest()),
    ]);
    expect(code).toBe(1);
    expect(fakes.close).toHaveBeenCalledTimes(1);
    expect(errorText()).toContain("market bars import failed: write failed");
  });

  it.each([
    [[], "postgresql://test", "usage:"],
    [["only-one.csv"], "postgresql://test", "usage:"],
    [["a.csv", "b.json"], null, "DATABASE_URL is required"],
    [["a.csv", "b.json"], "", "DATABASE_URL is required"],
  ])("rejects arguments %j", async (args, url, message) => {
    expect(await runScript(args, url)).toBe(1);
    expect(errorText()).toContain(message);
    expect(fakes.createNodeDatabase).not.toHaveBeenCalled();
  });

  it.each([
    [BARS, manifest({ symbol: 5 }), "manifest field symbol must be a string"],
    [
      BARS,
      manifest({ timeframe: "5m" }),
      "manifest timeframe must be 1d or 1m",
    ],
    [
      BARS,
      manifest({ normalizedSha256: "abc" }),
      "normalizedSha256 must be 64 hex",
    ],
    [BARS, manifest({ normalizedSha256: "d".repeat(64) }), "does not match"],
    ["time,o\n1,2\n", null, "must start with the header"],
    [
      "t,o,h,l,c,v\n1,2,3,4,5\n",
      null,
      "bars line 2 must have 6 numeric fields",
    ],
    [
      "t,o,h,l,c,v\n1,x,3,4,5,6\n",
      null,
      "bars line 2 must have 6 numeric fields",
    ],
  ])("rejects bad files %#", async (bars, manifestText, message) => {
    const code = await runScript([
      write("bars.csv", bars),
      write(
        "m.json",
        manifestText ?? manifest({ normalizedSha256: sha(bars) })
      ),
    ]);
    expect(code).toBe(1);
    expect(errorText()).toContain(message);
    expect(fakes.createNodeDatabase).not.toHaveBeenCalled();
  });

  it("reports non-Error failures as text", async () => {
    fakes.replaceSeries.mockRejectedValueOnce("plain failure");
    await runScript([write("bars.csv", BARS), write("m.json", manifest())]);
    expect(errorText()).toContain("market bars import failed: plain failure");
  });
});
