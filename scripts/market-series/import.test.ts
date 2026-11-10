import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as DbServer from "@darkfactory/db/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ETF_SYMBOLS,
  eyTnxRatio,
  FUTURES,
  INDICES,
  loadSeriesImports,
  parseCsv,
  parsePythonFloat,
  parseSeriesPoints,
  parseSha256Sums,
  parseShiller,
  parseSourcesRecord,
  runMarketSeriesImport,
  shiftMonth,
} from "./import.ts";

const fakes = vi.hoisted(() => {
  const replaceSeries = vi.fn(
    async (_series: unknown, _points: unknown) => ({})
  );
  const close = vi.fn(async () => undefined);
  return {
    close,
    createMarketDailySeriesRepository: vi.fn(() => ({ replaceSeries })),
    createNodeDatabase: vi.fn(() => ({ close, db: { fake: true } })),
    replaceSeries,
  };
});

vi.mock("@darkfactory/db/server", async (importOriginal) => ({
  ...(await importOriginal<typeof DbServer>()),
  createMarketDailySeriesRepository: fakes.createMarketDailySeriesRepository,
  createNodeDatabase: fakes.createNodeDatabase,
}));

const sha = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

const BAR_FILE =
  "date,open,high,low,close,adj_close\n2024-01-02,10,11,9,10.5,10.25\n2024-01-03,,11,9,10.75,10.5\n2024-01-04,10,11,9,nan,10\n";
const INDEX_FILE = "date,close\n2024-01-02,4.0\n2024-01-03,\n2024-01-04,0\n";
const SHILLER_FILE =
  "month,price,earnings\n2023-07,4500.5,190.25\n2023-08,0,1\n";

let directory = "";
let out: string[] = [];
let err: string[] = [];

/** Writes a complete fetch directory; `files` overrides or adds file texts (bytes for UTF-8 tests). */
const writeFetch = (
  dir: string,
  files: Record<string, string | Uint8Array> = {},
  unlisted: readonly string[] = []
) => {
  mkdirSync(dir, { recursive: true });
  const texts: Record<string, string | Uint8Array> = {
    "SHILLER.csv": SHILLER_FILE,
  };
  for (const id of [...ETF_SYMBOLS, ...FUTURES]) texts[`${id}.csv`] = BAR_FILE;
  for (const id of INDICES) texts[`${id}.csv`] = INDEX_FILE;
  Object.assign(texts, files);
  const sums: string[] = [];
  for (const [name, text] of Object.entries(texts)) {
    writeFileSync(join(dir, name), text);
    if (!unlisted.includes(name)) sums.push(`${sha(text)}  ${name}`);
  }
  writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  const fetched = new Date("2026-11-08T17:16:35Z");
  utimesSync(join(dir, "SHA256SUMS"), fetched, fetched);
};

const io = (env: NodeJS.ProcessEnv) => ({
  env,
  stderr: { write: (text: string) => err.push(text) > 0 },
  stdout: { write: (text: string) => out.push(text) > 0 },
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "market-series-"));
  out = [];
  err = [];
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe("parsePythonFloat (data._number)", () => {
  // Expected values come from CPython 3.12 float(); null where it raises or is not finite.
  it.each([
    ["10290.000000", 10_290],
    [" 1 ", 1],
    ["\t1\n", 1],
    ["\v1\f", 1],
    ["\u00a01\u3000", 1],
    ["\u00851", 1],
    ["\u20001", 1],
    ["\u0661\u0662\u0663", 123],
    ["\u{1D7CF}\u{1D7D0}.\u{1D7D3}", 12.5],
    ["1_000.5", 1000.5],
    ["1e1_0", 1e10],
    [".5", 0.5],
    ["5.", 5],
    ["1.e1", 10],
    ["+.5", 0.5],
    ["1e-400", 0],
    ["00012", 12],
    ["1E+05", 100_000],
    ["0.1", 0.1],
    ["\x1c1", null],
    ["1\x1c", null],
    ["\u200b1", null],
    ["\x7f1", null],
    ["1__0", null],
    ["_1", null],
    ["1_", null],
    ["1._5", null],
    ["inf", null],
    ["-Infinity", null],
    ["nan", null],
    ["1e400", null],
    ["0x10", null],
    ["", null],
    [" ", null],
    ["1 0", null],
  ])("%j -> %s", (text, expected) => {
    expect(parsePythonFloat(text)).toBe(expected);
  });

  it("keeps negative zero", () => {
    expect(Object.is(parsePythonFloat("-0.0"), -0)).toBe(true);
  });
});

