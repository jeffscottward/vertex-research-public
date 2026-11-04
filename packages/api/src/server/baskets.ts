import {
  type BasketRepository,
  type BasketWithMembers,
  DatabaseConflictError,
  DatabasePersistenceError,
  InvalidRepositoryInputError,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import {
  barDate,
  computeBasketIndex,
  type DailyClose,
} from "../basket-index.ts";
import { appContract } from "../contract.ts";
import {
  BASKET_BENCHMARK_SYMBOL,
  type BasketOutput,
  type BasketValuationOutput,
} from "../contracts/baskets.ts";
import {
  loadBasketCloses,
  resetBasketHistoryCache,
  type SymbolCloses,
} from "./basket-history.ts";
import type { ApiContext } from "./context.ts";
import type { DeployStatusConfig } from "./deploy-status.ts";
import {
  type FetchMarketBarsOptions,
  fetchMarketBars,
  type MarketDataError,
} from "./market-data.ts";
import { requireOperator } from "./operator-access.ts";

// Tracking only. Owner is the authenticated operator; inputs never carry a user id.
// Valuation reads daily closes from the existing IBKR history service (VERTEX_HISTORY_URL)
// through basket-history.ts: one request at a time, recent results reused, a per-view time budget.

const api = implement(appContract).$context<ApiContext>();

type BasketErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "STORAGE_ERROR";

type BasketErrorFactories = Readonly<
  Record<BasketErrorCode, (options?: { message?: string }) => Error>
>;

const factories = (errors: unknown): BasketErrorFactories => {
  return errors as BasketErrorFactories;
};

const repositoryFor = (
  context: ApiContext,
  errors: unknown
): BasketRepository => {
  const repository = context.repositories.baskets;
  if (repository === undefined) throw factories(errors).STORAGE_ERROR();
  return repository;
};

const mapBasketError = (error: unknown, errors: unknown): never => {
  const failures = factories(errors);
  if (error instanceof InvalidRepositoryInputError) {
    throw failures.VALIDATION_ERROR({ message: error.message });
  }
  if (error instanceof DatabaseConflictError) throw failures.CONFLICT();
  if (error instanceof DatabasePersistenceError) throw failures.STORAGE_ERROR();
  throw error;
};

const toBasketOutput = ({
  basket,
  members,
}: BasketWithMembers): BasketOutput => ({
  id: basket.id,
  symbol: basket.symbol,
  name: basket.name,
  baseDate: basket.baseDate ?? null,
  baseValue: basket.baseValue,
  members: members.map((member) => ({
    symbol: member.symbol,
    weight: member.weight,
    basePrice: member.basePrice ?? null,
    sharesAtBase: member.sharesAtBase ?? null,
  })),
  createdAt: basket.createdAt,
  updatedAt: basket.updatedAt,
});

type BasketFetchOptions = FetchMarketBarsOptions &
  Readonly<{
    // Milliseconds clock and sleep for the history time budget (default: real time).
    clock?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }>;

let basketFetchOptions: BasketFetchOptions = {};
export const setBasketFetchOptionsForTesting = (
  options: BasketFetchOptions
): void => {
  basketFetchOptions = options;
  resetBasketHistoryCache();
};

// The project's TypeScript lib predates Promise.withResolvers, so the executor form is used.
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Earliest fetch time over the members; null when any member has no known fetch time.
const earliestFetch = (loaded: readonly SymbolCloses[]): Date | null => {
  let earliest: Date | null = null;
  for (const entry of loaded) {
    if (entry.fetchedAt === null) return null;
    if (earliest === null || entry.fetchedAt < earliest) {
      earliest = entry.fetchedAt;
    }
  }
  return earliest;
};

const loadCloses = async (
  config: DeployStatusConfig | null,
  symbol: string
): Promise<SymbolCloses> => {
  try {
    const result = await fetchMarketBars(
      config,
      {
        symbol,
        secType: "STK",
        currency: "USD",
        barSize: "1 day",
        duration: "1 Y",
        whatToShow: "TRADES",
        useRTH: true,
      },
      basketFetchOptions
    );
    return {
      symbol,
      closes: result.bars.map((bar) => ({
        date: barDate(bar.t),
        close: bar.c,
      })),
      // The schema accepts only ISO UTC times, so this is a valid date.
      fetchedAt: new Date(result.fetchedAt),
      reason: null,
    };
  } catch (error) {
    return {
      symbol,
      closes: null,
      fetchedAt: null,
      // fetchMarketBars reports every failure as a MarketDataError with a safe message.
      reason: (error as MarketDataError).message,
    };
  }
};

const valueBasket = async (
  context: ApiContext,
  repository: BasketRepository,
  userId: string,
  current: BasketWithMembers,
  now: Date
): Promise<BasketValuationOutput> => {
  // SPY first: every basket shares it, so it is cached once for all of them.
  const symbols = [
    ...new Set([
      BASKET_BENCHMARK_SYMBOL,
      ...current.members.map((member) => member.symbol),
    ]),
  ];
  // createApiContext normalizes an absent history config to null.
  const config = context.marketHistory as DeployStatusConfig | null;
  const loaded =
    config === null
      ? // Not configured: no request is made, so nothing needs pacing or caching.
        await Promise.all(symbols.map((symbol) => loadCloses(null, symbol)))
      : await loadBasketCloses(config.url, symbols, {
          fetchCloses: (symbol) => loadCloses(config, symbol),
          clock: basketFetchOptions.clock ?? Date.now,
          sleep: basketFetchOptions.sleep ?? sleep,
        });
  const closes = Object.fromEntries(
    loaded.map((entry) => [entry.symbol, entry.closes])
  );
  const memberCloses = loaded.filter((entry) =>
    current.members.some((member) => member.symbol === entry.symbol)
  );
  const indexFor = ({ basket, members }: BasketWithMembers) => {
    const storedBase =
      basket.baseDate === null
        ? null
        : {
            date: basket.baseDate,
            prices: Object.fromEntries(
              members.map((member) => [member.symbol, Number(member.basePrice)])
            ),
            benchmark:
              basket.benchmarkBasePrice === null
                ? null
                : Number(basket.benchmarkBasePrice),
          };
    const result = computeBasketIndex({
      members: members.map((member) => ({
        symbol: member.symbol,
        weight: Number(member.weight),
      })),
      closes,
      // SPY is always requested, so the key exists (null when its history failed).
      benchmark: closes[BASKET_BENCHMARK_SYMBOL] as DailyClose[] | null,
      storedBase,
      baseValue: Number(basket.baseValue),
      // Members change only with the base cleared, so updatedAt is the membership start while unfixed.
      anchorAt: basket.updatedAt,
      now,
      dataAsOf: earliestFetch(memberCloses),
    });
    return { storedBase, result };
  };
  let { storedBase, result } = indexFor(current);
  let saved = current;
  if (result.newlyFixedBase !== null) {
    const fixed = await repository.fixBase({
      id: current.basket.id,
      userId,
      // The membership this valuation used; an edit since then cancels the fix.
      expectedUpdatedAt: current.basket.updatedAt,
      baseDate: result.newlyFixedBase.date,
      prices: Object.fromEntries(
        Object.entries(result.newlyFixedBase.prices).map(([symbol, price]) => [
          symbol,
          String(price),
        ])
      ),
      benchmarkPrice:
        result.newlyFixedBase.benchmark === null
          ? null
          : String(result.newlyFixedBase.benchmark),
    });
    saved = fixed ?? current;
    // A concurrent valuation stored another base first: value against the stored one.
    if (
      saved.basket.baseDate !== null &&
      saved.basket.baseDate !== result.newlyFixedBase.date
    ) {
      ({ storedBase, result } = indexFor(saved));
    }
  }
  // Bases fixed before benchmark_base_price existed get it once, while the base date is still
  // inside the fetched window (a stored base is always the result's base).
  const resolvedBenchmark = result.base?.benchmark ?? null;
  if (
    storedBase !== null &&
    storedBase.benchmark === null &&
    resolvedBenchmark !== null
  ) {
    try {
      await repository.setBenchmarkBase({
        id: current.basket.id,
        userId,
        baseDate: storedBase.date,
        price: String(resolvedBenchmark),
      });
    } catch {
      // Best effort: the valuation is complete without it, and the next view tries again
      // because the guarded update only writes while the stored price is still null.
    }
  }
  return {
    basket: toBasketOutput(saved),
    // The fix was not stored (the members changed meanwhile): the base is still open.
    baseState:
      result.baseState === "fixed" && saved.basket.baseDate === null
        ? "provisional"
        : result.baseState,
    baseDate: result.base?.date ?? null,
    benchmarkSymbol: BASKET_BENCHMARK_SYMBOL,
    points: result.points.map((point) => ({
      ...point,
      missing: [...point.missing],
    })),
    latest: result.latest,
    staleSymbols: [...result.staleSymbols],
    members: [...result.members],
    unavailable: loaded.flatMap((entry) =>
      entry.reason === null
        ? []
        : [{ symbol: entry.symbol, reason: entry.reason }]
    ),
    computedAt: now.toISOString(),
  };
};

const basketsList = api.baskets.list
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const repository = repositoryFor(context, errors);
    try {
      const items = await repository.listByUser(context.principal.userId);
      return { items: items.map(toBasketOutput) };
    } catch (error) {
      return mapBasketError(error, errors);
    }
  });

