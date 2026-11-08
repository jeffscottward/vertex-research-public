import {
  createSemanticReader,
  type SemanticParamValue as DbParamValue,
  type SemanticRow as DbRow,
  type SemanticCatalog,
  type SemanticLayerRepository,
  type SemanticReader,
  type SemanticSqlAttributeRow,
  type SemanticTermRow,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type { PortfolioMonitorOutput } from "../contracts/portfolio-monitor.ts";
import {
  SEMANTIC_QUERY_MAX_ROWS,
  type SemanticCatalogOutput,
  type SemanticParamSpec,
  type SemanticParamValue,
  type SemanticRow,
  type SemanticTermQueryInput,
  type SemanticTermQueryOutput,
  type SemanticTermSummary,
} from "../contracts/semantic-terms.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";
import {
  type FetchPortfolioMonitorOptions,
  fetchPortfolioMonitor,
  PortfolioMonitorError,
} from "./portfolio-monitor.ts";
import { FEED_TERM_READERS, feedProblem } from "./semantic-feed-terms.ts";

// Agent semantic layer procedures (contracts/semantic-terms.ts). list and query serve the assistant
// tools terms_list and terms_query; catalog, update and certify serve the operator page. Only certified
// definitions answer: an uncertified term or SQL attribute gives "not_available", never a value.

const api = implement(appContract).$context<ApiContext>();

type FailureCode =
  | "BAD_REQUEST"
  | "CONFLICT"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "STORAGE_ERROR"
  | "UNAUTHORIZED";
type Failures = Readonly<
  Record<FailureCode, (options?: { message?: string }) => Error>
>;
const factories = (errors: unknown): Failures => errors as Failures;

/** Time limit for one certified SQL attribute. */
export const SEMANTIC_SQL_TIMEOUT_MS = 5000;
const OPERATOR_SESSION_MESSAGE =
  "The semantic catalog is edited from a signed-in operator session; API keys are refused";

let feedFetchOptions: FetchPortfolioMonitorOptions = {};
let clock: () => Date = () => new Date();
let readerFor: (url: string | null) => SemanticReader = (url) =>
  createSemanticReader(url);
export const setSemanticTermsDependenciesForTesting = (
  options: Readonly<{
    feed?: FetchPortfolioMonitorOptions;
    now?: () => Date;
    reader?: (url: string | null) => SemanticReader;
  }>
): void => {
  feedFetchOptions = options.feed ?? {};
  clock = options.now ?? (() => new Date());
  readerFor = options.reader ?? ((url) => createSemanticReader(url));
};

const repositoryFor = (
  context: ApiContext,
  failures: Failures
): SemanticLayerRepository => {
  const repository = context.repositories.semanticLayer;
  if (repository === undefined) throw failures.STORAGE_ERROR();
  return repository;
};

const storage = async <T>(failures: Failures, work: () => Promise<T>) => {
  try {
    return await work();
  } catch {
    throw failures.STORAGE_ERROR();
  }
};

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

const effectiveCertified = (
  term: SemanticTermRow,
  attribute: SemanticSqlAttributeRow | null | undefined
): boolean =>
  term.certified &&
  (term.source !== "postgres" || (attribute?.certified ?? false));

export const summarizeTerms = (
  semanticCatalog: SemanticCatalog
): SemanticTermSummary[] =>
  semanticCatalog.terms.map((term) => ({
    certified: effectiveCertified(
      term,
      semanticCatalog.attributes.find(
        (attribute) => attribute.termId === term.id
      )
    ),
    description: term.description,
    id: term.id,
    label: term.label,
    params: term.params.map((param) => ({ ...param })) as SemanticParamSpec[],
    source: term.source,
    synonyms: [...term.synonyms],
    unit: term.unit,
  }));

const certificationOf = (row: SemanticTermRow | SemanticSqlAttributeRow) => ({
  certificationNote: row.certificationNote,
  certified: row.certified,
  certifiedAt: iso(row.certifiedAt),
  certifiedBy: row.certifiedBy,
  updatedAt: row.updatedAt.toISOString(),
  updatedBy: row.updatedBy,
});

export const catalogOutput = (
  semanticCatalog: SemanticCatalog
): Omit<SemanticCatalogOutput, "canWrite"> => ({
  attributes: semanticCatalog.attributes.map((row) => ({
    description: row.description,
    id: row.id,
    sql: row.sql,
    termId: row.termId,
    ...certificationOf(row),
  })),
  relationships: semanticCatalog.relationships.map((row) => ({
    cardinality: row.cardinality,
    description: row.description,
    fromColumn: row.fromColumn,
    fromTable: row.fromTable,
    id: row.id,
    toColumn: row.toColumn,
    toTable: row.toTable,
    ...certificationOf(row as unknown as SemanticTermRow),
  })),
  terms: semanticCatalog.terms.map((row) => ({
    description: row.description,
    feedPath: row.feedPath,
    id: row.id,
    label: row.label,
    mappedColumns: [...row.mappedColumns],
    params: row.params.map((param) => ({ ...param })) as SemanticParamSpec[],
    source: row.source,
    synonyms: [...row.synonyms],
    unit: row.unit,
    ...certificationOf(row),
  })),
});

/** The parameter list as the model reads it in an error message. */
const describeParams = (specs: readonly SemanticParamSpec[]): string =>
  specs.length === 0
    ? "no parameters"
    : specs
        .map(
          (spec) =>
            `${spec.name} (${spec.type}${spec.required ? ", required" : ""}${spec.options ? `: ${spec.options.join("|")}` : ""})`
        )
        .join(", ");

/**
 * Checks the model's parameters against the term's specs. Returns the values in spec order (they bind
 * $1..$n of a SQL attribute) or a message for the model.
 */
export const bindParams = (
  specs: readonly SemanticParamSpec[],
  params: Readonly<Record<string, SemanticParamValue>>
):
  | { ok: true; values: SemanticParamValue[] }
  | { ok: false; message: string } => {
  const usage = describeParams(specs);
  const unknownNames = Object.keys(params).filter(
    (name) => !specs.some((spec) => spec.name === name)
  );
  if (unknownNames.length > 0) {
    return {
      message: `Unknown parameter ${unknownNames.join(", ")}. This term takes ${usage}.`,
      ok: false,
    };
  }
  const values: SemanticParamValue[] = [];
  for (const spec of specs) {
    const raw = params[spec.name];
    const value = raw === undefined || raw === "" ? null : raw;
    if (value === null) {
      if (spec.required) {
        return {
          message: `Parameter ${spec.name} is required. This term takes ${usage}.`,
          ok: false,
        };
      }
      values.push(null);
      continue;
    }
    if (spec.type === "number" && typeof value !== "number") {
      return { message: `Parameter ${spec.name} must be a number.`, ok: false };
    }
    if (spec.type === "text" && typeof value !== "string") {
      return { message: `Parameter ${spec.name} must be text.`, ok: false };
    }
    const option = spec.options?.find(
      (candidate) => candidate.toLowerCase() === String(value).toLowerCase()
    );
    if (spec.options !== undefined && option === undefined) {
      return {
        message: `Parameter ${spec.name} must be one of ${spec.options.join(", ")}.`,
        ok: false,
      };
    }
    values.push(option ?? value);
  }
  return { ok: true, values };
};

const CELL_TEXT_MAX = 2000;
const toCell = (value: unknown): SemanticRow[string] => {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > CELL_TEXT_MAX
    ? `${text.slice(0, CELL_TEXT_MAX - 1)}…`
    : text;
};
const toRow = (row: DbRow | SemanticRow): SemanticRow =>
  Object.fromEntries(
    Object.entries(row)
      .slice(0, 40)
      .map(([key, value]) => [key.slice(0, 64), toCell(value)])
  );

type QueryContext = Readonly<{
  repository: SemanticLayerRepository;
  reader: SemanticReader;
  readFeed: () => Promise<PortfolioMonitorOutput>;
  now: Date;
}>;

const NOT_CERTIFIED =
  "This term is not certified, so it gives no value. An operator certifies it on the /semantic-terms page.";

/** Answers one term. Throws BadParams for parameters the model must fix. */
export class SemanticParamsError extends Error {}

/** Answers a certified feed term from a fresh vertex-portfolio snapshot. */
const answerFeedTerm = async (
  term: SemanticTermRow,
  values: readonly SemanticParamValue[],
  described: Omit<SemanticTermQueryOutput, "answer" | "status">,
  { now, readFeed }: Pick<QueryContext, "now" | "readFeed">
): Promise<SemanticTermQueryOutput> => {
  const reader = FEED_TERM_READERS[term.id];
  if (reader === undefined) {
    return {
      ...described,
      answer: "Not available: no feed reader is built for this term.",
      status: "not_available",
    };
  }
  let snapshot: PortfolioMonitorOutput;
  try {
    snapshot = await readFeed();
  } catch (error) {
    const reason =
      error instanceof PortfolioMonitorError
        ? error.message
        : "Portfolio request failed";
    return {
      ...described,
      answer: `Unknown: the vertex-portfolio feed is unavailable (${reason}). No value is given; the paper exec node is not a substitute.`,
      status: "unknown",
    };
  }
  const asOf = snapshot.status.dataAsOf;
  const problem = feedProblem(snapshot, now);
  if (problem !== null) {
    return {
      ...described,
      answer: `Unknown: ${problem}`,
      asOf,
      status: "unknown",
    };
  }
  const read = reader(
    snapshot,
    Object.fromEntries(
      term.params.map((spec, index) => [spec.name, values[index] ?? null])
    )
  );
  const rows = read.rows.slice(0, SEMANTIC_QUERY_MAX_ROWS).map(toRow);
  return {
    ...described,
    answer:
      read.status === "ok"
        ? `${read.answer} As of ${asOf}.`
        : `Unknown: ${read.answer}`,
    asOf,
    rowCount: rows.length,
    rows,
    status: read.status,
    truncated: read.rows.length > rows.length,
  };
};

export const answerTerm = async (
  input: SemanticTermQueryInput,
  { now, readFeed, reader, repository }: QueryContext
): Promise<SemanticTermQueryOutput> => {
  const params = input.params ?? {};
  const base = {
    asOf: null,
    certified: false,
    label: null,
    params,
    query: null,
    rowCount: 0,
    rows: [],
    source: null,
    term: input.term,
    truncated: false,
    unit: null,
  } satisfies Partial<SemanticTermQueryOutput>;
  const entry = await repository.term(input.term);
  if (entry === null) {
    return {
      ...base,
      answer: `No certified term is named ${input.term}. Call terms_list for the catalog; if no term covers the measure, it is not available.`,
      status: "not_available",
    };
  }
  const { attribute, term } = entry;
  const certified = effectiveCertified(term, attribute);
  const described = {
    ...base,
    certified,
    label: term.label,
    query:
      term.source === "postgres" ? (attribute?.sql ?? null) : term.feedPath,
    source: term.source,
    unit: term.unit,
  };
  if (term.source === "none") {
    return {
      ...described,
      answer: `Not available. ${term.description}`,
      status: "not_available",
    };
  }
  if (!certified) {
    return { ...described, answer: NOT_CERTIFIED, status: "not_available" };
  }
  const bound = bindParams(term.params as SemanticParamSpec[], params);
  if (!bound.ok) throw new SemanticParamsError(bound.message);

  if (term.source === "postgres") {
    const result = await reader.run(
      attribute as SemanticSqlAttributeRow,
      bound.values as DbParamValue[],
      { rowLimit: SEMANTIC_QUERY_MAX_ROWS, timeoutMs: SEMANTIC_SQL_TIMEOUT_MS }
    );
    if (result.status === "failed") {
      return {
        ...described,
        answer: `Unknown: ${result.message} No value is given.`,
        query: result.query,
        status: "unknown",
      };
    }
    const rows = result.rows.map(toRow);
    return {
      ...described,
      answer:
        rows.length === 0
          ? `No rows match. ${term.description}`
          : `${rows.length}${result.truncated ? "+" : ""} row(s). ${term.description}`,
      asOf: now.toISOString(),
      query: result.query,
      rowCount: rows.length,
      rows,
      status: "ok",
      truncated: result.truncated,
    };
  }

  return await answerFeedTerm(term, bound.values, described, { now, readFeed });
};

const list = api.semanticTerms.list
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = factories(errors);
    const repository = repositoryFor(context, failures);
    const catalog = await storage(failures, () => repository.catalog());
    return { terms: summarizeTerms(catalog) };
  });

