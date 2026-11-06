// What: read-only Drizzle repository for Quant Lab studies (frozen strategy specs with their paper,
// strategy and newest backtest) and recent SSRN paper captures.
// Used by: packages/db/src/server/repositories.ts (createRepositories), packages/api/src/server/quant-lab.ts.
// See: packages/db/migrations/0043_quant_lab.sql; packages/db/src/server/quant-lab-store.ts (writer).
// Research records only. JSON columns are returned as stored; the API validates them with Zod.
import { desc, eq, inArray, sql } from "drizzle-orm";

import {
  type AgentMetrics,
  backtestResults,
  paperCaptures,
  type ResearchPaperStage,
  type ResearchPaperVerdict,
  researchPapers,
  type StrategyStatus,
  strategies,
  strategySpecs,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  DatabasePersistenceError,
  databaseErrorDetails,
} from "./repository-errors.ts";

export const QUANT_LAB_STUDIES_MAX_LISTED = 50;
export const QUANT_LAB_CAPTURES_MAX_LISTED = 20;
const QUANT_LAB_BACKTEST_PREFIX = "bt-quantlab-";
// "bt-quantlab-" + 12 hex characters + "-".
const QUANT_LAB_BACKTEST_PREFIX_LENGTH = QUANT_LAB_BACKTEST_PREFIX.length + 13;

// The recorder writes backtest ids as bt-quantlab-<spec_sha256[0:12]>-<result hash>, so this
// prefix ties a backtest to one exact spec version (scripts/quant-lab/record-rows.ts).
export const quantLabBacktestPrefix = (specSha256: string): string =>
  `${QUANT_LAB_BACKTEST_PREFIX}${specSha256.slice(0, 12)}-`;

export type QuantLabStudyPaperRow = Readonly<{
  id: string;
  title: string;
  identifier: string | null;
  sourceUrl: string | null;
  stage: ResearchPaperStage;
  verdict: ResearchPaperVerdict;
}>;

export type QuantLabStudyStrategyRow = Readonly<{
  id: string;
  slug: string;
  status: StrategyStatus;
}>;

export type QuantLabStudyBacktestRow = Readonly<{
  id: string;
  periodStart: string;
  periodEnd: string;
  instruments: string;
  metrics: AgentMetrics;
  maxDrawdown: number | null;
  notes: string | null;
  createdAt: Date;
}>;

export type QuantLabStudyRow = Readonly<{
  id: string;
  specKey: string;
  specSha256: string;
  name: string;
  hypothesis: string;
  // Unvalidated JSON from jsonb columns; callers must parse before use.
  paperClaims: unknown;
  ourReading: unknown;
  createdAt: Date;
  paper: QuantLabStudyPaperRow | null;
  strategy: QuantLabStudyStrategyRow | null;
  backtest: QuantLabStudyBacktestRow | null;
}>;

export type QuantLabCaptureSummaryRow = Readonly<{
  id: string;
  doi: string;
  ssrnId: string;
  title: string;
  topic: string;
  version: string;
  pdfStatus: string;
  capturedAt: Date;
  url: string;
}>;

export type QuantLabReadModel = Readonly<{
  studies: QuantLabStudyRow[];
  captures: QuantLabCaptureSummaryRow[];
}>;

export type QuantLabReadRepository = Readonly<{
  // Newest specs first (at most 50) and the newest 20 captures.
  list: () => Promise<QuantLabReadModel>;
}>;

const mapReadError = (error: unknown): never => {
  if (typeof databaseErrorDetails(error).code === "string") {
    throw new DatabasePersistenceError("quant lab read");
  }
  throw error;
};

export const createQuantLabReadRepository = (
  database: DatabaseExecutor
): QuantLabReadRepository => {
  const listSpecs = () =>
    database
      .select({
        createdAt: strategySpecs.createdAt,
        hypothesis: strategySpecs.hypothesis,
        id: strategySpecs.id,
        name: strategySpecs.name,
        ourReading: strategySpecs.ourReading,
        // Drizzle returns a nested object as null when the left join found no row.
        paper: {
          id: researchPapers.id,
          identifier: researchPapers.identifier,
          sourceUrl: researchPapers.sourceUrl,
          stage: researchPapers.stage,
          title: researchPapers.title,
          verdict: researchPapers.verdict,
        },
        paperClaims: strategySpecs.paperClaims,
        specKey: strategySpecs.specKey,
        specSha256: strategySpecs.specSha256,
        strategy: {
          id: strategies.id,
          slug: strategies.slug,
          status: strategies.status,
        },
      })
      .from(strategySpecs)
      .leftJoin(researchPapers, eq(strategySpecs.paperId, researchPapers.id))
      .leftJoin(strategies, eq(strategySpecs.strategyId, strategies.id))
      .orderBy(desc(strategySpecs.createdAt), desc(strategySpecs.id))
      .limit(QUANT_LAB_STUDIES_MAX_LISTED);

  // One row per spec: the newest backtest whose id carries that spec's hash prefix
  // (DISTINCT ON keeps the first row of each prefix group). Agent backtests on the same
  // strategy and backtests of another spec version do not match.
  // A literal length, not a bound parameter: DISTINCT ON and ORDER BY must be the same expression.
  const backtestPrefix = sql<string>`left(${backtestResults.id}, ${sql.raw(String(QUANT_LAB_BACKTEST_PREFIX_LENGTH))})`;
  const listNewestBacktests = (prefixes: string[]) =>
    database
      .selectDistinctOn([backtestPrefix], {
        createdAt: backtestResults.createdAt,
        id: backtestResults.id,
        instruments: backtestResults.instruments,
        maxDrawdown: backtestResults.maxDrawdown,
        metrics: backtestResults.metrics,
        notes: backtestResults.notes,
        periodEnd: backtestResults.periodEnd,
        periodStart: backtestResults.periodStart,
        prefix: backtestPrefix,
      })
      .from(backtestResults)
      .where(inArray(backtestPrefix, prefixes))
      .orderBy(
        backtestPrefix,
        desc(backtestResults.createdAt),
        desc(backtestResults.id)
      );

  const listCaptures = () =>
    database
      .select({
        capturedAt: paperCaptures.capturedAt,
        doi: paperCaptures.doi,
        id: paperCaptures.id,
        pdfStatus: paperCaptures.pdfStatus,
        ssrnId: paperCaptures.ssrnId,
        title: paperCaptures.title,
        topic: paperCaptures.topic,
        url: paperCaptures.url,
        version: paperCaptures.version,
      })
      .from(paperCaptures)
      .orderBy(desc(paperCaptures.capturedAt), desc(paperCaptures.id))
      .limit(QUANT_LAB_CAPTURES_MAX_LISTED);

  return Object.freeze({
    list: async () => {
      try {
        const specs = await listSpecs();
        const backtests =
          specs.length === 0
            ? []
            : await listNewestBacktests(
                specs.map((spec) => quantLabBacktestPrefix(spec.specSha256))
              );
        const newest = new Map<string, QuantLabStudyBacktestRow>(
          backtests.map(({ prefix, ...backtest }) => [prefix, backtest])
        );
        const captures = await listCaptures();
        return {
          captures,
          studies: specs.map((spec) => ({
            ...spec,
            backtest:
              newest.get(quantLabBacktestPrefix(spec.specSha256)) ?? null,
          })),
        };
      } catch (error) {
        return mapReadError(error);
      }
    },
  });
};
