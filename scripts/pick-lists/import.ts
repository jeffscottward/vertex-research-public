// Pick-list importer (research only, no orders). Loads dated pick-list snapshots through a source
// adapter and stores each with pickLists.import, using an operator agent WRITE key.
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... \
//   bun run vertex:pick-lists -- import --adapter json|wishlist --file <path> [--as-of YYYY-MM-DD] [--dry-run]
// json: { source, sourceLabel, lists: [{ slug, name, asOf?, members }] } or one pickLists.import
// body. wishlist: the owner's wish-list TOML ([[symbol]] tables; enabled symbols only). --as-of is
// the snapshot date for the wish list (default: today in New York) and the fallback for JSON lists
// without one. --dry-run prints the validated snapshots and sends nothing. The key is never printed.
// Exit codes: 0 success, 2 usage error, 1 any other failure.
import { parseArgs } from "node:util";

import {
  createPickListSourceRegistry,
  jsonFileSource,
  type PickListImportInput,
  wishlistTomlSource,
} from "@darkfactory/api";
import { z } from "zod";

export type PickListImportIo = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  post: (url: string, init: RequestInit) => Promise<Response>;
  readText: (path: string) => Promise<string>;
  parseToml: (text: string) => unknown;
  /** Today's market date (YYYY-MM-DD). */
  today: () => string;
  stdout: Readonly<{ write: (text: string) => unknown }>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
}>;

/** Bun's built-in TOML parser, reached without Bun type declarations. */
export const parseTomlWithBun = (
  text: string,
  runtime: unknown = Reflect.get(globalThis, "Bun")
): unknown => {
  const toml: unknown =
    typeof runtime === "object" && runtime !== null
      ? Reflect.get(runtime, "TOML")
      : undefined;
  const parse: unknown =
    typeof toml === "object" && toml !== null
      ? Reflect.get(toml, "parse")
      : undefined;
  if (typeof parse !== "function")
    throw new Error("Reading TOML needs the Bun runtime");
  return Reflect.apply(parse, toml, [text]) as unknown;
};

/** The New York calendar date (YYYY-MM-DD) of `now`. */
export const newYorkDate = (now: Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
    now
  );

class UsageError extends Error {}

const USAGE =
  "usage: vertex:pick-lists -- import --adapter json|wishlist --file <path> [--as-of YYYY-MM-DD] [--dry-run]";

const EnvelopeSchema = z.object({ json: z.unknown().optional() });
const ImportedSchema = z.object({
  source: z.string(),
  slug: z.string(),
  snapshotCount: z.number(),
  latest: z.object({ asOf: z.string(), members: z.array(z.unknown()) }),
});

type ImportArgs = Readonly<{
  adapter: string;
  file: string;
  asOf: string | undefined;
  dryRun: boolean;
}>;

const parseImportArgs = (argv: readonly string[]): ImportArgs => {
  const parse = () => {
    try {
      return parseArgs({
        // A literal "--" from the package script runner is not an argument.
        args: argv[0] === "--" ? argv.slice(1) : [...argv],
        allowPositionals: true,
        strict: true,
        options: {
          adapter: { type: "string" },
          "as-of": { type: "string" },
          "dry-run": { type: "boolean" },
          file: { type: "string" },
        },
      });
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
  };
  const { positionals, values } = parse();
  if (positionals.length !== 1 || positionals[0] !== "import")
    throw new UsageError("the only command is import");
  if (values.adapter === undefined)
    throw new UsageError("--adapter is required");
  if (values.file === undefined) throw new UsageError("--file is required");
  return {
    adapter: values.adapter,
    file: values.file,
    asOf: values["as-of"],
    dryRun: values["dry-run"] === true,
  };
};

const required = (
  env: PickListImportIo["env"],
  name: "VERTEX_ORIGIN" | "VERTEX_AGENT_API_KEY"
): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required`);
  return value;
};

const loadSnapshots = async (
  io: PickListImportIo,
  args: ImportArgs
): Promise<PickListImportInput[]> => {
  const registry = createPickListSourceRegistry([
    jsonFileSource({
      id: "json",
      label: "JSON file",
      read: () => io.readText(args.file),
      ...(args.asOf === undefined ? {} : { asOf: args.asOf }),
    }),
    wishlistTomlSource({
      read: async () => io.parseToml(await io.readText(args.file)),
      asOf: args.asOf ?? io.today(),
    }),
  ]);
  const source = registry.get(args.adapter);
  if (source === null)
    throw new UsageError(
      `--adapter must be one of: ${registry.ids().join(", ")}`
    );
  const snapshots = await source.load();
  if (snapshots.length === 0) throw new Error("the file holds no pick lists");
  return snapshots;
};

const importOne = async (
  io: PickListImportIo,
  origin: string,
  apiKey: string,
  snapshot: PickListImportInput
): Promise<string> => {
  const response = await io.post(`${origin}/api/orpc/pickLists/import`, {
    body: JSON.stringify({ json: snapshot }),
    headers: {
      "content-type": "application/json",
      origin,
      "x-api-key": apiKey,
    },
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `pickLists.import returned HTTP ${response.status} for ${snapshot.source}/${snapshot.list.slug}: ${text.slice(0, 300)}`
    );
  const stored = ImportedSchema.parse(
    EnvelopeSchema.parse(JSON.parse(text)).json
  );
  return `imported ${stored.source}/${stored.slug} as of ${stored.latest.asOf}: ${stored.latest.members.length} members (${stored.snapshotCount} snapshots)`;
};

/** Runs one import and returns the process exit code. */
export const runPickListImport = async (
  io: PickListImportIo
): Promise<number> => {
  try {
    const args = parseImportArgs(io.argv);
    const snapshots = await loadSnapshots(io, args);
    if (args.dryRun) {
      io.stdout.write(`${JSON.stringify(snapshots, null, 2)}\n`);
      return 0;
    }
    const origin = new URL(required(io.env, "VERTEX_ORIGIN")).origin;
    const apiKey = required(io.env, "VERTEX_AGENT_API_KEY");
    for (const snapshot of snapshots)
      io.stdout.write(`${await importOne(io, origin, apiKey, snapshot)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n${USAGE}\n`);
      return 2;
    }
    io.stderr.write(
      `pick list import failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