describe("parseCsv", () => {
  it("reads rows by header name, skipping blank lines and any line ending", () => {
    expect(
      parseCsv(
        "X.csv",
        "date,close\r\n2024-01-02,1\r\n\r2024-01-03,2\n",
        "date,close"
      )
    ).toEqual([
      { close: "1", date: "2024-01-02" },
      { close: "2", date: "2024-01-03" },
    ]);
  });

  it.each([
    [
      'date,close\n2024-01-02,"1"\n',
      "X.csv: quoted CSV fields are not supported",
    ],
    ["\ufeffdate,close\n", "X.csv: header must be date,close"],
    ["date,close\n2024-01-02\n", "X.csv: line 2 must have 2 fields"],
    ["date,close\n2024-01-02,1,2\n", "X.csv: line 2 must have 2 fields"],
  ])("refuses %j", (text, message) => {
    expect(() => parseCsv("X.csv", text, "date,close")).toThrow(message);
  });
});

describe("parseSeriesPoints", () => {
  it("keeps rows with a finite close and nulls the other bar columns that do not parse", () => {
    expect(parseSeriesPoints("SPY.csv", BAR_FILE, true)).toEqual([
      {
        adjClose: 10.25,
        close: 10.5,
        date: "2024-01-02",
        high: 11,
        low: 9,
        open: 10,
      },
      {
        adjClose: 10.5,
        close: 10.75,
        date: "2024-01-03",
        high: 11,
        low: 9,
        open: null,
      },
    ]);
  });

  it("reads index files as close only, zero included", () => {
    expect(parseSeriesPoints("VIX.csv", INDEX_FILE, false)).toEqual([
      {
        adjClose: null,
        close: 4,
        date: "2024-01-02",
        high: null,
        low: null,
        open: null,
      },
      {
        adjClose: null,
        close: 0,
        date: "2024-01-04",
        high: null,
        low: null,
        open: null,
      },
    ]);
  });
});

describe("Shiller and EY_TNX_RATIO (data.load_shiller, data.ey_tnx_ratio)", () => {
  it("keeps finite rows with price > 0, the last row of a month winning", () => {
    expect(
      parseShiller(
        "month,price,earnings\n2023-01,100,5\n2023-02,-1,5\n2023-03,100,x\n2023-04,inf,5\n2023-01,200,6\n"
      )
    ).toEqual(new Map([["2023-01", [200, 6]]]));
  });

  it.each([
    ["2024-07", -6, "2024-01"],
    ["2024-06", -6, "2023-12"],
    ["2024-01", -6, "2023-07"],
    ["2023-12", 1, "2024-01"],
  ])("shiftMonth(%s, %i) = %s", (month, delta, expected) => {
    expect(shiftMonth(month, delta)).toBe(expected);
  });

  it("divides 100 * E / P of the month 6 back by the yield, skipping missing months and yields <= 0", () => {
    const shiller = new Map([["2023-07", [4500.5, 190.25] as const]]);
    const tnx = parseSeriesPoints(
      "TNX.csv",
      "date,close\n2024-01-02,4.0\n2024-01-03,0\n2024-01-04,-0.1\n2024-02-01,4.1\n",
      false
    );
    expect(eyTnxRatio(shiller, tnx)).toEqual([
      {
        adjClose: null,
        close: (100 * 190.25) / 4500.5 / 4,
        date: "2024-01-02",
        high: null,
        low: null,
        open: null,
      },
    ]);
  });
});

describe("parseSha256Sums", () => {
  it("reads text and binary mode lines", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(parseSha256Sums(`${a}  SPY.csv\n\n${b} *ES=F.csv\n`)).toEqual(
      new Map([
        ["SPY.csv", a],
        ["ES=F.csv", b],
      ])
    );
  });

  it("reads CRLF line endings without keeping the carriage return", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(parseSha256Sums(`${a}  SPY.csv\r\n${b}  QQQ.csv\r\n`)).toEqual(
      new Map([
        ["SPY.csv", a],
        ["QQQ.csv", b],
      ])
    );
  });

  it("refuses a duplicate file entry", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(() => parseSha256Sums(`${a}  SPY.csv\n${b} *SPY.csv\n`)).toThrow(
      "SHA256SUMS line 2 repeats SPY.csv"
    );
  });

  it("refuses a malformed line", () => {
    expect(() => parseSha256Sums("abc  SPY.csv\n")).toThrow(
      'SHA256SUMS line 1 is not "<sha256>  <file>"'
    );
  });
});

