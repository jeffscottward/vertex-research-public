import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createRandom } from "../../packages/api/src/backtest-analytics.ts";
import {
  type SymbolBars,
  scoreForecasts,
} from "../../packages/api/src/forecast-scorecard.ts";
import { at } from "../../packages/api/src/quant-arrays.ts";
import {
  parseArgs,
  parseBarCsv,
  runForecastScorecardCli,
  type ScorecardIo,
  type ScorecardRun,
  USAGE,
} from "./forecast-scorecard.ts";

const DAY_MS = 86_400_000;
const HEADER = "date,open,high,low,close,adj_close";

// A bar file with a seeded random walk on consecutive Monday-to-Friday dates.
const csv = (count: number, seed: number, volume = false): string => {
  const random = createRandom(seed);
  const lines = [volume ? `${HEADER},volume` : HEADER];
  let price = 100;
  for (let day = 0; lines.length <= count; day += 1) {
    const date = new Date(Date.UTC(2015, 0, 5) + day * DAY_MS);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    price *= 1 + (random() - 0.48) * 0.04;
    const cells = [
      date.toISOString().slice(0, 10),
      1,
      2,
      0.5,
      price / 2,
      price,
    ];
    lines.push([...cells, ...(volume ? [1000] : [])].join(","));
  }
  return `${lines.join("\n")}\n`;
};

const LONG: Readonly<Record<string, string>> = {
  "data/AAA.csv": csv(705, 1),
  "data/BBB.csv": csv(715, 2, true),
  "data/CCC.csv": csv(705, 3),
};

const harness = (
  files: Readonly<Record<string, string>>,
  score: ScorecardIo["score"] = scoreForecasts
) => {
  const out: string[] = [];
  const err: string[] = [];
  const io: ScorecardIo = {
    readFile: (path) => {
      const text = files[path];
      if (text === "<unreadable>")
        return Promise.reject(new Error(`EISDIR /abs/${path}`));
      return text === undefined
        ? Promise.reject(
            Object.assign(new Error(`ENOENT /abs/${path}`), { code: "ENOENT" })
          )
        : Promise.resolve(text);
    },
    score,
    sha256: (text) => createHash("sha256").update(text).digest("hex"),
    stderr: { write: (text) => err.push(text) },
    stdout: { write: (text) => out.push(text) },
  };
  const run = async (...argv: string[]) => ({
    code: await runForecastScorecardCli(argv, io),
    err: err.splice(0).join(""),
    out: out.splice(0).join(""),
  });
  return { run };
};

const ARGS = ["--bars", "data", "--symbols", "CCC,AAA,BBB"];

// A scorer that reads prices one row off against the dates.
const shiftedScore: ScorecardIo["score"] = (records, bars, params, random) =>
  scoreForecasts(
    records,
    new Map(
      [...bars.entries()].map(
        ([symbol, { dates, prices }]): [string, SymbolBars] => [
          symbol,
          { dates: dates.slice(0, -1), prices: prices.slice(1) },
        ]
      )
    ),
    params,
    random
  );

describe("parseBarCsv", () => {
  const rows = (...lines: string[]) => [HEADER, ...lines].join("\n");

  it("reads dates and adjusted closes, with LF or CRLF and an optional volume column", () => {
    const parsed = parseBarCsv(
      `${HEADER},volume\r\n2020-01-02,1,2,0.5,9,10.5,100\r\n2020-01-03,1,2,0.5,9,11,100\r\n`,
      "AAA.csv"
    );
    expect(parsed).toEqual({
      bars: { dates: ["2020-01-02", "2020-01-03"], prices: [10.5, 11] },
      firstDate: "2020-01-02",
      lastDate: "2020-01-03",
      rows: 2,
    });
    expect(parseBarCsv(rows("2020-01-02,1,2,0.5,9,10"), "AAA.csv").rows).toBe(
      1
    );
  });

  it.each([
    [
      "",
      "AAA.csv line 1: header must be date,open,high,low,close,adj_close[,volume]",
    ],
    [
      "date,close\n2020-01-02,1",
      "AAA.csv line 1: header must be date,open,high,low,close,adj_close[,volume]",
    ],
    [`${HEADER}\n`, "AAA.csv: no data lines"],
    [rows("2020-01-02,1,2,0.5,9"), "AAA.csv line 2: expected 6 fields"],
    [rows("2020-01-02,1,2,0.5,9,10,7"), "AAA.csv line 2: expected 6 fields"],
    [
      rows("2020-01-02,1,2,0.5,9,10", "", "2020-01-03,1,2,0.5,9,10"),
      "AAA.csv line 3: expected 6 fields",
    ],
    [
      rows("2020-01-02T00:00:00,1,2,0.5,9,10"),
      "AAA.csv line 2: date must be YYYY-MM-DD",
    ],
    [
      rows("2020-01-02,1,2,0.5,9,10", "2020-01-02,1,2,0.5,9,10"),
      "AAA.csv line 3: date must be later than the line before",
    ],
    [
      rows("2020-02-30,1,2,0.5,9,10"),
      "AAA.csv line 2: date must be YYYY-MM-DD",
    ],
    [
      rows("2020-13-01,1,2,0.5,9,10"),
      "AAA.csv line 2: date must be YYYY-MM-DD",
    ],
    [
      rows("2020-01-02,1,2,0.5,9,0x10"),
      "AAA.csv line 2: adj_close must be a number above 0",
    ],
    [
      rows("2020-01-02,1,2,0.5,9, 10"),
      "AAA.csv line 2: adj_close must be a number above 0",
    ],
    [
      rows("2020-01-02,1,2,0.5,9,0"),
      "AAA.csv line 2: adj_close must be a number above 0",
    ],
    [
      rows("2020-01-02,1,2,0.5,9,abc"),
      "AAA.csv line 2: adj_close must be a number above 0",
    ],
    [
      rows("2020-01-02,1,2,0.5,9,"),
      "AAA.csv line 2: adj_close must be a number above 0",
    ],
  ])("rejects %j", (text, message) => {
    expect(() => parseBarCsv(text, "AAA.csv")).toThrow(new Error(message));
  });
});

