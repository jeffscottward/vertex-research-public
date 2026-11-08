// What: the flow.* procedures. flow.collect (scheduler, agent API key) runs one sampled collection;
// flow.snapshot reads one symbol's window for the /flow page and the agent. Research only.
// Doc: docs/vertex-rebuild/flow-pipeline.md.
import type { FlowRepository } from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type {
  FlowSnapshot,
  FlowSnapshotParsedInput,
} from "../contracts/flow.ts";
import type { FlowInstrument } from "../flow-features.ts";
import type { ApiContext } from "./context.ts";
import {
  FLOW_DEPTH_ROWS,
  FLOW_PRUNE_INTERVAL_MS,
  FLOW_TICKS_COUNT,
  runFlowCollect,
} from "./flow-collect.ts";
import { buildFlowSnapshot } from "./flow-snapshot.ts";
import {
  fetchMarketDepth,
  fetchMarketHistoryPacing,
  fetchMarketTicks,
} from "./market-data.ts";
import { requireOperator } from "./operator-access.ts";
import {
  buildOptionsAnalytics,
  quantDataClientFor,
} from "./options-analytics.ts";

const api = implement(appContract).$context<ApiContext>();

type Failures = Readonly<{
  FORBIDDEN: (options?: { message?: string }) => Error;
  STORAGE_ERROR: (options?: { message?: string }) => Error;
}>;

const systemClock = (): Date => new Date();
let clock: () => Date = systemClock;
// One collect run at a time per server process (QuantVPS runs one), so a manual or seed run can
// never overlap the timer and spend the shared IBKR budget twice.
// A run older than the scheduler's 170 s timeout counts as abandoned (a cancelled request may
// never reach its finally), so a stuck flag cannot stop sampling for good.
const COLLECT_STALE_MS = 180_000;
let collectingSince: number | null = null;
let lastPruneAt = Number.NEGATIVE_INFINITY;
export const setFlowClockForTesting = (now?: () => Date): void => {
  clock = now ?? systemClock;
  collectingSince = null;
  lastPruneAt = Number.NEGATIVE_INFINITY;
};

const repositoryFor = (
  context: ApiContext,
  failures: Failures
): FlowRepository => {
  const repository = context.repositories.flow;
  if (repository === undefined) throw failures.STORAGE_ERROR();
  return repository;
};

const instrumentInput = (instrument: FlowInstrument) => ({
  currency: "USD",
  secType: instrument.secType,
  symbol: instrument.symbol,
  ...(instrument.exchange === undefined
    ? {}
    : { exchange: instrument.exchange }),
});

const collect = api.flow.collect
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    // Scheduler only: one timer drives the whole deployment's sampling.
    if (context.agentApiKeyPresented !== true)
      throw failures.FORBIDDEN({
        message: "flow.collect needs an agent API key",
      });
    const repository = repositoryFor(context, failures);
    const history = context.marketHistory ?? null;
    const quantData = context.quantData ?? null;
    const client = quantData === null ? null : quantDataClientFor(quantData);
    const now = clock();
    if (
      collectingSince !== null &&
      now.getTime() - collectingSince < COLLECT_STALE_MS
    )
      return {
        at: now.toISOString(),
        busy: true,
        dryRun: input.dryRun,
        pruned: 0,
        runs: [],
      };
    const pruneDue =
      !input.dryRun && now.getTime() - lastPruneAt >= FLOW_PRUNE_INTERVAL_MS;
    const started = now.getTime();
    collectingSince = started;
    try {
      const output = await runFlowCollect(input, {
        analytics:
          client === null
            ? null
            : (ticker) =>
                buildOptionsAnalytics(
                  { flowHours: 1, symbol: ticker },
                  { client, now: () => now }
                ),
        depth: (instrument) =>
          fetchMarketDepth(history, {
            ...instrumentInput(instrument),
            rows: FLOW_DEPTH_ROWS,
          }),
        now,
        pacing: () => fetchMarketHistoryPacing(history),
        pruneDue,
        quantData: client,
        repository,
        ticks: (instrument) =>
          fetchMarketTicks(history, {
            ...instrumentInput(instrument),
            count: FLOW_TICKS_COUNT,
            quotes: true,
            useRTH: false,
          }),
      });
      if (pruneDue) lastPruneAt = started;
      return output;
    } finally {
      if (collectingSince === started) collectingSince = null;
    }
  });

/** Reads one symbol's window; the window ends at the newest stored data, not now. */
export const readFlowSnapshot = async (
  repository: FlowRepository,
  input: FlowSnapshotParsedInput,
  now: Date
): Promise<FlowSnapshot> => {
  const newest = await repository.newestDataAt(input.symbol);
  const windowEnd =
    newest === null || newest.getTime() > now.getTime() ? now : newest;
  const windowStart = new Date(windowEnd.getTime() - input.minutes * 60_000);
  const rows = await repository.readWindow({
    from: windowStart,
    symbol: input.symbol,
    to: windowEnd,
  });
  const samples = await repository.latestSamples(input.symbol);
  return buildFlowSnapshot({
    ...rows,
    ...samples,
    now,
    symbol: input.symbol,
    windowEnd,
    windowStart,
  });
};

const snapshot = api.flow.snapshot
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    try {
      return await readFlowSnapshot(repository, input, clock());
    } catch {
      throw failures.STORAGE_ERROR();
    }
  });

export const flowRouter = { collect, snapshot };