describe("loadSeriesImports", () => {
  it("verifies, parses and derives the 25 series with their sources", async () => {
    writeFetch(directory);
    const imports = await loadSeriesImports(directory);
    expect(imports.map((entry) => entry.series.id)).toEqual([
      ...ETF_SYMBOLS,
      ...FUTURES,
      ...INDICES,
      "EY_TNX_RATIO",
    ]);
    const byId = new Map(imports.map((entry) => [entry.series.id, entry]));
    expect(byId.get("SPY")?.series).toEqual({
      id: "SPY",
      kind: "etf",
      source:
        "qc-ports fetch (research/backtests/qc-ports/fetch_data.py): daily bars SPY, split-adjusted close: IBKR first, Yahoo fills gaps; fetched 2026-11-08",
      sourceSha256: sha(BAR_FILE),
    });
    expect(byId.get("ES=F")?.series.kind).toBe("future");
    expect(byId.get("ES=F")?.series.source).toContain(
      "ES=F (continuous future)"
    );
    expect(byId.get("VIX")?.series.source).toContain(
      "daily close ^VIX: IBKR first, Yahoo fills gaps, then the CBOE public history CSV;"
    );
    expect(byId.get("TNX")?.series.source).toContain(
      "then US Treasury yields;"
    );
    expect(byId.get("RVX")?.series.source).toContain(
      "CBOE public history CSV RVX_History.csv"
    );
    expect(byId.get("VXSLV")?.series.kind).toBe("index");
    expect(byId.get("SPY")?.points).toHaveLength(2);
    const ratio = byId.get("EY_TNX_RATIO");
    expect(ratio?.series.kind).toBe("derived");
    expect(ratio?.series.source.length).toBeLessThanOrEqual(300);
    expect(ratio?.series.source).toContain("Shiller ie_data.xls");
    expect(ratio?.series.sourceSha256).toBe(
      sha(`${sha(SHILLER_FILE)}  SHILLER.csv\n${sha(INDEX_FILE)}  TNX.csv\n`)
    );
    expect(ratio?.points.map((point) => [point.date, point.close])).toEqual([
      ["2024-01-02", (100 * 190.25) / 4500.5 / 4],
    ]);
  });

  it("labels each series from SOURCES.json when the fetch recorded it", async () => {
    const sources = JSON.stringify({
      "RVX.csv": {
        rows: { cboe: { first: "2004-01-02", last: "2026-11-06", rows: 5000 } },
      },
      "SPY.csv": {
        rows: {
          ibkr: { first: "1996-11-11", last: "2026-11-06", rows: 7550 },
          yahoo: { first: "1993-01-29", last: "1996-11-08", rows: 950 },
        },
      },
    });
    writeFetch(directory, { "SOURCES.json": sources });
    const imports = await loadSeriesImports(directory);
    const byId = new Map(imports.map((entry) => [entry.series.id, entry]));
    expect(byId.get("SPY")?.series.source).toContain(
      "daily bars SPY, split-adjusted close: ibkr 1996-11-11..2026-11-06, yahoo 1993-01-29..1996-11-08; fetched"
    );
    expect(byId.get("RVX")?.series.source).toContain(
      "daily close ^RVX: cboe 2004-01-02..2026-11-06;"
    );
    expect(byId.get("QQQ")?.series.source).toContain(
      "split-adjusted close: IBKR first, Yahoo fills gaps;"
    );
    for (const entry of imports) {
      expect(entry.series.source.length).toBeLessThanOrEqual(300);
    }
  });

  it("refuses a SOURCES.json that is not a JSON object", async () => {
    writeFetch(directory, { "SOURCES.json": "[]" });
    await expect(loadSeriesImports(directory)).rejects.toThrow(
      "SOURCES.json must be a JSON object"
    );
    expect(() => parseSourcesRecord("null")).toThrow("JSON object");
  });

  it("refuses a file missing from SHA256SUMS", async () => {
    writeFetch(directory, {}, ["GLD.csv"]);
    await expect(loadSeriesImports(directory)).rejects.toThrow(
      "GLD.csv is not listed in SHA256SUMS"
    );
  });

  it("refuses a file whose digest changed", async () => {
    writeFetch(directory);
    writeFileSync(
      join(directory, "SHILLER.csv"),
      `${SHILLER_FILE}2023-09,1,1\n`
    );
    await expect(loadSeriesImports(directory)).rejects.toThrow(
      "SHILLER.csv does not match its SHA256SUMS digest"
    );
  });

  it("refuses invalid UTF-8 like Python's strict decoder", async () => {
    writeFetch(directory, { "VIX.csv": new Uint8Array([0x64, 0xff, 0x0a]) });
    await expect(loadSeriesImports(directory)).rejects.toThrow(TypeError);
  });

  it("refuses series the repository would refuse, such as unordered dates", async () => {
    writeFetch(directory, {
      "OVX.csv": "date,close\n2024-01-03,1\n2024-01-02,2\n",
    });
    await expect(loadSeriesImports(directory)).rejects.toThrow(
      "date must be a YYYY-MM-DD date after the previous point"
    );
  });
});