const basketsCreate = api.baskets.create
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    try {
      return toBasketOutput(
        await repository.create({ userId: context.principal.userId, ...input })
      );
    } catch (error) {
      return mapBasketError(error, errors);
    }
  });

const basketsUpdate = api.baskets.update
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    let updated: BasketWithMembers | null;
    try {
      updated = await repository.update({
        id: input.id,
        userId: context.principal.userId,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.members === undefined ? {} : { members: input.members }),
      });
    } catch (error) {
      return mapBasketError(error, errors);
    }
    if (updated === null) throw factories(errors).NOT_FOUND();
    return toBasketOutput(updated);
  });

const basketsRemove = api.baskets.remove
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    let removed: boolean;
    try {
      removed = await repository.remove(input.id, context.principal.userId);
    } catch (error) {
      return mapBasketError(error, errors);
    }
    if (!removed) throw factories(errors).NOT_FOUND();
    return { id: input.id, removed: true as const };
  });

const basketsValuation = api.baskets.valuation
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    const userId = context.principal.userId;
    try {
      const current = await repository.get(input.id, userId);
      if (current === null) throw factories(errors).NOT_FOUND();
      return await valueBasket(
        context,
        repository,
        userId,
        current,
        (basketFetchOptions.now ?? (() => new Date()))()
      );
    } catch (error) {
      return mapBasketError(error, errors);
    }
  });

export const basketsRouter = {
  list: basketsList,
  create: basketsCreate,
  update: basketsUpdate,
  remove: basketsRemove,
  valuation: basketsValuation,
};
