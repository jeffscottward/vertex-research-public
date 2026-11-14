// Forecast scorecard self-check on daily bar files (research only).
// Usage: bun run research:forecast-scorecard -- --bars <folder> --symbols <A,B,...> [--seed <n>] [--summary]
//
// Spec: docs/specs/research/forecast-scorecard.md ("Command contract"). The command reads
// <folder>/<SYMBOL>.csv (date,open,high,low,close,adj_close[,volume]), builds control forecasts
// with known answers, scores them with packages/api/src/forecast-scorecard.ts and compares each
// result with a value that the controls file computes on its own. It scores controls only: it
// says nothing about JEV or any real forecaster, and it does not evaluate the order gate.
// Output: JSON on stdout (or a text summary with --summary). No price, no absolute path and no
// wall-clock time is printed. Exit codes: 0 controls passed, 1 input error, 2 usage error,
// 3 a control failed.

import { join } from "node:path";

import {
  createRandom,
  seedFrom,
} from "../../packages/api/src/backtest-analytics.ts";
import {
  DEFAULT_SCORECARD_PARAMS,
  FORECAST_SYMBOL_PATTERN,
  type ForecastScorecard,
  type SymbolBars,
  type scoreForecasts,
} from "../../packages/api/src/forecast-scorecard.ts";
import { at } from "../../packages/api/src/quant-arrays.ts";
import {
  baselineCopyControl,
  type Control,
  controlGrid,
  perfectControl,
  plantedControl,
} from "./forecast-scorecard-controls.ts";

export type ScorecardIo = Readonly<{
  readFile: (path: string) => Promise<string>;
  sha256: (text: string) => string;
  // The scorer under check. The entry file passes scoreForecasts.
  score: typeof scoreForecasts;
  stdout: Readonly<{ write: (text: string) => unknown }>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
}>;

export const USAGE =
  "Usage: bun run research:forecast-scorecard -- --bars <folder> --symbols <A,B,...> [--seed <n>] [--summary]\n";

const NOTE =
  "Controls only. This run says nothing about JEV or any real forecaster. It does not evaluate the order gate.";
const HEADER = "date,open,high,low,close,adj_close";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const DECIMAL = /^\d+(?:\.\d+)?$/u;
const SEED = /^\d{1,10}$/u;
const SEED_MAX = 4_294_967_295;
const DEFAULT_SEED = "7";
const PLANTED_STRENGTHS = [0.05, 0.1, 0.2] as const;
const TOLERANCE = 1e-9;

class UsageError extends Error {}
/** A problem with a bar file; the command exits with code 1. */
class InputError extends Error {}

export type ParsedBars = Readonly<{
  bars: SymbolBars;
  rows: number;
  firstDate: string;
  lastDate: string;
}>;

/** Strict reader of one bar file. The first bad line stops the run; line 1 is the header. */
export const parseBarCsv = (text: string, fileName: string): ParsedBars => {
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  const header = lines[0];
  if (header !== HEADER && header !== `${HEADER},volume`)
    throw new InputError(
      `${fileName} line 1: header must be ${HEADER}[,volume]`
    );
  if (lines.length < 2) throw new InputError(`${fileName}: no data lines`);
  const fields = header.split(",").length;
  const dates: string[] = [];
  const prices: number[] = [];
  for (const [index, line] of lines.slice(1).entries()) {
    const fail = (reason: string) =>
      new InputError(`${fileName} line ${index + 2}: ${reason}`);
    const cells = line.split(",");
    if (cells.length !== fields) throw fail(`expected ${fields} fields`);
    const date = at(cells, 0);
    // A real calendar date: it survives a round trip through Date.
    const time = ISO_DAY.test(date)
      ? Date.parse(`${date}T00:00:00Z`)
      : Number.NaN;
    if (
      Number.isNaN(time) ||
      new Date(time).toISOString().slice(0, 10) !== date
    )
      throw fail("date must be YYYY-MM-DD");
    if (date <= (dates.at(-1) ?? ""))
      throw fail("date must be later than the line before");
    const price = DECIMAL.test(at(cells, 5)) ? Number(at(cells, 5)) : 0;
    if (!(Number.isFinite(price) && price > 0))
      throw fail("adj_close must be a number above 0");
    dates.push(date);
    prices.push(price);
  }
  return {
    bars: { dates, prices },
    firstDate: at(dates, 0),
    lastDate: at(dates, dates.length - 1),
    rows: dates.length,
  };
};

