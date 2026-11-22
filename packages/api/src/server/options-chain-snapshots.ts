import type {
  OptionChainSnapshotIngestResult,
  OptionChainSnapshotReadResult,
  OptionChainSnapshotsRepository,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type { OptionsChainSnapshotReadOutput } from "../contracts/options-chain.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";
import { storageNotConfiguredMessage } from "./storage-not-configured.ts";

// Option chain snapshot procedures (optionsChain.ingestSnapshot, optionsChain.snapshot).
// Operator-only. ingestSnapshot (collector write key; read keys get 403 from requireOperator and
// sessions get 403 here) upserts one (snapshotAt, underlying, expiry) header and replaces its
// quote rows in one transaction. snapshot (operator session, agent viewer or agent read key)
// reads the newest or requested snapshot from Postgres. Research only: no order path.

const api = implement(appContract).$context<ApiContext>();

type Failures = Readonly<{
  FORBIDDEN: (options?: { message?: string }) => Error;
  STORAGE_ERROR: (options?: { message?: string }) => Error;
}>;

const repositoryFor = (
  context: ApiContext,
  failures: Failures
): OptionChainSnapshotsRepository => {
  const repository = context.repositories.optionChainSnapshots;
  if (repository === undefined)
    throw failures.STORAGE_ERROR({
      message: storageNotConfiguredMessage("Option chain snapshot"),
    });
  return repository;
};

const formatReadOutput = (
  result: OptionChainSnapshotReadResult
): OptionsChainSnapshotReadOutput => ({
  availableDays: [...result.availableDays],
  availableSnapshots: result.availableSnapshots.map((run) => ({
    expiries: [...run.expiries],
    quoteCount: run.quoteCount,
    snapshotAt: run.snapshotAt.toISOString(),
    source: run.source,
    spot: run.spot,
    tradingDay: run.tradingDay,
  })),
  expiries: result.expiries.map((expiry) => ({
    expiry: expiry.expiry,
    quoteCount: expiry.quoteCount,
    quotes: expiry.quotes.map((quote) => ({
      ask: quote.ask,
      bid: quote.bid,
      iv: quote.iv,
      last: quote.last,
      openInterest: quote.openInterest,
      right: quote.right,
      source: quote.source,
      strike: quote.strike,
      volume: quote.volume,
    })),
    source: expiry.source,
    spot: expiry.spot,
  })),
  snapshotAt:
    result.snapshotAt === null ? null : result.snapshotAt.toISOString(),
  tradingDay: result.tradingDay,
  underlying: result.underlying,
});

const ingestSnapshot = api.optionsChain.ingestSnapshot
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    if (context.agentApiKeyPresented !== true)
      throw failures.FORBIDDEN({
        message: "optionsChain.ingestSnapshot needs an agent API key",
      });
    const repository = repositoryFor(context, failures);
    let stored: OptionChainSnapshotIngestResult;
    try {
      stored = await repository.ingestSnapshot({
        expiry: input.expiry,
        quotes: input.quotes,
        snapshotAt: new Date(input.snapshotAt),
        source: input.source,
        spot: input.spot,
        tradingDay: input.tradingDay,
        underlying: input.underlying,
      });
    } catch {
      throw failures.STORAGE_ERROR();
    }
    return {
      created: stored.created,
      expiry: stored.expiry,
      quoteCount: stored.quoteCount,
      snapshotAt: stored.snapshotAt.toISOString(),
      snapshotId: stored.snapshotId,
      tradingDay: stored.tradingDay,
      underlying: stored.underlying,
    };
  });

const snapshot = api.optionsChain.snapshot
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    let read: OptionChainSnapshotReadResult;
    try {
      read = await repository.readSnapshot({
        expiry: input.expiry,
        snapshotAt:
          input.snapshotAt === undefined
            ? undefined
            : new Date(input.snapshotAt),
        tradingDay: input.tradingDay,
        underlying: input.underlying,
      });
    } catch {
      throw failures.STORAGE_ERROR();
    }
    return formatReadOutput(read);
  });

export const optionsChainSnapshotHandlers = { ingestSnapshot, snapshot };
