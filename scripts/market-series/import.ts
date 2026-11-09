// Imports the daily research series of the QuantConnect idea ports into market_daily_series.
// Usage: DATABASE_URL=... bun run vertex:series:import -- [--dry-run] [<dir>]
// <dir> defaults to $VERTEX_QC_PORTS_DATA, then ~/Documents/reports/vertex-qc-ports/data: the
// output of research/backtests/qc-ports/fetch_data.py (Yahoo, CBOE and Shiller files plus
// SHA256SUMS). Every file is verified against SHA256SUMS before anything is parsed or written.
// Rows mirror services/research/strategies/qc_ports/data.py: a row is kept when its close parses
// to a finite number with Python float() rules; open, high, low and adj_close are null where they
// do not. EY_TNX_RATIO is derived exactly as data.ey_tnx_ratio. Each series is replaced in one
// transaction; --dry-run parses and verifies only and prints the counts. Research data only;
// nothing here connects to a broker.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createMarketDailySeriesRepository,
  createNodeDatabase,
  type MarketDailyPoint,
  type MarketDailySeriesInput,
  validateMarketDailySeries,
} from "@darkfactory/db/server";

export const ETF_SYMBOLS = [
  "SPY",
  "QQQ",
  "DIA",
  "IWM",
  "GLD",
  "SLV",
  "USO",
] as const;
export const FUTURES = [
  "ES=F",
  "NQ=F",
  "YM=F",
  "RTY=F",
  "GC=F",
  "SI=F",
  "CL=F",
] as const;
export const INDICES = [
  "VIX",
  "VIX3M",
  "VXN",
  "VXD",
  "RVX",
  "GVZ",
  "OVX",
  "VXSLV",
  "IRX",
  "TNX",
] as const;
/** Indices the fetch reads from the CBOE public history CSV; the rest come from Yahoo. */
const CBOE_INDICES = new Set<string>(["RVX", "VXSLV"]);
/** Months between the Shiller month and its use (earnings are published late), as data.py. */
const EARNINGS_LAG_MONTHS = 6;
const DATA_ENV = "VERTEX_QC_PORTS_DATA";
const BAR_HEADER = "date,open,high,low,close,adj_close";
const INDEX_HEADER = "date,close";
const SHILLER_HEADER = "month,price,earnings";
const FETCH = "qc-ports fetch (research/backtests/qc-ports/fetch_data.py)";
const USAGE = "usage: bun run vertex:series:import -- [--dry-run] [<data dir>]";

// float() maps non-ASCII str.isspace() characters to spaces, then strips ASCII whitespace only
// (space and \t\n\v\f\r; \x1c-\x1f are not stripped).
const PYTHON_WIDE_SPACE =
  /[\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
const PYTHON_ASCII_SPACE = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu;
const DIGIT_PART = "[0-9](?:_?[0-9])*";
const PYTHON_DECIMAL = new RegExp(
  `^[+-]?(?:${DIGIT_PART}(?:\\.(?:${DIGIT_PART})?)?|\\.${DIGIT_PART})(?:[eE][+-]?${DIGIT_PART})?$`,
  "u"
);
const DECIMAL_DIGIT = /\p{Nd}/u;

/** ASCII value of a Unicode decimal digit: Nd digits are encoded in contiguous runs 0..9. */
const decimalDigitValue = (codePoint: number): number => {
  let offset = 0;
  while (DECIMAL_DIGIT.test(String.fromCodePoint(codePoint - offset - 1))) {
    offset += 1;
  }
  return offset % 10;
};

/**
 * data._number: Python float(text) when it is finite, else null. Like CPython, Unicode decimal
 * digits and whitespace are first mapped to ASCII, surrounding whitespace is stripped, single
 * underscores between digits are allowed, and inf/nan spellings parse but are not finite.
 */
export const parsePythonFloat = (text: string): number | null => {
  let ascii = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0) as number;
    if (codePoint < 0x80) ascii += char;
    else if (PYTHON_WIDE_SPACE.test(char)) ascii += " ";
    else if (DECIMAL_DIGIT.test(char)) {
      ascii += String(decimalDigitValue(codePoint));
    } else ascii += "?";
  }
  const stripped = ascii.replace(PYTHON_ASCII_SPACE, "");
  if (!PYTHON_DECIMAL.test(stripped)) return null;
  const value = Number(stripped.replaceAll("_", ""));
  return Number.isFinite(value) ? value : null;
};

/**
 * csv.DictReader over the fetch output: comma separated, no quoting, blank lines skipped. Rows
 * whose field count differs from the header are refused (DictReader would hand data.py a None).
 */
