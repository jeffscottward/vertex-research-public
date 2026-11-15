// Stores one play (an option trade idea) in Postgres (plays), read by plays.list on /plays.
// Usage: <play document on stdin> | DATABASE_URL=postgres://... bun run vertex:plays:upsert [--dry-run]
// The document is one JSON object with the PlaySchema fields (@darkfactory/api) except definedRisk,
// createdAt and updatedAt. It is upserted by id through the Drizzle plays repository, which applies
// the defined-risk rules: a new id adds a play, a known id replaces it. Real plays are piped in on the
// server only and never committed (docs/plays.md). --dry-run checks the document without a database.
// Ideas only: nothing here places, stages or sizes an order.
import { PlaySchema } from "@darkfactory/api";
import {
  createNodeDatabase,
  createPlaysRepository,
  InvalidRepositoryInputError,
  normalizePlayInput,
  type PlayRecord,
  type PlaysRepository,
} from "@darkfactory/db/server";
import { z } from "zod";

export const PLAYS_UPSERT_USAGE =
  "Usage: <play document on stdin> | DATABASE_URL=postgres://... bun run vertex:plays:upsert [--dry-run]";

/** Largest stdin accepted, before parsing. */
export const PLAY_INPUT_MAX_BYTES = 65_536;

export const PlayInputSchema = PlaySchema.omit({
  definedRisk: true,
  createdAt: true,
  updatedAt: true,
});
export type PlayInput = z.infer<typeof PlayInputSchema>;

export type CliIo = Readonly<{
  env: NodeJS.ProcessEnv;
  stdin: AsyncIterable<Uint8Array | string>;
  /** True when stdin is a terminal (nothing piped in): print the usage instead of waiting. */
  stdinIsTTY?: boolean | undefined;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}>;

export type PlayStore = Readonly<{
  close: () => Promise<void>;
  upsert: PlaysRepository["upsert"];
}>;

/** Test seam: opens the plays store for a database URL. */
export type OpenPlayStore = (databaseUrl: string) => PlayStore;

export const openPlayStore: OpenPlayStore = (databaseUrl) => {
  const resource = createNodeDatabase({ connectionString: databaseUrl });
  return {
    close: () => resource.close(),
    upsert: createPlaysRepository(resource.db).upsert,
  };
};

/** A usage or input problem; the CLI exits with code 2. */
class UsageError extends Error {}

const readInput = async (stdin: CliIo["stdin"]): Promise<string> => {
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of stdin) {
      const part =
        typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
      bytes += part.byteLength;
      if (bytes > PLAY_INPUT_MAX_BYTES) {
        throw new UsageError(
          `stdin is larger than ${PLAY_INPUT_MAX_BYTES} bytes`
        );
      }
      text += decoder.decode(part, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    // TextDecoder with fatal: true throws TypeError on bytes that are not UTF-8.
    if (error instanceof TypeError)
      throw new UsageError("stdin is not UTF-8 text");
    throw error;
  }
};

/** Parses and checks one play document; every problem is an input error (exit 2). */
export const parsePlayDocument = (text: string): PlayInput => {
  if (text.trim().length === 0) {
    throw new UsageError(`No play document on stdin.\n${PLAYS_UPSERT_USAGE}`);
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
  const parsed = PlayInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `The play document is not valid:\n${z.prettifyError(parsed.error)}`
    );
  }
  // The repository's own rules (ticker, text, covered shorts, https source), so --dry-run checks
  // exactly what the real write checks.
  normalizePlayInput(parsed.data);
  return parsed.data;
};

const run = async (
  argv: readonly string[],
  io: CliIo,
  open: OpenPlayStore
): Promise<string> => {
  const unknown = argv.filter((argument) => argument !== "--dry-run");
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown argument ${unknown[0]}.\n${PLAYS_UPSERT_USAGE}`
    );
  }
  const play = parsePlayDocument(await readInput(io.stdin));
  if (argv.includes("--dry-run"))
    return JSON.stringify({ id: play.id, ticker: play.ticker, dryRun: true });
  const databaseUrl = io.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new UsageError("DATABASE_URL is required (or pass --dry-run)");
  }
  const store = open(databaseUrl);
  let stored: PlayRecord;
  try {
    stored = await store.upsert(play);
  } finally {
    // A failed close must not hide the write's own result or error.
    await store.close().catch((error: unknown) => {
      io.stderr.write(
        `warning: closing the database connection failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
    });
  }
  return JSON.stringify({
    id: stored.id,
    ticker: stored.ticker,
    maxLossUsd: stored.maxLossUsd,
    status: stored.status,
    updatedAt: stored.updatedAt.toISOString(),
  });
};

/** Runs the upsert and returns the process exit code: 0 ok, 2 usage or input error, 1 other failure. */
export const runPlaysUpsert = async (
  argv: readonly string[],
  io: CliIo,
  open: OpenPlayStore = openPlayStore
): Promise<number> => {
  if (argv.includes("--help")) {
    io.stdout.write(`${PLAYS_UPSERT_USAGE}\n`);
    return 0;
  }
  if (io.stdinIsTTY === true) {
    io.stderr.write(`No play document on stdin.\n${PLAYS_UPSERT_USAGE}\n`);
    return 2;
  }
  try {
    io.stdout.write(`${await run(argv, io, open)}\n`);
    return 0;
  } catch (error) {
    // The repository rejected the play: an input problem, like a schema failure.
    if (
      error instanceof UsageError ||
      error instanceof InvalidRepositoryInputError
    ) {
      io.stderr.write(`${error.message}\n`);
      return 2;
    }
    io.stderr.write(
      `play upsert failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
