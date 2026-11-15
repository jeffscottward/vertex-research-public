// What: Development/test plays (dummy, clearly fake tickers and values; never real positions).
// Used by: packages/db/src/seeds/index.ts (convergeApplicationRows).
// See: docs/plays.md; packages/db/src/server/plays-repository.ts.
import type { DatabaseExecutor } from "../server/client.ts";
import {
  createPlaysRepository,
  type UpsertPlayInput,
} from "../server/plays-repository.ts";

export const DEVELOPMENT_PLAYS: readonly UpsertPlayInput[] = Object.freeze([
  Object.freeze<UpsertPlayInput>({
    id: "seed-play-0001",
    ticker: "ZZZT",
    structure: "call debit spread",
    legs: [
      {
        side: "buy",
        right: "call",
        strike: 100,
        expiry: "2099-01-16",
        quantity: 1,
      },
      {
        side: "sell",
        right: "call",
        strike: 110,
        expiry: "2099-01-16",
        quantity: 1,
      },
    ],
    maxLossUsd: 250,
    thesis: "FAKE seed thesis: dummy ticker for local development only.",
    trigger: "FAKE trigger: close above 105.",
    exitRule: "FAKE exit: take profit at 50% or close by expiry week.",
    status: "idea",
    notes: "Dummy seed row.",
    sourceUrl: null,
  }),
  Object.freeze<UpsertPlayInput>({
    id: "seed-play-0002",
    ticker: "QQQX",
    structure: "put credit spread",
    legs: [
      {
        side: "sell",
        right: "put",
        strike: 50,
        expiry: "2099-03-20",
        quantity: 2,
      },
      {
        side: "buy",
        right: "put",
        strike: 45,
        expiry: "2099-03-20",
        quantity: 2,
      },
    ],
    maxLossUsd: "900.00",
    thesis: "FAKE seed thesis: dummy ticker for local development only.",
    trigger: "FAKE trigger: holds the 50 level.",
    exitRule: "FAKE exit: buy back at 2x credit.",
    status: "armed",
    notes: null,
    sourceUrl: "https://example.com/fake-play",
  }),
]);

export const convergeDevelopmentPlays = async (
  database: DatabaseExecutor
): Promise<void> => {
  const repository = createPlaysRepository(database);
  for (const play of DEVELOPMENT_PLAYS) {
    await repository.upsert(play);
  }
};
