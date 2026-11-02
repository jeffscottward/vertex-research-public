// Paper agent desk CLI. Paper/dry-run only: this command never places, previews or modifies orders.
//
//   bun run agent-desk -- --data-root <workspace>/data --tickers AAPL,NVDA [--as-of YYYY-MM-DD] [--json] [--write]
//
// Without --write it prints the run and saves nothing. With --write it saves the paper journal to
// private/agent-desk/paper-book.json and the run report to private/agent-desk/runs/<as-of>.json
// (the private/ folder is ignored by Git). Files are 0600 in 0700 folders.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertWritable,
  emptyBook,
  MAX_TICKERS,
  PaperBook,
  renderSummary,
  runDesk,
} from "./desk.ts";
import { readDeskInputs } from "./reports.ts";
import { isCalendarDay } from "./technical.ts";

export type DeskArgs = Readonly<{
  dataRoot: string;
  tickers: readonly string[];
  asOf: string;
  book: string;
  sentimentDir: string;
  json: boolean;
  write: boolean;
}>;

const VALUE_FLAGS: Readonly<Record<string, true>> = {
  "--as-of": true,
  "--book": true,
  "--data-root": true,
  "--sentiment-dir": true,
  "--tickers": true,
};
const SWITCHES: Readonly<Record<string, true>> = {
  "--json": true,
  "--write": true,
};

const readFlags = (argv: readonly string[]): Map<string, string> => {
  const flags = new Map<string, string>();
  const queue = [...argv];
  for (
    let argument = queue.shift();
    argument !== undefined;
    argument = queue.shift()
  ) {
    const split = argument.indexOf("=");
    const flag = split < 0 ? argument : argument.slice(0, split);
    if (flags.has(flag)) throw new TypeError(`Argument ${flag} is repeated`);
    if (SWITCHES[flag] === true && split < 0) {
      flags.set(flag, "true");
      continue;
    }
    if (VALUE_FLAGS[flag] !== true)
      throw new TypeError(`Unknown argument ${argument}`);
    const value = split < 0 ? queue.shift() : argument.slice(split + 1);
    if (value === undefined || value === "" || value.startsWith("--"))
      throw new TypeError(`${flag} needs a value`);
    flags.set(flag, value);
  }
  return flags;
};

/** Parses the CLI arguments. `root` is the repository root used for the default private paths. */
export const parseArgs = (
  argv: readonly string[],
  root: string,
  today: string
): DeskArgs => {
  const flags = readFlags(argv);
  const tickers = (flags.get("--tickers") ?? "")
    .split(",")
    .map((ticker) => ticker.trim().toUpperCase())
    .filter(Boolean);
  if (tickers.length === 0 || tickers.length > MAX_TICKERS)
    throw new TypeError(`--tickers needs 1-${MAX_TICKERS} report IDs`);
  if (new Set(tickers).size !== tickers.length)
    throw new TypeError("--tickers contains duplicates");
  const asOf = flags.get("--as-of") ?? today;
  if (!isCalendarDay(asOf))
    throw new TypeError("--as-of must be a real YYYY-MM-DD date");
  const dataRoot = flags.get("--data-root");
  if (dataRoot === undefined)
    throw new TypeError("--data-root is required (the Workspace data/ folder)");
  return {
    asOf,
    book: resolve(
      flags.get("--book") ??
        join(root, "private", "agent-desk", "paper-book.json")
    ),
    dataRoot: resolve(dataRoot),
    json: flags.has("--json"),
    sentimentDir: resolve(
      flags.get("--sentiment-dir") ??
        join(root, "private", "agent-desk", "sentiment")
    ),
    tickers,
    write: flags.has("--write"),
  };
};

const readBook = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return emptyBook();
    throw error;
  }
};

/** Writes JSON through a 0600 temporary file and a rename; the temporary file never remains. */
export const writeJsonAtomic = async (
  path: string,
  value: unknown
): Promise<void> => {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporary = join(dirname(path), `.agent-desk-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

/** Holds an exclusive lock file beside the paper book while `task` runs. */
const withBookLock = async <T>(
  bookPath: string,
  task: () => Promise<T>
): Promise<T> => {
  await mkdir(dirname(bookPath), { mode: 0o700, recursive: true });
  const lockPath = `${bookPath}.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
    throw error instanceof Error && "code" in error && error.code === "EEXIST"
      ? new TypeError(
          `Another desk run holds ${lockPath}; delete it only if no desk run is active`
        )
      : error;
  });
  try {
    return await task();
  } finally {
    try {
      await lock.close();
    } finally {
      await unlink(lockPath);
    }
  }
};

type Output = Readonly<{ write: (text: string) => unknown }>;

const execute = async (args: DeskArgs, stdout: Output, today: string) => {
  const reports = await readDeskInputs(args);
  const book = PaperBook.parse(await readBook(args.book));
  if (args.write) assertWritable(book, args.asOf, today);
  const run = runDesk({ asOf: args.asOf, book, reports });
  stdout.write(
    `${args.json ? JSON.stringify(run.report, null, 2) : renderSummary(run.report)}\n`
  );
  if (!args.write) {
    stdout.write(
      "Dry run: nothing saved. Add --write to update the paper journal.\n"
    );
    return run.report;
  }
  await writeJsonAtomic(
    join(dirname(args.book), "runs", `${args.asOf}.json`),
    run.report
  );
  await writeJsonAtomic(args.book, run.book);
  stdout.write(`Saved paper book ${args.book}\n`);
  return run.report;
};

/** Runs the CLI and returns the process exit code. Errors are reported as one line on stderr. */
export const runAgentDeskCli = async (
  argv: readonly string[],
  io: Readonly<{ stdout: Output; stderr: Output; root: string; now: Date }>
): Promise<number> => {
  const today = io.now.toISOString().slice(0, 10);
  try {
    const args = parseArgs(argv, io.root, today);
    await (args.write
      ? withBookLock(args.book, () => execute(args, io.stdout, today))
      : execute(args, io.stdout, today));
    return 0;
  } catch (error) {
    io.stderr.write(`agent-desk: ${String(error)}\n`);
    return 1;
  }
};
