import {
  type BasketRepository,
  type BasketWithMembers,
  DatabaseConflictError,
  DatabasePersistenceError,
  equalBasketWeights,
  InvalidRepositoryInputError,
  type PickListMemberRow,
  type PickListRepository,
  type PickListWithLatest,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";
import { z } from "zod";

import { appContract } from "../contract.ts";
import { BASKET_MAX_MEMBERS } from "../contracts/baskets.ts";
import {
  PICK_LIST_SCREEN_MAX_MEMBERS,
  type PickListImportInput,
  type PickListOutput,
} from "../contracts/pick-lists.ts";
import { SECTOR_ROTATION_BENCHMARK } from "../contracts/sector-rotation.ts";
import {
  closesOf,
  notScreenedMember,
  type ScreenBar,
  screenMember,
  sectorEtfFor,
} from "../pick-list-screen.ts";
import type { ApiContext } from "./context.ts";
import type { DeployStatusFetch } from "./deploy-status.ts";
import { requireOperator } from "./operator-access.ts";
import { fetchBoundedJson, type ResearchLensError } from "./research-lenses.ts";

// Pick-list procedures (pickLists.*). Operator-only; the owner is the authenticated operator and
// inputs never carry a user id. import stores one dated snapshot, list returns every list with its
// latest snapshot, syncBucket turns the latest snapshot into an equal-weight basket, and screen
// reads one year of public Yahoo daily bars for the first 60 members in rank order (plus SPY and
// sector ETFs; 10-minute in-process cache) for the trend gates and rotation quadrants. Research
// only: no order path.

const api = implement(appContract).$context<ApiContext>();

const YAHOO_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) vertex-research/pick-lists";
const YAHOO_MAX_BYTES = 4 * 1024 * 1024;
const YAHOO_TIMEOUT_MS = 10_000;
const FETCH_CONCURRENCY = 4;
const SCREEN_RANGE = "1y";
/** US regular session length; a newest bar quoted before its end is still live. */
const REGULAR_SESSION_SECONDS = 6.5 * 60 * 60;
const BARS_CACHE_TTL_MS = 10 * 60_000;
const BARS_CACHE_MAX_ENTRIES = 400;
const WEIGHT_DIGITS = 8;
const PRICE_DIGITS = 4;

export type PickListOptions = Readonly<{
  /** Yahoo chart fetch. */
  fetch?: DeployStatusFetch;
  now?: () => Date;
}>;

let options: PickListOptions = {};
const barsCache = new Map<
  string,
  Readonly<{ at: number; bars: ScreenBar[] }>
>();

/** Replaces the fetch and clock seams and clears the bars cache. */
export const setPickListOptionsForTesting = (next: PickListOptions): void => {
  options = next;
  barsCache.clear();
};

const clock = (): Date => (options.now ?? (() => new Date()))();

type PickListErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "STORAGE_ERROR";

type Failures = Readonly<
  Record<PickListErrorCode, (options?: { message?: string }) => Error>
>;

const factories = (errors: unknown): Failures => errors as Failures;

const pickListsFor = (
  context: ApiContext,
  failures: Failures
): PickListRepository => {
  const repository = context.repositories.pickLists;
  if (repository === undefined) throw failures.STORAGE_ERROR();
  return repository;
};

const basketsFor = (
  context: ApiContext,
  failures: Failures
): BasketRepository => {
  const repository = context.repositories.baskets;
  if (repository === undefined) throw failures.STORAGE_ERROR();
  return repository;
};

const mapError = (error: unknown, failures: Failures): never => {
  if (error instanceof InvalidRepositoryInputError)
    throw failures.VALIDATION_ERROR({ message: error.message });
  if (error instanceof DatabaseConflictError) throw failures.CONFLICT();
  if (error instanceof DatabasePersistenceError) throw failures.STORAGE_ERROR();
  throw error;
};

