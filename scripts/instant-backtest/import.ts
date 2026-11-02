// Imports one stored bar series for the instant backtest page.
// Usage: DATABASE_URL=... bun run vertex:bars:import -- <bars.csv> <manifest.json>
// bars.csv: header `t,o,h,l,c,v`, t in epoch milliseconds, ascending; v may be empty.
// manifest.json: { symbol, timeframe, source, sourceSha256, normalizedSha256 } where
// normalizedSha256 is the SHA-256 of bars.csv. The import replaces the whole series in one
// transaction. It writes research data only; nothing here connects to a broker.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createMarketBarsRepository,
  createNodeDatabase,
  type MarketBarRow,
  type MarketBarSeriesInput,
} from "@darkfactory/db/server";

const HEADER = "t,o,h,l,c,v";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const parseBars = (text: string): MarketBarRow[] => {
  const lines = text.trim().split("\n");
  if (lines[0]?.trim() !== HEADER) {
    throw new Error(`bars file must start with the header ${HEADER}`);
  }
  return lines.slice(1).map((line, index) => {
    const fields = line.trim().split(",");
    const numbers = fields.slice(0, 5).map(Number);
    if (
      fields.length !== 6 ||
      numbers.some((value) => !Number.isFinite(value))
    ) {
      throw new Error(`bars line ${index + 2} must have 6 numeric fields`);
    }
    const [t, o, h, l, c] = numbers as [number, number, number, number, number];
    const volume = fields[5] === "" ? null : Number(fields[5]);
    return { t, o, h, l, c, v: volume };
  });
};

const parseManifest = (
  text: string
): MarketBarSeriesInput & { normalizedSha256: string } => {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const field = (name: string): string => {
    const value = raw[name];
    if (typeof value !== "string") {
      throw new Error(`manifest field ${name} must be a string`);
    }
    return value;
  };
  const timeframe = field("timeframe");
  if (timeframe !== "1d" && timeframe !== "1m") {
    throw new Error("manifest timeframe must be 1d or 1m");
  }
  const normalizedSha256 = field("normalizedSha256");
  if (!SHA256_PATTERN.test(normalizedSha256)) {
    throw new Error("manifest normalizedSha256 must be 64 hex characters");
  }
  return {
    symbol: field("symbol"),
    timeframe,
    source: field("source"),
    sourceSha256: field("sourceSha256"),
    normalizedSha256,
  };
};

const run = async (
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<string> => {
  const [barsPath, manifestPath] = argv;
  if (barsPath === undefined || manifestPath === undefined) {
    throw new Error(
      "usage: bun run vertex:bars:import -- <bars.csv> <manifest.json>"
    );
  }
  const databaseUrl = env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("DATABASE_URL is required");
  }
  const barsText = await readFile(barsPath, "utf8");
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));
  const actualSha256 = createHash("sha256").update(barsText).digest("hex");
  if (actualSha256 !== manifest.normalizedSha256) {
    throw new Error(
      "bars file SHA-256 does not match manifest normalizedSha256"
    );
  }
  const bars = parseBars(barsText);
  const resource = createNodeDatabase({ connectionString: databaseUrl });
  try {
    const series = await createMarketBarsRepository(resource.db).replaceSeries(
      {
        symbol: manifest.symbol,
        timeframe: manifest.timeframe,
        source: manifest.source,
        sourceSha256: manifest.sourceSha256,
      },
      bars
    );
    return JSON.stringify({
      id: series.id,
      barCount: series.barCount,
      firstT: series.firstT,
      lastT: series.lastT,
    });
  } finally {
    await resource.close();
  }
};

export type CliIo = Readonly<{
  env: NodeJS.ProcessEnv;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}>;

/** Runs the import and returns the process exit code (0 on success). */
export const runMarketBarsImport = async (
  argv: readonly string[],
  io: CliIo
): Promise<number> => {
  try {
    io.stdout.write(`${await run(argv, io.env)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `market bars import failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
