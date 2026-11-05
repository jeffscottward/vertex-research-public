// Records Quant Lab artifacts in the database: paper capture(s), frozen spec, backtest result.
// Usage: DATABASE_URL=postgres://... bun run vertex:quantlab:record -- \
//   --capture private/quantlab/captures/ssrn-N.json [--spec specs/X.json] [--result results/X.json]
//   or --search private/quantlab/captures/search-<stamp>.json (all captures of a scheduled search)
// --dry-run prints the rows without a database. Writes go through the Drizzle Quant Lab store
// (@darkfactory/db/server), are idempotent (content-hash ids) and run in one transaction.
// Research records only: nothing here places or routes orders.
import { readFile } from "node:fs/promises";

import { createNodeDatabase, recordQuantLab } from "@darkfactory/db/server";
import { z } from "zod";

import {
  backtestRow,
  captureRow,
  paperOutcome,
  paperRow,
  type QuantLabCapture,
  type QuantLabResult,
  type QuantLabSpec,
  quantLabCaptureSchema,
  quantLabResultSchema,
  quantLabSearchSchema,
  quantLabSpecSchema,
  resultContentHash,
  specRow,
  strategyIdFor,
  strategyRow,
  taskRow,
} from "./record-rows.ts";

export type CliIo = Readonly<{
  env: NodeJS.ProcessEnv;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}>;

/** A usage or input-consistency problem; the CLI exits with code 2. */
class UsageError extends Error {}

const option = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

/** Reads one input file and checks it against its schema; a mismatch is an input problem (exit 2). */
const readInput = async <S extends z.ZodType>(
  argv: readonly string[],
  flag: string,
  schema: S
): Promise<Readonly<{ raw: unknown; value: z.output<S> }> | undefined> => {
  const path = option(argv, flag);
  if (path === undefined) return undefined;
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `${flag} ${path} is not valid:\n${z.prettifyError(parsed.error)}`
    );
  }
  return { raw, value: parsed.data };
};

type Inputs = Readonly<{
  captures: readonly QuantLabCapture[];
  spec: QuantLabSpec | undefined;
  result: QuantLabResult | undefined;
}>;

const writeRecords = (
  databaseUrl: string,
  { captures, spec, result }: Inputs
): Promise<Record<string, unknown>> => {
  const resource = createNodeDatabase({ connectionString: databaseUrl });
  return recordQuantLab(resource.db, async (store) => {
    const summary: Record<string, unknown> = {};
    const paperIds = new Map<string, string>();
    // Keyed by DOI and version: a capture belongs to one version of the paper.
    const captureIds = new Map<string, string>();
    for (const capture of captures) {
      const paperId = await store.ensurePaper(paperRow(capture));
      paperIds.set(capture.doi, paperId);
      captureIds.set(
        `${capture.doi}|${capture.version}`,
        await store.ensureCapture(captureRow(capture, paperId))
      );
    }
    summary["papers"] = paperIds.size;
    if (spec === undefined) return summary;
    const paperId =
      paperIds.get(spec.paper.doi) ?? (await store.findPaperId(spec.paper.doi));
    if (paperId === null) {
      // A spec without its paper would stay unlinked; the transaction rolls back.
      throw new UsageError(
        `--spec paper ${spec.paper.doi} is not recorded; pass its --capture (or record it first)`
      );
    }
    const captureId =
      captureIds.get(`${spec.paper.doi}|${spec.paper.version}`) ??
      (await store.findCaptureId(spec.paper.doi, spec.paper.version));
    const strategyId = await store.upsertStrategy(
      strategyRow(spec, result === undefined ? "researching" : "backtested")
    );
    const row = specRow(spec, { captureId, paperId, strategyId });
    await store.ensureSpec(row);
    await store.advancePaperStage(paperId, "spec_extracted", [
      "queued",
      "ingested",
    ]);
    summary["spec"] = row.id;
    summary["strategy"] = strategyId;
    if (result === undefined) return summary;
    const recordedAt = new Date();
    const task = taskRow(spec, result, paperId);
    await store.ensureTask({
      ...task,
      finishedAt: recordedAt,
      startedAt: recordedAt,
    });
    const backtest = backtestRow(spec, result, {
      paperId,
      strategyId,
      taskId: task.id,
    });
    await store.ensureBacktest(backtest);
    await store.setPaperOutcome(paperId, paperOutcome(result));
    summary["task"] = task.id;
    summary["backtest"] = backtest.id;
    summary["verdict"] = result.verdict;
    return summary;
  }).finally(() => resource.close());
};

const dryRunRows = ({ captures, spec, result }: Inputs): string => {
  const strategyId = spec === undefined ? null : strategyIdFor(spec);
  return JSON.stringify(
    {
      backtest:
        spec === undefined || result === undefined || strategyId === null
          ? null
          : {
              ...backtestRow(spec, result, {
                paperId: null,
                strategyId,
                taskId: taskRow(spec, result, null).id,
              }),
              drawdown: "…",
              equity: "…",
              trades: "…",
            },
      captures: captures.map((capture) =>
        captureRow(capture, paperRow(capture).id)
      ),
      papers: captures.map(paperRow),
      spec:
        spec === undefined || strategyId === null
          ? null
          : specRow(spec, { captureId: null, paperId: null, strategyId }),
      strategy:
        spec === undefined
          ? null
          : strategyRow(
              spec,
              result === undefined ? "researching" : "backtested"
            ),
    },
    null,
    2
  );
};

const run = async (
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<string> => {
  const search = (await readInput(argv, "--search", quantLabSearchSchema))
    ?.value;
  const single = (await readInput(argv, "--capture", quantLabCaptureSchema))
    ?.value;
  const spec = (await readInput(argv, "--spec", quantLabSpecSchema))?.value;
  const resultInput = await readInput(argv, "--result", quantLabResultSchema);
  const result: QuantLabResult | undefined =
    resultInput === undefined
      ? undefined
      : {
          ...resultInput.value,
          contentHash: resultContentHash(resultInput.raw),
        };
  const captures = [
    ...(search?.captures ?? []),
    ...(single === undefined ? [] : [single]),
  ];
  if (search !== undefined && captures.length === 0 && spec === undefined) {
    return JSON.stringify({ note: "search returned no captures", papers: 0 });
  }
  if (captures.length === 0 && spec === undefined) {
    throw new UsageError("pass --capture, --search and/or --spec [--result]");
  }
  if (
    result !== undefined &&
    (spec === undefined || result.specSha256 !== spec.spec_sha256)
  ) {
    throw new UsageError(
      "--result needs the --spec it was produced from (spec_sha256 mismatch)"
    );
  }
  if (
    spec !== undefined &&
    single !== undefined &&
    spec.paper.doi !== single.doi
  ) {
    throw new UsageError("--spec belongs to a different paper than --capture");
  }
  const inputs = { captures, result, spec };
  if (argv.includes("--dry-run")) return dryRunRows(inputs);
  const databaseUrl = env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new UsageError("DATABASE_URL is required (or pass --dry-run)");
  }
  return JSON.stringify(await writeRecords(databaseUrl, inputs));
};

/** Runs the recorder and returns the process exit code: 0 ok, 2 usage error, 1 other failure. */
export const runQuantLabRecord = async (
  argv: readonly string[],
  io: CliIo
): Promise<number> => {
  try {
    io.stdout.write(`${await run(argv, io.env)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n`);
      return 2;
    }
    io.stderr.write(
      `quant lab record failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