/** A finite non-negative number as a plain decimal string with at most `digits` fraction digits. */
export const toDecimalString = (value: number, digits: number): string => {
  const text = value.toFixed(digits).replace(/0+$/u, "").replace(/\.$/u, "");
  // toFixed switches to exponent notation from 1e21, which no numeric column accepts.
  if (!/^\d+(\.\d+)?$/u.test(text))
    throw new InvalidRepositoryInputError(`${value} is out of range`);
  return text;
};

const nullableNumber = (value: string | null): number | null =>
  value === null ? null : Number(value);

const toPickListOutput = ({
  list,
  latest,
  snapshotCount,
}: PickListWithLatest): PickListOutput => ({
  id: list.id,
  source: list.source,
  sourceLabel: list.sourceLabel,
  slug: list.slug,
  name: list.name,
  bucketSymbol: list.bucketSymbol,
  snapshotCount,
  latest: {
    id: latest.id,
    asOf: latest.asOf,
    method: latest.method,
    importedAt: latest.importedAt.toISOString(),
    members: latest.members.map((member) => ({
      symbol: member.symbol,
      rank: member.rank,
      weight: nullableNumber(member.weight),
      sector: member.sector,
      rating: member.rating,
      thesis: member.thesis,
      targetPrice: nullableNumber(member.targetPrice),
      addedOn: member.addedOn,
    })),
  },
});

type ImportMember = PickListImportInput["members"][number];

const toMemberRow = (member: ImportMember): PickListMemberRow => ({
  symbol: member.symbol,
  rank: member.rank ?? null,
  weight:
    member.weight === undefined
      ? null
      : toDecimalString(member.weight, WEIGHT_DIGITS),
  sector: member.sector ?? null,
  rating: member.rating ?? null,
  thesis: member.thesis ?? null,
  targetPrice:
    member.targetPrice === undefined
      ? null
      : toDecimalString(member.targetPrice, PRICE_DIGITS),
  addedOn: member.addedOn ?? null,
});

/** Rank ascending (unranked last), then symbol. */
const inRankOrder = (
  members: readonly PickListMemberRow[]
): PickListMemberRow[] =>
  [...members].sort(
    (a, b) =>
      (a.rank ?? Number.POSITIVE_INFINITY) -
        (b.rank ?? Number.POSITIVE_INFINITY) || a.symbol.localeCompare(b.symbol)
  );

/** Members in rank order: the bucket keeps the first 50. */
export const orderForBucket = (
  members: readonly PickListMemberRow[]
): Readonly<{ kept: string[]; omitted: string[] }> => {
  const ordered = inRankOrder(members).map((member) => member.symbol);
  return {
    kept: ordered.slice(0, BASKET_MAX_MEMBERS),
    omitted: ordered.slice(BASKET_MAX_MEMBERS),
  };
};

const nullableNumbers = z.array(z.number().nullable()).optional();

const OhlcvChartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          indicators: z.object({
            quote: z
              .array(
                z.object({
                  open: nullableNumbers,
                  high: nullableNumbers,
                  low: nullableNumbers,
                  close: nullableNumbers,
                  volume: nullableNumbers,
                })
              )
              .optional(),
          }),
          meta: z
            .object({
              regularMarketPrice: z.number().nullable().optional(),
              regularMarketTime: z.number().nullable().optional(),
            })
            .optional(),
          timestamp: z.array(z.number()).optional(),
        })
      )
      .nullable(),
  }),
});

type BarsResult =
  | Readonly<{ ok: true; bars: ScreenBar[] }>
  | Readonly<{ ok: false; reason: string }>;

const utcDate = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().slice(0, 10);

const isPositive = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Daily OHLCV bars from one Yahoo chart, oldest first, one per UTC date (unadjusted, so the
 * high, low and close agree). Rows without a positive open, high, low and close are dropped; a
 * missing volume counts as 0. The newest bar is dropped while its session is still running; after
 * the session Yahoo can leave its close empty for some hours, and the quote price fills it.
 */