export const parseCsv = (
  name: string,
  text: string,
  header: string
): Record<string, string>[] => {
  if (text.includes('"')) {
    throw new Error(`${name}: quoted CSV fields are not supported`);
  }
  const lines = text.split(/\r\n|\r|\n/u);
  if (lines[0] !== header) {
    throw new Error(`${name}: header must be ${header}`);
  }
  const names = header.split(",");
  const rows: Record<string, string>[] = [];
  for (const [index, line] of lines.entries()) {
    if (index === 0 || line === "") continue;
    const fields = line.split(",");
    if (fields.length !== names.length) {
      throw new Error(
        `${name}: line ${index + 1} must have ${names.length} fields`
      );
    }
    rows.push(
      Object.fromEntries(names.map((key, at) => [key, fields[at] as string]))
    );
  }
  return rows;
};

/** Rows whose close is finite; the other bar columns are null where they do not parse. */
export const parseSeriesPoints = (
  name: string,
  text: string,
  bars: boolean
): MarketDailyPoint[] => {
  const points: MarketDailyPoint[] = [];
  for (const row of parseCsv(name, text, bars ? BAR_HEADER : INDEX_HEADER)) {
    const close = parsePythonFloat(row["close"] as string);
    if (close === null) continue;
    const column = (key: string): number | null =>
      bars ? parsePythonFloat(row[key] as string) : null;
    points.push({
      adjClose: column("adj_close"),
      close,
      date: row["date"] as string,
      high: column("high"),
      low: column("low"),
      open: column("open"),
    });
  }
  return points;
};

/** data.load_shiller: month -> (price, earnings) for finite values with price > 0. */
export const parseShiller = (
  text: string
): Map<string, readonly [number, number]> => {
  const table = new Map<string, readonly [number, number]>();
  for (const row of parseCsv("SHILLER.csv", text, SHILLER_HEADER)) {
    const price = parsePythonFloat(row["price"] as string);
    const earnings = parsePythonFloat(row["earnings"] as string);
    if (price !== null && earnings !== null && price > 0) {
      table.set(row["month"] as string, [price, earnings]);
    }
  }
  return table;
};

/** data._shift_month: `YYYY-MM` moved by `delta` months. */
export const shiftMonth = (month: string, delta: number): string => {
  const serial =
    Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  const year = Math.floor(serial / 12);
  return `${String(year).padStart(4, "0")}-${String(serial - year * 12 + 1).padStart(2, "0")}`;
};

/** data.ey_tnx_ratio: 100 * E/P of the Shiller month 6 months back over the TNX yield (percent). */
export const eyTnxRatio = (
  shiller: ReadonlyMap<string, readonly [number, number]>,
  tnx: readonly MarketDailyPoint[]
): MarketDailyPoint[] => {
  const points: MarketDailyPoint[] = [];
  for (const { close: yieldPct, date } of tnx) {
    const row = shiller.get(shiftMonth(date.slice(0, 7), -EARNINGS_LAG_MONTHS));
    if (row === undefined || yieldPct <= 0) continue;
    const [price, earnings] = row;
    points.push({
      adjClose: null,
      close: (100 * earnings) / price / yieldPct,
      date,
      high: null,
      low: null,
      open: null,
    });
  }
  return points;
};

/** `<sha256>  <file>` lines (sha256sum text or binary mode) -> file -> digest. */
export const parseSha256Sums = (text: string): Map<string, string> => {
  const sums = new Map<string, string>();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/u.exec(line);
    if (match === null) {
      throw new Error(`SHA256SUMS line ${index + 1} is not "<sha256>  <file>"`);
    }
    const file = match[2] as string;
    if (sums.has(file)) {
      throw new Error(`SHA256SUMS line ${index + 1} repeats ${file}`);
    }
    sums.set(file, match[1] as string);
  }
  return sums;
};

export type SeriesImport = Readonly<{
  series: MarketDailySeriesInput;
  points: readonly MarketDailyPoint[];
}>;

const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

