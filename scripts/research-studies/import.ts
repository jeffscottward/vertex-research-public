// Stores one research study document in Postgres (research_studies), read by researchStudies.get.
// Usage (from services/research):
//   python -m strategies.filter_study_summary --daily <adx_filter_run output> \
//     --intraday <rvol_intraday output> --ran 2026-10-31 \
//   | DATABASE_URL=postgres://... bun run vertex:research-studies:import
// The document comes on stdin, is checked with FilterStudySchema (@darkfactory/api) and is upserted by
// id through the Drizzle research study repository: a new id adds a study, a known id replaces it.
// --dry-run checks the document and prints what would be stored, without a database.
// Research records only: nothing here places or routes orders.
import {
  type FilterStudy,
  FilterStudySchema,
  RESEARCH_STUDY_SUMMARY_MAX_BYTES,
} from "@darkfactory/api";
import {
  createNodeDatabase,
  createResearchStudyRepository,
  InvalidRepositoryInputError,
  type ResearchStudyRepository,
} from "@darkfactory/db/server";
import { z } from "zod";

export const RESEARCH_STUDIES_IMPORT_USAGE = [
  "Usage: <study document on stdin> | DATABASE_URL=postgres://... bun run vertex:research-studies:import [--dry-run]",
  "The study document is the output of services/research/strategies/filter_study_summary.py.",
].join("\n");

/** Largest stdin accepted, before parsing. The stored document has its own, smaller cap. */
export const RESEARCH_STUDY_INPUT_MAX_BYTES = 1_048_576;

export type CliIo = Readonly<{
  env: NodeJS.ProcessEnv;
  stdin: AsyncIterable<Uint8Array | string>;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}>;

export type ResearchStudyStore = Readonly<{
  close: () => Promise<void>;
  upsert: ResearchStudyRepository["upsert"];
}>;

/** Test seam: opens the study store for a database URL. */
export type OpenResearchStudyStore = (
  databaseUrl: string
) => ResearchStudyStore;

export const openResearchStudyStore: OpenResearchStudyStore = (databaseUrl) => {
  const resource = createNodeDatabase({ connectionString: databaseUrl });
  return {
    close: () => resource.close(),
    upsert: createResearchStudyRepository(resource.db).upsert,
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
    if (bytes > RESEARCH_STUDY_INPUT_MAX_BYTES) {
      throw new UsageError(
        `stdin is larger than ${RESEARCH_STUDY_INPUT_MAX_BYTES} bytes`
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

/** Parses and checks one study document; every problem is a usage error (exit 2). */
export const parseStudyDocument = (text: string): FilterStudy => {
  if (text.trim().length === 0) {
    throw new UsageError(
      `No study document on stdin.\n${RESEARCH_STUDIES_IMPORT_USAGE}`
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
  const parsed = FilterStudySchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `The study document is not valid:\n${z.prettifyError(parsed.error)}`
    );
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify(parsed.data)
  ).byteLength;
  if (bytes > RESEARCH_STUDY_SUMMARY_MAX_BYTES) {
    throw new UsageError(
      `The study document is ${bytes} bytes; the limit is ${RESEARCH_STUDY_SUMMARY_MAX_BYTES}`
    );
  }
  return parsed.data;
};

const run = async (
  argv: readonly string[],
  io: CliIo,
  open: OpenResearchStudyStore
): Promise<string> => {
  const unknown = argv.filter((argument) => argument !== "--dry-run");
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown argument ${unknown[0]}.\n${RESEARCH_STUDIES_IMPORT_USAGE}`
    );
  }
  const study = parseStudyDocument(await readInput(io.stdin));
  const row = { id: study.id, ranOn: study.ran, specRef: study.spec };
  if (argv.includes("--dry-run"))
    return JSON.stringify({ ...row, dryRun: true });
  const databaseUrl = io.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new UsageError("DATABASE_URL is required (or pass --dry-run)");
  }
  const store = open(databaseUrl);
  try {
    const stored = await store.upsert({ ...row, summary: study });
    return JSON.stringify({
      created: stored.created,
      id: stored.id,
      updatedAt: stored.updatedAt.toISOString(),
    });
  } finally {
    await store.close();
  }
};

/** Runs the importer and returns the process exit code: 0 ok, 2 usage or input error, 1 other failure. */
export const runResearchStudiesImport = async (
  argv: readonly string[],
  io: CliIo,
  open: OpenResearchStudyStore = openResearchStudyStore
): Promise<number> => {
  if (argv.includes("--help")) {
    io.stdout.write(`${RESEARCH_STUDIES_IMPORT_USAGE}\n`);
    return 0;
  }
  try {
    io.stdout.write(`${await run(argv, io, open)}\n`);
    return 0;
  } catch (error) {
    // The database checks rejected the document: an input problem, like a schema failure.
    if (
      error instanceof UsageError ||
      error instanceof InvalidRepositoryInputError
    ) {
      io.stderr.write(`${error.message}\n`);
      return 2;
    }
    io.stderr.write(
      `research study import failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