const query = api.semanticTerms.query
  .use(requireOperator)
  .handler(async ({ context, errors, input }) => {
    const failures = factories(errors);
    const repository = repositoryFor(context, failures);
    try {
      return await answerTerm(input, {
        now: clock(),
        reader: readerFor(context.semanticDatabaseUrl ?? null),
        readFeed: () =>
          fetchPortfolioMonitor(
            context.portfolioMonitor ?? null,
            feedFetchOptions
          ),
        repository,
      });
    } catch (error) {
      if (error instanceof SemanticParamsError) {
        throw failures.BAD_REQUEST({ message: error.message });
      }
      throw failures.STORAGE_ERROR();
    }
  });

const requireOperatorSession = api.middleware(
  async ({ context, errors, next }) => {
    if (context.agentApiKeyPresented === true) {
      throw factories(errors).FORBIDDEN({ message: OPERATOR_SESSION_MESSAGE });
    }
    return await next();
  }
);

const catalog = api.semanticTerms.catalog
  .use(requireOperatorSession)
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = factories(errors);
    const repository = repositoryFor(context, failures);
    return {
      canWrite: context.callerCanWrite === true,
      ...catalogOutput(await storage(failures, () => repository.catalog())),
    };
  });

const writer = (
  context: ApiContext & {
    callerCanWrite: boolean;
    principal: { userId: string };
  },
  failures: Failures
): string => {
  if (!context.callerCanWrite) {
    throw failures.FORBIDDEN({ message: "Operator write access required" });
  }
  return context.principal.userId;
};