const fetchDailyOhlcv = async (symbol: string): Promise<BarsResult> => {
  let raw: unknown;
  try {
    raw = await fetchBoundedJson(
      {
        headers: { "user-agent": YAHOO_USER_AGENT },
        label: "Yahoo chart",
        maxBytes: YAHOO_MAX_BYTES,
        url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.replace(/[./]/gu, "-"))}?range=${SCREEN_RANGE}&interval=1d`,
      },
      {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        timeoutMs: YAHOO_TIMEOUT_MS,
      }
    );
  } catch (error) {
    // fetchBoundedJson reports every failure as a ResearchLensError without the URL.
    return { ok: false, reason: (error as ResearchLensError).message };
  }
  const parsed = OhlcvChartSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, reason: "Yahoo returned an unexpected document" };
  const result = parsed.data.chart.result?.[0];
  const quote = result?.indicators.quote?.[0];
  const timestamps = result?.timestamp ?? [];
  const opened = timestamps.at(-1) ?? 0;
  const quoted = result?.meta?.regularMarketTime ?? 0;
  const quotedOnNewest = utcDate(quoted) === utcDate(opened);
  const sessionOver = quoted >= opened + REGULAR_SESSION_SECONDS;
  const price = result?.meta?.regularMarketPrice;
  const byDate = new Map<string, ScreenBar>();
  timestamps.forEach((time, index) => {
    const o = quote?.open?.[index];
    const h = quote?.high?.[index];
    const l = quote?.low?.[index];
    let c = quote?.close?.[index];
    // The newest bar's empty close after its session is the closing quote.
    if (
      index === timestamps.length - 1 &&
      quotedOnNewest &&
      sessionOver &&
      !isPositive(c) &&
      isPositive(price)
    )
      c = price;
    if (!(isPositive(o) && isPositive(h) && isPositive(l) && isPositive(c)))
      return;
    const date = utcDate(time);
    byDate.set(date, {
      date,
      o,
      h: Math.max(h, c),
      l: Math.min(l, c),
      c,
      v: quote?.volume?.[index] ?? 0,
    });
  });
  // The newest bar holds a live price while its session runs: it is not a daily close yet.
  if (quotedOnNewest && !sessionOver) byDate.delete(utcDate(opened));
  if (byDate.size === 0)
    return { ok: false, reason: "Yahoo has no daily bars for this symbol" };
  return {
    ok: true,
    bars: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
};

/** Cached bars when fresh, else one fetch; only successful results are cached. */
const loadBars = async (symbol: string): Promise<BarsResult> => {
  const now = clock().getTime();
  const cached = barsCache.get(symbol);
  if (cached !== undefined && now - cached.at < BARS_CACHE_TTL_MS)
    return { ok: true, bars: cached.bars };
  const result = await fetchDailyOhlcv(symbol);
  if (result.ok) {
    barsCache.delete(symbol);
    if (barsCache.size >= BARS_CACHE_MAX_ENTRIES) {
      const oldest = barsCache.keys().next().value as string;
      barsCache.delete(oldest);
    }
    barsCache.set(symbol, { at: now, bars: result.bars });
  }
  return result;
};

/** Bars for each symbol, a few requests at a time. */
const loadAllBars = async (
  symbols: readonly string[]
): Promise<Map<string, BarsResult>> => {
  const out = new Map<string, BarsResult>();
  for (let start = 0; start < symbols.length; start += FETCH_CONCURRENCY) {
    const batch = symbols.slice(start, start + FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map(loadBars));
    batch.forEach((symbol, index) => {
      out.set(symbol, results[index] as BarsResult);
    });
  }
  return out;
};

const closesFrom = (result: BarsResult | undefined) =>
  result?.ok === true ? closesOf(result.bars) : null;

const importSnapshot = api.pickLists.import
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = factories(errors);
    const repository = pickListsFor(context, failures);
    try {
      return toPickListOutput(
        await repository.importSnapshot({
          userId: context.principal.userId,
          source: input.source,
          sourceLabel: input.sourceLabel,
          slug: input.list.slug,
          name: input.list.name,
          asOf: input.asOf,
          method: input.method,
          members: input.members.map(toMemberRow),
        })
      );
    } catch (error) {
      return mapError(error, failures);
    }
  });

const listPickLists = api.pickLists.list
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = factories(errors);
    const repository = pickListsFor(context, failures);
    try {
      const items = await repository.listByUser(context.principal.userId);
      return { items: items.map(toPickListOutput) };
    } catch (error) {
      return mapError(error, failures);
    }
  });

const syncBucket = api.pickLists.syncBucket
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = factories(errors);
    const pickLists = pickListsFor(context, failures);
    const baskets = basketsFor(context, failures);
    const userId = context.principal.userId;
    const symbol = input.bucketSymbol;
    try {
      const found = await pickLists.get(input.id, userId);
      if (found === null) throw failures.NOT_FOUND();
      const { kept, omitted } = orderForBucket(found.latest.members);
      const weights = equalBasketWeights(kept.length);
      const members = kept.map((member, index) => ({
        symbol: member,
        weight: weights[index] as string,
      }));
      const name = found.list.name;
      const owned = await baskets.listByUser(userId);
      const existing = owned.find((entry) => entry.basket.symbol === symbol);
      let basket: BasketWithMembers | null = null;
      if (existing !== undefined) {
        // Only the basket this list created is its bucket; any other basket keeps the symbol.
        if (existing.basket.id !== found.list.bucketBasketId)
          throw failures.CONFLICT();
        basket = await baskets.update({
          id: existing.basket.id,
          userId,
          name,
          members,
        });
      }
      let created: BasketWithMembers | null = null;
      if (basket === null) {
        // The bucket is new or was removed: create it.
        created = await baskets.create({ userId, symbol, name, members });
        basket = created;
      }
      // A basket created here is removed again when the list cannot record it, so a retry
      // does not meet its own orphan as a CONFLICT. Removal is best effort; the cause is rethrown.
      const discardCreated = async (): Promise<void> => {
        if (created !== null)
          await baskets.remove(created.basket.id, userId).catch(() => false);
      };
      let updated: PickListWithLatest | null;
      try {
        updated = await pickLists.setBucket(
          input.id,
          userId,
          symbol,
          basket.basket.id
        );
      } catch (error) {
        await discardCreated();
        throw error;
      }
      if (updated === null) {
        await discardCreated();
        throw failures.NOT_FOUND();
      }
      return {
        list: toPickListOutput(updated),
        basketId: basket.basket.id,
        memberCount: kept.length,
        omitted,
      };
    } catch (error) {
      return mapError(error, failures);
    }
  });

const screen = api.pickLists.screen
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = factories(errors);
    const repository = pickListsFor(context, failures);
    let found: PickListWithLatest | null;
    try {
      found = await repository.get(input.id, context.principal.userId);
    } catch (error) {
      return mapError(error, failures);
    }
    if (found === null) throw failures.NOT_FOUND();
    const ordered = inRankOrder(found.latest.members);
    const members = ordered.slice(0, PICK_LIST_SCREEN_MAX_MEMBERS);
    const symbols = [
      ...new Set([
        SECTOR_ROTATION_BENCHMARK,
        ...members.map((member) => member.symbol),
        ...members.flatMap((member) => sectorEtfFor(member.sector) ?? []),
      ]),
    ];
    const loaded = await loadAllBars(symbols);
    const benchmark = closesFrom(loaded.get(SECTOR_ROTATION_BENCHMARK));
    return {
      listId: found.list.id,
      snapshotId: found.latest.id,
      computedAt: clock().toISOString(),
      members: [
        ...members.map((member) => {
          // Every screened member symbol was requested, so its result exists.
          const result = loaded.get(member.symbol) as BarsResult;
          const etf = sectorEtfFor(member.sector);
          return screenMember({
            symbol: member.symbol,
            sector: member.sector,
            bars: result.ok ? result.bars : null,
            reason: result.ok ? null : result.reason,
            benchmark,
            sectorCloses: etf === null ? null : closesFrom(loaded.get(etf)),
          });
        }),
        ...ordered
          .slice(PICK_LIST_SCREEN_MAX_MEMBERS)
          .map((member) => notScreenedMember(member.symbol, member.sector)),
      ],
    };
  });

export const pickListsRouter = {
  import: importSnapshot,
  list: listPickLists,
  screen,
  syncBucket,
};
