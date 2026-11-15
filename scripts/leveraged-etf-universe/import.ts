// Stores the leveraged ETF universe in Postgres (leveraged_etf_universe, one row per fund).
// Usage:
//   <universe document on stdin> | DATABASE_URL=postgres://... bun run vertex:leveraged-etf-universe:import
//   bun run vertex:leveraged-etf-universe:import --dry-run < document.json
// stdin holds one JSON document (pretty-printed or not) of schema `leveraged-etf-universe-v1`,
// at most 2 MiB. The document is checked with LeveragedEtfUniverseDocumentSchema (document.ts);
// nothing is stored unless it is valid. The import then makes the table equal to the document in
// one database transaction: it upserts every fund and deletes every fund that is not in the
// document. The database refuses a document that is older than the stored universe. The CLI
// refuses a document whose `generatedAt` is more than 5 minutes after the current time: stored,
// it would make every real document "older than the stored universe". It also refuses a document
// whose `generatedAt` is more than 24 hours before the current time: the gate labels describe the
// option market of that time, and no reader of the table is forced to look at `generated_at`.
// Output: one JSON line with the fund count, the count of each option gate label and, after a
// write, the rows upserted and deleted. --dry-run checks the document and prints the counts
// without a database.
// Exit codes: 0 success, 2 usage or input problem, 1 any other failure.
// Research records only: nothing here places or routes orders.
import {
  createLeveragedEtfUniverseRepository,
  createNodeDatabase,
  InvalidRepositoryInputError,
  type LeveragedEtfUniverseRepository,
} from "@darkfactory/db/server";
import { z } from "zod";

import {
  LEVERAGED_ETF_OPTION_GATES,
  type LeveragedEtfUniverseDocument,
  LeveragedEtfUniverseDocumentSchema,
} from "./document.ts";

export const LEVERAGED_ETF_UNIVERSE_IMPORT_USAGE =
  "Usage: <leveraged-etf-universe-v1 document on stdin> | DATABASE_URL=postgres://... bun run vertex:leveraged-etf-universe:import [--dry-run]";

/** Largest stdin accepted, before parsing: 2 MiB. */
export const LEVERAGED_ETF_UNIVERSE_INPUT_MAX_BYTES = 2_097_152;

/** `generatedAt` may be this much after the clock of the import: two machines, two clocks. */
const GENERATED_AT_MAX_AHEAD_MS = 300_000;
/** A document whose `generatedAt` is more than this before the clock of the import is refused. */
const GENERATED_AT_MAX_AGE_MS = 86_400_000;

export type CliIo = Readonly<{
  env: NodeJS.ProcessEnv;
  stdin: AsyncIterable<Uint8Array | string>;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}>;

export type LeveragedEtfUniverseStore = Readonly<{
  close: () => Promise<void>;
  replaceUniverse: LeveragedEtfUniverseRepository["replaceUniverse"];
}>;

/** Test seam: opens the universe store for a database URL. */
export type OpenLeveragedEtfUniverseStore = (
  databaseUrl: string
) => LeveragedEtfUniverseStore;

/** The store of the real database. Nothing connects before the first statement. */
const openLeveragedEtfUniverseStore: OpenLeveragedEtfUniverseStore = (
  databaseUrl
) => {
  const resource = createNodeDatabase({ connectionString: databaseUrl });
  return {
    close: () => resource.close(),
    replaceUniverse: createLeveragedEtfUniverseRepository(resource.db)
      .replaceUniverse,
  };
};

/** A usage or input problem; the CLI exits with code 2. */
class UsageError extends Error {}

const readInput = async (stdin: CliIo["stdin"]): Promise<string> => {
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const part =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    bytes += part.byteLength;
    if (bytes > LEVERAGED_ETF_UNIVERSE_INPUT_MAX_BYTES) {
      throw new UsageError(
        `stdin is larger than ${LEVERAGED_ETF_UNIVERSE_INPUT_MAX_BYTES} bytes`
      );
    }
    parts.push(part);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(parts)
    );
  } catch {
    throw new UsageError("stdin is not UTF-8 text");
  }
};

/** Parses and checks the universe document on stdin. Every problem is a usage error (exit 2). */
export const parseUniverseDocument = (
  text: string
): LeveragedEtfUniverseDocument => {
  if (text.trim().length === 0) {
    throw new UsageError(
      `No universe document on stdin.\n${LEVERAGED_ETF_UNIVERSE_IMPORT_USAGE}`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // JSON.parse throws only SyntaxError.
    throw new UsageError(
      `stdin is not one JSON document: ${(error as SyntaxError).message}`
    );
  }
  const parsed = LeveragedEtfUniverseDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `The universe document is not valid:\n${z.prettifyError(parsed.error)}`
    );
  }
  return parsed.data;
};

const run = async (
  argv: readonly string[],
  io: CliIo,
  open: OpenLeveragedEtfUniverseStore,
  now: () => Date
): Promise<void> => {
  const unknown = argv.filter((argument) => argument !== "--dry-run");
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown argument ${unknown[0]}.\n${LEVERAGED_ETF_UNIVERSE_IMPORT_USAGE}`
    );
  }
  const document = parseUniverseDocument(await readInput(io.stdin));
  const current = now();
  const ahead = Date.parse(document.generatedAt) - current.getTime();
  if (ahead > GENERATED_AT_MAX_AHEAD_MS || -ahead > GENERATED_AT_MAX_AGE_MS) {
    const limit =
      ahead > 0 ? "more than 5 minutes after" : "more than 24 hours before";
    throw new UsageError(
      `The universe document is generated at ${document.generatedAt}. That is ${limit} the current time ${current.toISOString()}, so it is refused.`
    );
  }
  const counts = {
    generatedAt: document.generatedAt,
    funds: document.funds.length,
    ...Object.fromEntries(
      LEVERAGED_ETF_OPTION_GATES.map((gate) => [
        gate,
        document.funds.filter((fund) => fund.optionGate === gate).length,
      ])
    ),
  };
  if (argv.includes("--dry-run")) {
    io.stdout.write(`${JSON.stringify({ dryRun: true, ...counts })}\n`);
    return;
  }
  const databaseUrl = io.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new UsageError("DATABASE_URL is required (or pass --dry-run)");
  }
  const store = open(databaseUrl);
  try {
    // One transaction; the result line is printed only after it commits.
    const { deleted, upserted } = await store.replaceUniverse(document);
    io.stdout.write(`${JSON.stringify({ ...counts, upserted, deleted })}\n`);
  } finally {
    await store.close();
  }
};

/**
 * Runs the importer and returns the process exit code: 0 ok, 2 usage or input error, 1 other
 * failure. `open` and `now` are test seams: the store and the clock.
 */
export const runLeveragedEtfUniverseImport = async (
  argv: readonly string[],
  io: CliIo,
  open: OpenLeveragedEtfUniverseStore = openLeveragedEtfUniverseStore,
  now: () => Date = () => new Date()
): Promise<number> => {
  if (argv.includes("--help")) {
    io.stdout.write(`${LEVERAGED_ETF_UNIVERSE_IMPORT_USAGE}\n`);
    return 0;
  }
  try {
    await run(argv, io, open, now);
    return 0;
  } catch (error) {
    // The database refused the document (a check, or a document older than the stored universe):
    // an input problem, like a schema failure.
    if (
      error instanceof UsageError ||
      error instanceof InvalidRepositoryInputError
    ) {
      io.stderr.write(`${error.message}\n`);
      return 2;
    }
    io.stderr.write(
      `leveraged ETF universe import failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
