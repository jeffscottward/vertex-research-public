// Stores research study documents in Postgres (research_studies), read by researchStudies.get.
// Usage (from services/research):
//   python -m strategies.filter_study_summary --daily <adx_filter_run output> \
//     --intraday <rvol_intraday output> --ran 2026-10-31 \
//   | DATABASE_URL=postgres://... bun run vertex:research-studies:import
// stdin holds one JSON document (pretty-printed or not) or JSON lines (one document per line, for
// example every qc-port study of a run). Each document is checked with ResearchStudyDocumentSchema
// (@darkfactory/api: a filter study, or a qc-port backtest study with `kind: "qc-port"`); nothing is
// stored unless every document is valid. Each is then upserted by id through the Drizzle research
// study repository: a new id adds a study, a known id replaces it.
// --dry-run checks the documents and prints what would be stored, without a database.
// Research records only: nothing here places or routes orders.
import {
  RESEARCH_STUDY_SUMMARY_MAX_BYTES,
  type ResearchStudyDocument,
  ResearchStudyDocumentSchema,
} from "@darkfactory/api";
import {
  createNodeDatabase,
  createResearchStudyRepository,
  InvalidRepositoryInputError,
  type ResearchStudyRepository,
} from "@darkfactory/db/server";
import { z } from "zod";

export const RESEARCH_STUDIES_IMPORT_USAGE = [
  "Usage: <study document or JSON lines on stdin> | DATABASE_URL=postgres://... bun run vertex:research-studies:import [--dry-run]",
  'A document is a filter study (services/research/strategies/filter_study_summary.py) or a qc-port backtest study (kind "qc-port").',
].join("\n");

/** Most documents accepted in one JSON lines input. */
export const RESEARCH_STUDY_BATCH_MAX = 100;

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

/** Checks one parsed study document; every problem is a usage error (exit 2). */
const checkStudyDocument = (
  raw: unknown,
  where: string
): ResearchStudyDocument => {
  const parsed = ResearchStudyDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `${where}is not valid:\n${z.prettifyError(parsed.error)}`
    );
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify(parsed.data)
  ).byteLength;
  if (bytes > RESEARCH_STUDY_SUMMARY_MAX_BYTES) {
    throw new UsageError(
      `${where}is ${bytes} bytes; the limit is ${RESEARCH_STUDY_SUMMARY_MAX_BYTES}`
    );
  }
  return parsed.data;
};

const parseJson = (
  text: string
): { ok: true; value: unknown } | { ok: false; message: string } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    // JSON.parse throws only SyntaxError.
    return { message: (error as SyntaxError).message, ok: false };
  }
};

/**
 * Parses and checks the study documents on stdin: one JSON document, or JSON lines with one
 * document per line. Every problem is a usage error (exit 2); nothing is returned unless all
 * documents are valid and their ids are distinct.
 */
export const parseStudyDocuments = (text: string): ResearchStudyDocument[] => {
  if (text.trim().length === 0) {
    throw new UsageError(
      `No study document on stdin.\n${RESEARCH_STUDIES_IMPORT_USAGE}`
    );
  }
  const whole = parseJson(text);
  if (whole.ok) return [checkStudyDocument(whole.value, "The study document ")];
  const lines = text
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.length > 0);
  // A single line that does not parse is a broken document, not JSON lines.
  if (lines.length === 1) {
    throw new UsageError(`stdin is not one JSON document: ${whole.message}`);
  }
  if (lines.length > RESEARCH_STUDY_BATCH_MAX) {
    throw new UsageError(
      `stdin has ${lines.length} JSON lines; the limit is ${RESEARCH_STUDY_BATCH_MAX}`
    );
  }
  const studies = lines.map(({ line, number }) => {
    const value = parseJson(line);
    if (!value.ok) {
      throw new UsageError(
        `stdin is neither one JSON document nor JSON lines: line ${number}: ${value.message}`
      );
    }
    return checkStudyDocument(
      value.value,
      `The study document on line ${number} `
    );
  });
  const seen = new Set<string>();
  for (const study of studies) {
    if (seen.has(study.id))
      throw new UsageError(`Study ${study.id} appears more than once on stdin`);
    seen.add(study.id);
  }
  return studies;
};

const run = async (
  argv: readonly string[],
  io: CliIo,
  open: OpenResearchStudyStore
): Promise<void> => {
  const unknown = argv.filter((argument) => argument !== "--dry-run");
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown argument ${unknown[0]}.\n${RESEARCH_STUDIES_IMPORT_USAGE}`
    );
  }
  const rows = parseStudyDocuments(await readInput(io.stdin)).map((study) => ({
    row: { id: study.id, ranOn: study.ran, specRef: study.spec },
    study,
  }));
  if (argv.includes("--dry-run")) {
    for (const { row } of rows)
      io.stdout.write(`${JSON.stringify({ ...row, dryRun: true })}\n`);
    return;
  }
  const databaseUrl = io.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new UsageError("DATABASE_URL is required (or pass --dry-run)");
  }
  const store = open(databaseUrl);
  try {
    // One line per stored study as it is written, so a later failure leaves a record of what landed.
    for (const { row, study } of rows) {
      const stored = await store.upsert({ ...row, summary: study });
      io.stdout.write(
        `${JSON.stringify({
          created: stored.created,
          id: stored.id,
          updatedAt: stored.updatedAt.toISOString(),
        })}\n`
      );
    }
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
    await run(argv, io, open);
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