describe("runMarketSeriesImport", () => {
  it("dry-runs: prints counts only and never opens a database", async () => {
    writeFetch(directory);
    await expect(
      runMarketSeriesImport(["--dry-run", directory], io({}))
    ).resolves.toBe(0);
    const lines = out
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(26);
    expect(lines[0]).toEqual({
      first: "2024-01-02",
      id: "SPY",
      kind: "etf",
      last: "2024-01-03",
      points: 2,
    });
    expect(lines.at(-1)).toEqual({
      dryRun: true,
      points: 14 * 2 + 10 * 2 + 1,
      series: 25,
    });
    expect(fakes.createNodeDatabase).not.toHaveBeenCalled();
    expect(err).toEqual([]);
  });

  it("imports every series through the repository and closes the database", async () => {
    writeFetch(directory);
    await expect(
      runMarketSeriesImport(
        [directory],
        io({ DATABASE_URL: "postgresql://test" })
      )
    ).resolves.toBe(0);
    expect(fakes.createNodeDatabase).toHaveBeenCalledWith({
      connectionString: "postgresql://test",
    });
    expect(fakes.createMarketDailySeriesRepository).toHaveBeenCalledWith({
      fake: true,
    });
    expect(fakes.replaceSeries).toHaveBeenCalledTimes(25);
    expect(fakes.replaceSeries.mock.calls.at(-1)?.[0]).toMatchObject({
      id: "EY_TNX_RATIO",
      kind: "derived",
    });
    expect(JSON.parse(out.at(-1) as string)).toEqual({
      dryRun: false,
      points: 49,
      series: 25,
    });
    expect(fakes.close).toHaveBeenCalledOnce();
  });

  it("reads $VERTEX_QC_PORTS_DATA, then the default directory under the home directory", async () => {
    writeFetch(directory);
    await expect(
      runMarketSeriesImport(
        ["--dry-run"],
        io({ VERTEX_QC_PORTS_DATA: directory })
      )
    ).resolves.toBe(0);
    const home = join(directory, "home");
    writeFetch(join(home, "Documents", "reports", "vertex-qc-ports", "data"));
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      await expect(
        runMarketSeriesImport(["--dry-run"], io({ VERTEX_QC_PORTS_DATA: "" }))
      ).resolves.toBe(0);
    } finally {
      process.env["HOME"] = previousHome;
    }
    expect(err).toEqual([]);
  });

  it.each([[["--force"]], [["a", "b"]]])("refuses usage %j", async (argv) => {
    await expect(runMarketSeriesImport(argv, io({}))).resolves.toBe(1);
    expect(err.join("")).toContain(
      "market series import failed: usage: bun run vertex:series:import -- [--dry-run] [<data dir>]"
    );
  });

  it.each([[{}], [{ DATABASE_URL: "" }]])(
    "needs DATABASE_URL unless dry-running (%j)",
    async (env) => {
      writeFetch(directory);
      await expect(runMarketSeriesImport([directory], io(env))).resolves.toBe(
        1
      );
      expect(err.join("")).toContain(
        "DATABASE_URL is required (or pass --dry-run)"
      );
      expect(fakes.createNodeDatabase).not.toHaveBeenCalled();
    }
  );

  it("reports a write failure and still closes the database", async () => {
    writeFetch(directory);
    fakes.replaceSeries.mockRejectedValueOnce(new Error("write failed"));
    await expect(
      runMarketSeriesImport(
        [directory],
        io({ DATABASE_URL: "postgresql://test" })
      )
    ).resolves.toBe(1);
    expect(err.join("")).toContain("market series import failed: write failed");
    expect(fakes.close).toHaveBeenCalledOnce();
  });

  it("reports a non-Error failure", async () => {
    writeFetch(directory);
    fakes.replaceSeries.mockRejectedValueOnce("plain failure");
    await expect(
      runMarketSeriesImport(
        [directory],
        io({ DATABASE_URL: "postgresql://test" })
      )
    ).resolves.toBe(1);
    expect(err.join("")).toContain(
      "market series import failed: plain failure"
    );
  });
});
