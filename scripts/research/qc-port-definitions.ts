// Generates migration 0059 (and its guarded rollback): the run A strategy definition of each of the
// 11 QuantConnect idea ports as revision 1 in strategy_definition_revisions, linked from the
// library rows of migration 0057 through fixed choice parameters. Research only.
//
// Usage:
//   bun scripts/research-qc-port-definitions.ts [--python <bin>] [--check]
//   bun scripts/research-qc-port-definitions.ts --input <definitions.json> --data-to <YYYY-MM-DD> [--check]
// Without --input it runs `python -m strategies.qc_ports definitions` in services/research
// (python: --python, else $VERTEX_NAUTILUS_PYTHON, else /tmp/qcp-nt-venv/bin/python) and reads
// the last SPY bar date (the study calendar's end) the same way. --check compares instead of
// writing and exits 1 when a committed file differs.
import { canonicalJson } from "../../packages/api/src/canonical-json.ts";
import { strategyDefinitionSha256 } from "../../packages/api/src/server/strategy-definitions.ts";
import { StrategyDefinitionSchema } from "../../packages/api/src/strategy-dsl.ts";

export const QC_PORT_IDEAS = [
  "qc-asset-class-trend",
  "qc-futures-trend-carry",
  "qc-gold-fed-model",
  "qc-iv-rank-gate",
  "qc-momentum-rotation",
  "qc-oil-predicts-equity",
  "qc-opex-week",
  "qc-regime-put-vrp",
  "qc-same-month-seasonality",
  "qc-turn-of-the-month",
  "qc-vix-term-gate",
] as const;

const INITIAL_CAPITAL = "100000";
const CREATED_BY = "migration:0059";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const ROOT = new URL("../../", import.meta.url);
export const MIGRATION_URL = new URL(
  "packages/db/migrations/0059_qc_port_definitions.sql",
  ROOT
);
export const ROLLBACK_URL = new URL(
  "packages/db/rollback/0059_qc_port_definitions.down.sql",
  ROOT
);
const RESEARCH_DIR = new URL("services/research/", ROOT).pathname;
const DEFAULT_PYTHON = "/tmp/qcp-nt-venv/bin/python";
const LAST_BAR_SCRIPT =
  "from strategies.qc_ports import data; print(data.load_bars('SPY').dates[-1])";
const USAGE =
  "usage: bun scripts/research-qc-port-definitions.ts [--input <definitions.json> --data-to <YYYY-MM-DD>] [--python <bin>] [--check]";

/** `python -m strategies.qc_ports definitions`: idea id -> run A. */
export type QcPortDefinitionsInput = Readonly<
  Record<string, Readonly<{ run: string; start: string; definition: unknown }>>
>;

export type QcPortRevision = Readonly<{
  idea: string;
  id: string;
  name: string;
  definitionJson: string;
  sha256: string;
  note: string;
  paramsJson: string;
}>;

const sqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const fixed = (name: string, title: string, value: string) => ({
  default: value,
  name,
  options: [value],
  title,
  type: "choice",
});

/** Parses, hashes and describes each idea's run A, sorted by idea id. */
export const qcPortRevisions = async (
  input: QcPortDefinitionsInput,
  dataTo: string
): Promise<QcPortRevision[]> => {
  if (!DATE_PATTERN.test(dataTo)) {
    throw new Error("data-to must be a YYYY-MM-DD date");
  }
  const ideas = Object.keys(input).sort();
  if (canonicalJson(ideas) !== canonicalJson(QC_PORT_IDEAS)) {
    throw new Error(
      `definitions must cover exactly ${QC_PORT_IDEAS.join(", ")}`
    );
  }
  const revisions: QcPortRevision[] = [];
  for (const idea of ideas) {
    const entry = input[idea] as QcPortDefinitionsInput[string];
    if (!(entry.run.endsWith("/A") && DATE_PATTERN.test(entry.start))) {
      throw new Error(`${idea}: expected run A with a YYYY-MM-DD start`);
    }
    const parsed = StrategyDefinitionSchema.safeParse(entry.definition);
    if (!parsed.success) {
      throw new Error(`${idea}: ${parsed.error.issues[0]?.message}`);
    }
    const sha256 = await strategyDefinitionSha256(parsed.data);
    revisions.push({
      definitionJson: canonicalJson(parsed.data),
      id: `qc-def-${idea}-r1`,
      idea,
      name: parsed.data.name,
      note: `Research run A of ${idea}: from ${entry.start}, capital ${INITIAL_CAPITAL}, data to ${dataTo} (research_studies ${idea})`,
      paramsJson: canonicalJson([
        fixed("definitionId", "Strategy definition", idea),
        fixed("definitionSha256", "Definition SHA-256", sha256),
        fixed("runFrom", "Run from", entry.start),
        fixed("initialCapital", "Initial capital", INITIAL_CAPITAL),
      ]),
      sha256,
    });
  }
  return revisions;
};