const update = api.semanticTerms.update
  .use(requireOperatorSession)
  .use(requireOperator)
  .handler(async ({ context, errors, input }) => {
    const failures = factories(errors);
    const actor = writer(context, failures);
    const repository = repositoryFor(context, failures);
    const row = await storage(failures, async () => {
      switch (input.kind) {
        case "term": {
          const { description, label, synonyms, unit } = input;
          return await repository.updateTerm(
            input.id,
            { description, label, synonyms, unit },
            actor
          );
        }
        case "attribute": {
          const { description, sql } = input;
          return await repository.updateAttribute(
            input.id,
            { description, sql },
            actor
          );
        }
        case "relationship":
          return await repository.updateRelationship(
            input.id,
            { description: input.description },
            actor
          );
      }
    });
    if (row === null) {
      throw failures.NOT_FOUND({ message: `No ${input.kind} ${input.id}` });
    }
    return { ok: true as const };
  });

const certify = api.semanticTerms.certify
  .use(requireOperatorSession)
  .use(requireOperator)
  .handler(async ({ context, errors, input }) => {
    const failures = factories(errors);
    const actor = writer(context, failures);
    const repository = repositoryFor(context, failures);
    const outcome = await storage(failures, () =>
      repository.certify({
        actor,
        certified: input.certified,
        expectedUpdatedAt: new Date(input.expectedUpdatedAt),
        id: input.id,
        kind: input.kind,
        note: input.note === null || input.note === "" ? null : input.note,
      })
    );
    if (outcome === "not_found")
      throw failures.NOT_FOUND({ message: `No ${input.kind} ${input.id}` });
    if (outcome === "changed") {
      throw failures.CONFLICT({
        message:
          "The row changed after you read it; reload and review it again",
      });
    }
    return { ok: true as const };
  });

export const semanticTermsRouter = { catalog, certify, list, query, update };