export type ScorecardArgs = Readonly<{
  bars: string;
  symbols: string[];
  seed: number;
  summary: boolean;
}>;

/** Throws a usage error for an unknown or repeated flag, a missing value or a bad value. */
export const parseArgs = (argv: readonly string[]): ScorecardArgs => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = at(argv, index);
    const known = ["--bars", "--symbols", "--seed", "--summary"].includes(flag);
    if (!known || values.has(flag)) throw new UsageError();
    if (flag === "--summary") {
      values.set(flag, "");
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("--"))
      throw new UsageError();
    values.set(flag, value);
    index += 1;
  }
  const bars = values.get("--bars");
  const symbols = values.get("--symbols")?.split(",");
  const seed = values.get("--seed") ?? DEFAULT_SEED;
  if (
    bars === undefined ||
    symbols === undefined ||
    symbols.some((symbol) => !FORECAST_SYMBOL_PATTERN.test(symbol)) ||
    new Set(symbols).size !== symbols.length ||
    !SEED.test(seed) ||
    Number(seed) > SEED_MAX
  )
    throw new UsageError();
  return {
    bars,
    seed: Number(seed),
    summary: values.has("--summary"),
    symbols: [...symbols].sort(),
  };
};

export type ControlRun = Readonly<{
  id: string;
  strength: number | null;
  scorecard: ForecastScorecard;
  check: Control["check"];
  // The scorer scored the same number of records and both skills agree within 1e-9.
  agrees: boolean;
  expected: string;
  passed: boolean;
}>;

type ScorecardFile = Readonly<{
  file: string;
  sha256: string;
  rows: number;
  firstDate: string;
  lastDate: string;
}>;

export type ScorecardRun = Readonly<{
  note: string;
  method: Readonly<{
    seed: number;
    priceBasis: "adj_close";
    files: readonly ScorecardFile[];
  }>;
  controls: ControlRun[];
  controlsPassed: boolean;
}>;

type Skill = NonNullable<ForecastScorecard["score"]["skill"]>;
type Plan = Readonly<{
  control: Control;
  strength: number | null;
  expected: string;
  // Distance of the result from the expected value; 0 when only the agreement is required.
  deviation: (skill: Skill) => number;
}>;

/** Builds the five control runs, scores them with `score` and compares with the check values. */
const runControls = (
  barsBySymbol: ReadonlyMap<string, SymbolBars>,
  seed: number,
  score: typeof scoreForecasts
): Pick<ScorecardRun, "controls" | "controlsPassed"> => {
  const params = DEFAULT_SCORECARD_PARAMS;
  const stream = (name: string) => createRandom(seedFrom(`${seed}:${name}`));
  const grid = controlGrid(
    barsBySymbol,
    params.horizonBars,
    params.priorMinWindows
  );
  const plans: Plan[] = [
    {
      control: baselineCopyControl(grid),
      deviation: (skill) => skill.prior,
      expected: "skill against prior is 0 within 1e-9",
      strength: null,
    },
    {
      control: perfectControl(grid),
      deviation: (skill) => skill.best - 1,
      expected: "best skill is 1 within 1e-9",
      strength: null,
    },
    ...PLANTED_STRENGTHS.map((strength) => ({
      control: plantedControl(
        grid,
        strength,
        stream(`generate:planted-${strength.toFixed(2)}`)
      ),
      deviation: () => 0,
      expected: "agrees with the check value",
      strength,
    })),
  ];
  const controls = plans.map(
    ({ control, deviation, expected, strength }): ControlRun => {
      const scorecard = score(
        control.records,
        barsBySymbol,
        params,
        stream(`bootstrap:${control.id}`)
      );
      const { scored, skill } = scorecard.score;
      const { check } = control;
      const differences =
        skill === null
          ? [scored, check.records]
          : [
              scored - check.records,
              skill.half - check.skillHalf,
              skill.prior - check.skillPrior,
              deviation(skill),
            ];
      const [, , , expectation = 0] = differences;
      const agrees = differences
        .slice(0, 3)
        .every((difference) => Math.abs(difference) < TOLERANCE);
      return {
        agrees,
        check,
        expected,
        id: control.id,
        passed: agrees && Math.abs(expectation) < TOLERANCE,
        scorecard,
        strength,
      };
    }
  );
  return {
    controls,
    controlsPassed: controls.every((control) => control.passed),
  };
};