/** Migration 0059: the 11 revisions (never overwritten) and the library links (only on untouched params). */
export const renderMigration = (
  revisions: readonly QcPortRevision[]
): string => {
  const rows = revisions.map(
    (revision) =>
      `(${sqlText(revision.id)}, ${sqlText(revision.idea)}, 1, ${sqlText(revision.name)}, ${sqlText(revision.definitionJson)}::jsonb, ${sqlText(revision.sha256)}, ${sqlText(revision.note)}, ${sqlText(CREATED_BY)})`
  );
  const updates = revisions.map(
    (revision) =>
      `UPDATE "strategies" SET "params" = ${sqlText(revision.paramsJson)}::jsonb WHERE "id" = ${sqlText(`strategy-seed-${revision.idea}`)} AND "params" = '[]'::jsonb;`
  );
  return `${[
    [
      "-- Data: run A of the 11 QuantConnect idea ports (card vertex-qc-ports) as revision 1 of their strategy",
      "-- definitions, linked from the 0057 library rows by fixed parameters (definition id and SHA-256, run",
      "-- start, initial capital). Generated by `bun scripts/research-qc-port-definitions.ts` from",
      "-- `python -m strategies.qc_ports definitions`; regenerate, never edit. Research only. Existing",
      "-- revisions are never overwritten and library params are set only while still empty.",
      `INSERT INTO "strategy_definition_revisions" ("id", "definition_id", "revision", "name", "definition", "sha256", "note", "created_by") VALUES`,
      `${rows.join(",\n")}`,
      "ON CONFLICT DO NOTHING;",
    ].join("\n"),
    ...updates,
  ].join("\n--> statement-breakpoint\n")}\n`;
};

/** Guarded rollback: refuses on later revisions, other authors or changed library params. */
export const renderRollback = (
  revisions: readonly QcPortRevision[]
): string => {
  const list = (values: readonly string[]) => values.map(sqlText).join(", ");
  const definitionIds = list(revisions.map((revision) => revision.idea));
  const revisionIds = list(revisions.map((revision) => revision.id));
  const linked = revisions
    .map(
      (revision) =>
        `    (${sqlText(`strategy-seed-${revision.idea}`)}, ${sqlText(revision.paramsJson)}::jsonb)`
    )
    .join(",\n");
  return `${[
    "-- Guarded reversal of 0059_qc_port_definitions only. Generated with the migration by",
    "-- `bun scripts/research-qc-port-definitions.ts`.",
    "-- Refuses while any of the 11 definition ids has a revision other than the 0059 revision 1, a row",
    "-- created by someone else, or a library row whose params are neither empty nor what 0059 set.",
    "-- Otherwise deletes the 11 revisions and resets the linked params to []. Drizzle ledger",
    "-- reconciliation is deliberately not automated. Outside discoverable migrations.",
    "BEGIN;",
    "SET LOCAL search_path = pg_catalog, public;",
    "SET LOCAL row_security = off;",
    'LOCK TABLE "public"."strategy_definition_revisions", "public"."strategies" IN ACCESS EXCLUSIVE MODE;',
    "CREATE TEMP TABLE qc_port_links (id text PRIMARY KEY, params jsonb NOT NULL) ON COMMIT DROP;",
    "INSERT INTO qc_port_links (id, params) VALUES",
    `${linked};`,
    "DO $$",
    "BEGIN",
    "  IF EXISTS (",
    '    SELECT 1 FROM "public"."strategy_definition_revisions" r',
    `    WHERE r."definition_id" IN (${definitionIds})`,
    `      AND (r."id" NOT IN (${revisionIds}) OR r."revision" <> 1 OR r."created_by" <> ${sqlText(CREATED_BY)})`,
    "  ) THEN",
    "    RAISE EXCEPTION 'qc-port definitions have later revisions or rows by other authors; refusing rollback';",
    "  END IF;",
    "  IF EXISTS (",
    '    SELECT 1 FROM "public"."strategies" s JOIN qc_port_links l ON l.id = s."id"',
    `    WHERE s."params" <> '[]'::jsonb AND s."params" <> l.params`,
    "  ) THEN",
    "    RAISE EXCEPTION 'qc-port library params were changed after 0059; refusing rollback';",
    "  END IF;",
    "END",
    "$$;",
    `UPDATE "public"."strategies" s SET "params" = '[]'::jsonb FROM qc_port_links l WHERE l.id = s."id" AND s."params" = l.params;`,
    `DELETE FROM "public"."strategy_definition_revisions" WHERE "id" IN (${revisionIds});`,
    "COMMIT;",
  ].join("\n")}\n`;
};