describe("parseArgs", () => {
  it("reads the flags, sorts the symbols and defaults the seed to 7", () => {
    expect(parseArgs(ARGS)).toEqual({
      bars: "data",
      seed: 7,
      summary: false,
      symbols: ["AAA", "BBB", "CCC"],
    });
    expect(parseArgs([...ARGS, "--summary", "--seed", "4294967295"])).toEqual({
      bars: "data",
      seed: 4_294_967_295,
      summary: true,
      symbols: ["AAA", "BBB", "CCC"],
    });
  });

  it.each([
    [["--bars", "data"]],
    [["--symbols", "AAA"]],
    [[...ARGS, "--out", "x"]],
    [[...ARGS, "--bars", "other"]],
    [[...ARGS, "--summary", "--summary"]],
    [[...ARGS, "--seed"]],
    [["--symbols", "AAA", "--bars", "--summary"]],
    [["--symbols", "AAA", "--bars", ""]],
    [["--bars", "data", "--symbols", "AAA,../x"]],
    [["--bars", "data", "--symbols", "AAA,,BBB"]],
    [["--bars", "data", "--symbols", "AAA,AAA"]],
    [[...ARGS, "--seed", "-1"]],
    [[...ARGS, "--seed", "1.5"]],
    [[...ARGS, "--seed", "4294967296"]],
  ])("prints the usage and exits 2 for %j", async (argv) => {
    const result = await harness(LONG).run(...argv);
    expect(result).toEqual({ code: 2, err: USAGE, out: "" });
  });
});

