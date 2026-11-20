import { asc } from "drizzle-orm";

import { type JevVerdictLogStance, jevVerdictLog } from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Append-only log of JEV verdicts (table jev_verdict_log, migration 0082). The repository has no
// update or delete method, and the app role has no UPDATE or DELETE grant on the table.
// listForecasts returns rows in the forecast record shape of the forecast scorecard
// (packages/api/src/forecast-scorecard.ts, schemaVersion 1), oldest decision first.

export type JevVerdictLogProbabilities = Readonly<{
  BEARISH: number;
  BULLISH: number;
  NEUTRAL: number;
}>;

export type JevVerdictLogInput = Readonly<{
  source: string;
  sourceVersion: string | null;
  symbol: string;
  dataAsOf: string | null;
  decidedAt: Date;
  model: string | null;
  choice: JevVerdictLogStance | null;
  stance: JevVerdictLogStance;
  probabilities: JevVerdictLogProbabilities;
}>;

export type JevVerdictLogForecast = Readonly<{
  schemaVersion: 1;
  source: string;
  sourceVersion: string | null;
  model: string | null;
  symbol: string;
  dataAsOf: string | null;
  decidedAt: string;
  probabilities: JevVerdictLogProbabilities;
}>;

export type JevVerdictLogRepository = Readonly<{
  append: (input: JevVerdictLogInput) => Promise<Readonly<{ id: string }>>;
  listForecasts: () => Promise<JevVerdictLogForecast[]>;
}>;

export const createJevVerdictLogRepository = (
  database: DatabaseExecutor,
  dependencies: Readonly<{ now: () => Date; generateId: () => string }>
): JevVerdictLogRepository => ({
  append: async (input) => {
    const id = dependencies.generateId();
    await database.insert(jevVerdictLog).values({
      choice: input.choice,
      dataAsOf: input.dataAsOf,
      decidedAt: input.decidedAt,
      id,
      loggedAt: dependencies.now(),
      model: input.model,
      probBearish: input.probabilities.BEARISH,
      probBullish: input.probabilities.BULLISH,
      probNeutral: input.probabilities.NEUTRAL,
      source: input.source,
      sourceVersion: input.sourceVersion,
      stance: input.stance,
      symbol: input.symbol,
    });
    return { id };
  },
  listForecasts: async () => {
    const rows = await database
      .select()
      .from(jevVerdictLog)
      .orderBy(asc(jevVerdictLog.decidedAt), asc(jevVerdictLog.id));
    return rows.map((row) => ({
      dataAsOf: row.dataAsOf,
      decidedAt: row.decidedAt.toISOString(),
      model: row.model,
      probabilities: {
        BEARISH: row.probBearish,
        BULLISH: row.probBullish,
        NEUTRAL: row.probNeutral,
      },
      schemaVersion: 1 as const,
      source: row.source,
      sourceVersion: row.sourceVersion,
      symbol: row.symbol,
    }));
  },
});