// Python opens the files as UTF-8 and fails on invalid bytes; a BOM stays in the text.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Reads, verifies and parses the 25 series of a fetch directory; writes nothing. */
export const loadSeriesImports = async (
  dir: string
): Promise<SeriesImport[]> => {
  const sums = parseSha256Sums(await readFile(join(dir, "SHA256SUMS"), "utf8"));
  const fetched = (await stat(join(dir, "SHA256SUMS"))).mtime
    .toISOString()
    .slice(0, 10);
  const texts = new Map<string, string>();
  const verified = async (file: string): Promise<string> => {
    const expected = sums.get(file);
    if (expected === undefined) {
      throw new Error(`${file} is not listed in SHA256SUMS`);
    }
    const bytes = await readFile(join(dir, file));
    if (sha256(bytes) !== expected) {
      throw new Error(`${file} does not match its SHA256SUMS digest`);
    }
    texts.set(file, UTF8.decode(bytes));
    return expected;
  };
  const imports: SeriesImport[] = [];
  const add = async (
    id: string,
    kind: MarketDailySeriesInput["kind"],
    origin: string
  ) => {
    const file = `${id}.csv`;
    const digest = await verified(file);
    imports.push({
      points: parseSeriesPoints(
        file,
        texts.get(file) as string,
        kind !== "index"
      ),
      series: {
        id,
        kind,
        source: `${FETCH}: ${origin}; fetched ${fetched}`,
        sourceSha256: digest,
      },
    });
  };
  for (const id of ETF_SYMBOLS) {
    await add(id, "etf", `Yahoo daily bars ${id}, auto_adjust=False`);
  }
  for (const id of FUTURES) {
    await add(
      id,
      "future",
      `Yahoo daily bars ${id} (continuous future), auto_adjust=False`
    );
  }
  for (const id of INDICES) {
    await add(
      id,
      "index",
      CBOE_INDICES.has(id)
        ? `CBOE public history CSV ${id}_History.csv, daily close`
        : `Yahoo daily close ^${id}`
    );
  }
  const shillerDigest = await verified("SHILLER.csv");
  const tnx = imports.find(
    (entry) => entry.series.id === "TNX"
  ) as SeriesImport;
  imports.push({
    points: eyTnxRatio(
      parseShiller(texts.get("SHILLER.csv") as string),
      tnx.points
    ),
    series: {
      id: "EY_TNX_RATIO",
      kind: "derived",
      // Digest of the SHA256SUMS lines of both inputs.
      source: `${FETCH}: derived as data.ey_tnx_ratio, 100 * Shiller earnings / price (month - ${EARNINGS_LAG_MONTHS}) / TNX yield %; Shiller ie_data.xls (shillerdata.com) and Yahoo ^TNX; fetched ${fetched}`,
      sourceSha256: sha256(
        `${shillerDigest}  SHILLER.csv\n${tnx.series.sourceSha256}  TNX.csv\n`
      ),
    },
  });
  for (const entry of imports) {
    validateMarketDailySeries(entry.series, entry.points);
  }
  return imports;
};

const summary = (entry: SeriesImport): string =>
  JSON.stringify({
    first: entry.points[0]?.date,
    id: entry.series.id,
    kind: entry.series.kind,
    last: entry.points.at(-1)?.date,
    points: entry.points.length,
  });

export type CliIo = Readonly<{
  env: NodeJS.ProcessEnv;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}>;

const run = async (argv: readonly string[], io: CliIo): Promise<void> => {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const paths = argv.filter((arg) => !arg.startsWith("--"));
  if (flags.some((flag) => flag !== "--dry-run") || paths.length > 1) {
    throw new Error(USAGE);
  }
  const dryRun = flags.length > 0;
  const env = io.env[DATA_ENV];
  const dir =
    paths[0] ??
    (env === undefined || env === ""
      ? join(homedir(), "Documents", "reports", "vertex-qc-ports", "data")
      : env);
  const databaseUrl = io.env["DATABASE_URL"];
  if (!dryRun && (databaseUrl === undefined || databaseUrl === "")) {
    throw new Error("DATABASE_URL is required (or pass --dry-run)");
  }
  const imports = await loadSeriesImports(dir);
  const total = imports.reduce((sum, entry) => sum + entry.points.length, 0);
  if (dryRun) {
    for (const entry of imports) io.stdout.write(`${summary(entry)}\n`);
    io.stdout.write(
      `${JSON.stringify({ dryRun: true, points: total, series: imports.length })}\n`
    );
    return;
  }
  const resource = createNodeDatabase({
    connectionString: databaseUrl as string,
  });
  try {
    const repository = createMarketDailySeriesRepository(resource.db);
    for (const entry of imports) {
      await repository.replaceSeries(entry.series, entry.points);
      io.stdout.write(`${summary(entry)}\n`);
    }
    io.stdout.write(
      `${JSON.stringify({ dryRun: false, points: total, series: imports.length })}\n`
    );
  } finally {
    await resource.close();
  }
};

/** Runs the import and returns the process exit code (0 on success). */
export const runMarketSeriesImport = async (
  argv: readonly string[],
  io: CliIo
): Promise<number> => {
  try {
    await run(argv, io);
    return 0;
  } catch (error) {
    io.stderr.write(
      `market series import failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