const fixed = (value: number): string => value.toFixed(4);

/** The text form of a run; every value comes from the run object. */
const renderSummary = (run: ScorecardRun): string => {
  const lines = [
    run.note,
    `self-check: ${run.controlsPassed ? "PASSED" : "FAILED"}`,
    `horizon ${at(run.controls, 0).scorecard.params.horizonBars} bars, price ${run.method.priceBasis}, seed ${run.method.seed}, files ${run.method.files.length}`,
  ];
  for (const { agrees, id, scorecard } of run.controls) {
    const { clusters, hits, interval, scored, skill, skillStatus } =
      scorecard.score;
    const best =
      skill === null || interval === null
        ? "n/a"
        : `${fixed(skill.best)} [${fixed(interval.low)}, ${fixed(interval.high)}]`;
    lines.push(
      `${id}: scored ${scored}, clusters ${clusters}, skill best ${best}, ${skillStatus}, check ${agrees ? "agrees" : "DIFFERS"}, hits ${hits.forecastHits}/${hits.sided} sided, prior ${hits.priorHits}/${scored} (counts only)`
    );
  }
  return `${lines.join("\n")}\n`;
};

const execute = async (
  args: ScorecardArgs,
  io: ScorecardIo
): Promise<ScorecardRun> => {
  const barsBySymbol = new Map<string, SymbolBars>();
  const files: ScorecardFile[] = [];
  for (const symbol of args.symbols) {
    const file = `${symbol}.csv`;
    const text = await io
      .readFile(join(args.bars, file))
      .catch((error: unknown) => {
        const missing = (error as { code?: unknown }).code === "ENOENT";
        throw new InputError(
          `${file}: ${missing ? "file not found" : "cannot read the file"}`
        );
      });
    const { bars, firstDate, lastDate, rows } = parseBarCsv(text, file);
    barsBySymbol.set(symbol, bars);
    files.push({ file, firstDate, lastDate, rows, sha256: io.sha256(text) });
  }
  const { controls, controlsPassed } = runControls(
    barsBySymbol,
    args.seed,
    io.score
  );
  // Without a single control forecast nothing was checked: that is not a pass.
  if (at(controls, 0).check.records === 0)
    throw new InputError(
      "no control forecast could be built: every bar file is too short (about 270 rows are needed)"
    );
  return {
    controls,
    controlsPassed,
    method: { files, priceBasis: "adj_close", seed: args.seed },
    note: NOTE,
  };
};

export const runForecastScorecardCli = async (
  argv: readonly string[],
  io: ScorecardIo
): Promise<number> => {
  let args: ScorecardArgs;
  try {
    args = parseArgs(argv);
  } catch {
    io.stderr.write(USAGE);
    return 2;
  }
  try {
    const result = await execute(args, io);
    io.stdout.write(
      args.summary
        ? renderSummary(result)
        : `${JSON.stringify(result, null, 2)}\n`
    );
    return result.controlsPassed ? 0 : 3;
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    io.stderr.write(`forecast scorecard failed: ${error.message}\n`);
    return 1;
  }
};