describe("runForecastScorecardCli", () => {
  it("prints a reproducible JSON result and passes the controls", async () => {
    const { run } = harness(LONG);
    const first = await run(...ARGS);
    expect(first.code).toBe(0);
    expect(first.err).toBe("");
    const result = JSON.parse(first.out) as ScorecardRun;
    expect(result.note).toBe(
      "Controls only. This run says nothing about JEV or any real forecaster. It does not evaluate the order gate."
    );
    expect(result.controlsPassed).toBe(true);
    // Keys are in alphabetical order at the top level.
    expect(Object.keys(result)).toEqual([
      "controls",
      "controlsPassed",
      "method",
      "note",
    ]);
    expect(
      result.controls.map((control) => [control.id, control.strength])
    ).toEqual([
      ["baseline-copy", null],
      ["perfect", null],
      ["planted-0.05", 0.05],
      ["planted-0.10", 0.1],
      ["planted-0.20", 0.2],
    ]);
    expect(
      result.controls.every((control) => control.agrees && control.passed)
    ).toBe(true);
    expect(at(result.controls, 0).expected).toBe(
      "skill against prior is 0 within 1e-9"
    );
    expect(at(result.controls, 1).scorecard.score.skill?.best).toBe(1);
    expect(
      at(result.controls, 4).scorecard.score.clusters
    ).toBeGreaterThanOrEqual(40);
    expect(result.method).toEqual({
      files: ["AAA", "BBB", "CCC"].map((symbol) => ({
        file: `${symbol}.csv`,
        firstDate: "2015-01-05",
        lastDate: expect.stringMatching(/^2017-\d{2}-\d{2}$/u),
        rows: { AAA: 705, BBB: 715, CCC: 705 }[symbol],
        sha256: createHash("sha256")
          .update(LONG[`data/${symbol}.csv`] ?? "")
          .digest("hex"),
      })),
      priceBasis: "adj_close",
      seed: 7,
    });
    // No path and no price in the output.
    expect(first.out).not.toContain("/");
    for (const text of Object.values(LONG)) {
      const last = at(
        text.trim().split("\n"),
        text.trim().split("\n").length - 1
      );
      expect(first.out).not.toContain(at(last.split(","), 5));
    }

    expect((await run(...ARGS)).out).toBe(first.out);
    const other = await run(...ARGS, "--seed", "8");
    expect(other.code).toBe(0);
    expect(other.out).not.toBe(first.out);
  });

  it("prints the summary", async () => {
    const { code, out } = await harness(LONG).run(...ARGS, "--summary");
    const lines = out.split("\n");
    expect(code).toBe(0);
    expect(lines.slice(0, 3)).toEqual([
      "Controls only. This run says nothing about JEV or any real forecaster. It does not evaluate the order gate.",
      "self-check: PASSED",
      "horizon 10 bars, price adj_close, seed 7, files 3",
    ]);
    expect(lines).toHaveLength(9);
    expect(at(lines, 4)).toMatch(
      /^perfect: scored \d+, clusters \d+, skill best 1\.0000 \[1\.0000, 1\.0000\], SKILL, check agrees, hits (\d+)\/\1 sided, prior \d+\/\d+ \(counts only\)$/u
    );
    expect(at(lines, 7)).toMatch(/^planted-0\.20: .*, check agrees, /u);
    expect(at(lines, 8)).toBe("");
  });

  it("reports short files as not enough data and still checks the arithmetic", async () => {
    const short = await harness({
      "data/AAA.csv": csv(320, 1),
    }).run("--bars", "data", "--symbols", "AAA");
    const result = JSON.parse(short.out) as ScorecardRun;
    expect(short.code).toBe(0);
    expect(
      result.controls.map((control) => control.scorecard.score.skillStatus)
    ).toEqual(Array.from({ length: 5 }, () => "NOT_ENOUGH_DATA"));
    expect(at(result.controls, 1).scorecard.score.scored).toBe(6);
    expect(result.controls.every((control) => control.agrees)).toBe(true);

    // No grid point at all: nothing was checked, so the run is refused.
    expect(
      await harness({ "data/AAA.csv": csv(100, 1) }).run(
        "--bars",
        "data",
        "--symbols",
        "AAA"
      )
    ).toEqual({
      code: 1,
      err: "forecast scorecard failed: no control forecast could be built: every bar file is too short (about 270 rows are needed)\n",
      out: "",
    });
  });

  it("exits 1 with a base-name message for a missing or bad file", async () => {
    const { run } = harness({
      ...LONG,
      "data/BAD.csv": `${HEADER}\n2020-01-02,1,2,3,4,-5\n`,
      "data/DIR.csv": "<unreadable>",
    });
    expect(await run("--bars", "data", "--symbols", "DIR")).toEqual({
      code: 1,
      err: "forecast scorecard failed: DIR.csv: cannot read the file\n",
      out: "",
    });
    expect(await run("--bars", "data", "--symbols", "AAA,ZZZ")).toEqual({
      code: 1,
      err: "forecast scorecard failed: ZZZ.csv: file not found\n",
      out: "",
    });
    expect(await run("--bars", "data", "--symbols", "BAD")).toEqual({
      code: 1,
      err: "forecast scorecard failed: BAD.csv line 2: adj_close must be a number above 0\n",
      out: "",
    });
  });

  it("exits 3 when the scorer reads prices one row off", async () => {
    const { run } = harness(LONG, shiftedScore);
    const json = await run(...ARGS);
    const result = JSON.parse(json.out) as ScorecardRun;
    expect(json.code).toBe(3);
    expect(result.controlsPassed).toBe(false);
    // The same records are scored; the skill comparison shows the error.
    expect(
      result.controls.every(
        (control) =>
          control.scorecard.score.scored === control.check.records &&
          !control.agrees
      )
    ).toBe(true);

    const summary = await run(...ARGS, "--summary");
    expect(summary.code).toBe(3);
    expect(at(summary.out.split("\n"), 1)).toBe("self-check: FAILED");
    expect(summary.out).toContain("check DIFFERS");
  });

  it("exits 3 when the scorer scores nothing", async () => {
    const { run } = harness(LONG, (records, _bars, params, random) =>
      scoreForecasts(records, new Map(), params, random)
    );
    const json = await run(...ARGS);
    expect(json.code).toBe(3);
    expect(
      (JSON.parse(json.out) as ScorecardRun).controls.every(
        (control) => !control.agrees
      )
    ).toBe(true);
    const summary = await run(...ARGS, "--summary");
    expect(at(summary.out.split("\n"), 3)).toMatch(
      /^baseline-copy: scored 0, clusters 0, skill best n\/a, NOT_ENOUGH_DATA, check DIFFERS, hits 0\/0 sided, prior 0\/0 \(counts only\)$/u
    );
  });

  it("does not hide an unexpected error", async () => {
    const { run } = harness(LONG, () => {
      throw new TypeError("scorer defect");
    });
    await expect(run(...ARGS)).rejects.toThrow(new TypeError("scorer defect"));
  });
});