export type Spawn = (
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv }>
) => Readonly<{ status: number | null; stdout: string; stderr: string }>;

export type CliIo = Readonly<{
  env: NodeJS.ProcessEnv;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  spawn: Spawn;
  readText: (url: URL | string) => Promise<string>;
  writeText: (url: URL, text: string) => Promise<void>;
}>;

const flagValue = (
  argv: readonly string[],
  flag: string
): string | undefined => {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
  return value;
};

const python = (io: CliIo, bin: string, args: readonly string[]): string => {
  const result = io.spawn(bin, args, {
    cwd: RESEARCH_DIR,
    env: { ...io.env, PYTHONPATH: "." },
  });
  if (result.status !== 0) {
    throw new Error(
      `${bin} ${args.join(" ")} exited with ${result.status}: ${result.stderr.trim()}`
    );
  }
  return result.stdout;
};

const run = async (argv: readonly string[], io: CliIo): Promise<number> => {
  const known = new Set(["--input", "--data-to", "--python", "--check"]);
  const flags = argv.filter((arg) => arg.startsWith("--"));
  if (flags.some((flag) => !known.has(flag))) throw new Error(USAGE);
  const inputPath = flagValue(argv, "--input");
  const check = argv.includes("--check");
  let input: string;
  let dataTo: string | undefined = flagValue(argv, "--data-to");
  if (inputPath === undefined) {
    const bin =
      flagValue(argv, "--python") ??
      io.env["VERTEX_NAUTILUS_PYTHON"] ??
      DEFAULT_PYTHON;
    input = python(io, bin, ["-m", "strategies.qc_ports", "definitions"]);
    dataTo ??= python(io, bin, ["-c", LAST_BAR_SCRIPT]).trim();
  } else {
    if (dataTo === undefined) throw new Error("--input needs --data-to");
    input = await io.readText(inputPath);
  }
  const revisions = await qcPortRevisions(
    JSON.parse(input) as QcPortDefinitionsInput,
    dataTo
  );
  const files: ReadonlyArray<readonly [URL, string]> = [
    [MIGRATION_URL, renderMigration(revisions)],
    [ROLLBACK_URL, renderRollback(revisions)],
  ];
  let stale = 0;
  for (const [url, text] of files) {
    if (!check) {
      await io.writeText(url, text);
      continue;
    }
    const committed = await io.readText(url).catch(() => "");
    if (committed !== text) {
      stale += 1;
      io.stderr.write(`${url.pathname} differs from the generator output\n`);
    }
  }
  for (const revision of revisions) {
    io.stdout.write(`${revision.idea} ${revision.sha256}\n`);
  }
  return stale === 0 ? 0 : 1;
};

/** Runs the generator and returns the process exit code. */
export const runQcPortDefinitions = async (
  argv: readonly string[],
  io: CliIo
): Promise<number> => {
  try {
    return await run(argv, io);
  } catch (error) {
    io.stderr.write(
      `qc-port definitions failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
