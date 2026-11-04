// What: Pure index math for custom baskets ("fake ETFs"). No I/O.
// value(t) = sum(w_i * price_i(t) / price_i(base)) * baseValue, with weights normalized to sum 1.
// A date where any member has no close is marked stale with a null value; a missing price is never zero.
// Used by: packages/api/src/server/baskets.ts.

export type DailyClose = Readonly<{ date: string; close: number }>;

export type BasketIndexMember = Readonly<{ symbol: string; weight: number }>;

export type BasketBase = Readonly<{
  date: string;
  prices: Readonly<Record<string, number>>;
  // Benchmark (SPY) close on the base date; null when unknown. Stored with the base so the
  // benchmark line survives after the base date leaves the fetched one-year window.
  benchmark: number | null;
}>;

export type BasketBaseState = "fixed" | "provisional" | "pending";

export type BasketIndexPoint = Readonly<{
  date: string;
  value: number | null;
  benchmark: number | null;
  stale: boolean;
  missing: readonly string[];
}>;

export type BasketMemberContribution = Readonly<{
  symbol: string;
  weight: number;
  basePrice: number | null;
  lastPrice: number | null;
  lastDate: string | null;
  returnPct: number | null;
  // Index points this member adds above or below baseValue at the latest valued date.
  contribution: number | null;
  stale: boolean;
}>;

export type BasketIndexResult = Readonly<{
  baseState: BasketBaseState;
  base: BasketBase | null;
  // Set when the first full session close after creation is now known; the caller persists it.
  newlyFixedBase: BasketBase | null;
  points: readonly BasketIndexPoint[];
  latest: Readonly<{
    date: string;
    value: number;
    changePct: number;
    dayChangePct: number | null;
    benchmark: number | null;
  }> | null;
  staleSymbols: readonly string[];
  members: readonly BasketMemberContribution[];
}>;

export type BasketIndexInput = Readonly<{
  members: readonly BasketIndexMember[];
  closes: Readonly<Record<string, readonly DailyClose[] | null>>;
  benchmark: readonly DailyClose[] | null;
  storedBase: BasketBase | null;
  baseValue: number;
  // Start of the current membership: creation, or the last member change (base cleared).
  anchorAt: Date;
  now: Date;
  // Earliest time the member closes were fetched from the source (null = unknown). A base is fixed
  // only from data fetched after that session's close, so a cached intraday bar never becomes the base.
  dataAsOf: Date | null;
}>;

const NEW_YORK = "America/New_York";
// A membership set before the 09:30 open includes that day's session.
const SESSION_OPEN_MINUTES = 9 * 60 + 30;
// Daily bars become final after the 16:00 close; allow 15 minutes for the last print.
const SESSION_FINAL_MINUTES = 16 * 60 + 15;

const newYorkParts = (
  at: Date
): Readonly<{ date: string; minutes: number }> => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NEW_YORK,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = Object.fromEntries(
    parts.map((entry) => [entry.type, entry.value])
  ) as Readonly<Record<string, string>>;
  return {
    date: `${value["year"]}-${value["month"]}-${value["day"]}`,
    minutes: Number(value["hour"]) * 60 + Number(value["minute"]),
  };
};

export const barDate = (epochSeconds: number): string => {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
};

export const normalizeWeights = (
  members: readonly BasketIndexMember[]
): BasketIndexMember[] => {
  const sum = members.reduce((total, member) => total + member.weight, 0);
  return members.map((member) => ({
    symbol: member.symbol,
    weight: sum > 0 ? member.weight / sum : 0,
  }));
};

const closeMap = (
  closes: readonly DailyClose[] | null
): ReadonlyMap<string, number> => {
  const map = new Map<string, number>();
  for (const entry of closes ?? []) {
    if (Number.isFinite(entry.close) && entry.close > 0) {
      map.set(entry.date, entry.close);
    }
  }
  return map;
};

const isSessionFinal = (date: string, now: Date): boolean => {
  const current = newYorkParts(now);
  return (
    date < current.date ||
    (date === current.date && current.minutes >= SESSION_FINAL_MINUTES)
  );
};

export const computeBasketIndex = (
  input: BasketIndexInput
): BasketIndexResult => {
  const members = normalizeWeights(input.members).map((member) => {
    const map = closeMap(input.closes[member.symbol] ?? null);
    return { ...member, map, lastDate: [...map.keys()].sort().at(-1) ?? null };
  });
  const benchmark = closeMap(input.benchmark);
  const dates = [
    ...new Set(members.flatMap((member) => [...member.map.keys()])),
  ].sort();
  const missingOn = (date: string): string[] =>
    members
      .filter((member) => !member.map.has(date))
      .map((member) => member.symbol);
  const complete = dates.filter((date) => missingOn(date).length === 0);
  // Only called for complete dates, so every member has a close.
  const pricesOn = (date: string): Record<string, number> =>
    Object.fromEntries(
      members.map((member) => [member.symbol, member.map.get(date) as number])
    );

  let base: BasketBase | null =
    input.storedBase === null
      ? null
      : {
          ...input.storedBase,
          benchmark:
            input.storedBase.benchmark ??
            benchmark.get(input.storedBase.date) ??
            null,
        };
  let baseState: BasketBaseState = base === null ? "pending" : "fixed";
  let newlyFixedBase: BasketBase | null = null;
  if (base === null) {
    const anchor = newYorkParts(input.anchorAt);
    const firstAfter = complete.find(
      (date) =>
        (date > anchor.date ||
          (date === anchor.date && anchor.minutes < SESSION_OPEN_MINUTES)) &&
        isSessionFinal(date, input.now) &&
        input.dataAsOf !== null &&
        isSessionFinal(date, input.dataAsOf)
    );
    const latestFinal =
      complete.findLast((date) => isSessionFinal(date, input.now)) ??
      complete.at(-1);
    const baseOn = (date: string): BasketBase => ({
      date,
      prices: pricesOn(date),
      benchmark: benchmark.get(date) ?? null,
    });
    if (firstAfter !== undefined) {
      base = baseOn(firstAfter);
      newlyFixedBase = base;
      baseState = "fixed";
    } else if (latestFinal !== undefined) {
      base = baseOn(latestFinal);
      baseState = "provisional";
    }
  }

  const basePrice = (symbol: string): number | null => {
    const price = base?.prices[symbol];
    return price !== undefined && price > 0 ? price : null;
  };
  const benchmarkBase = base?.benchmark ?? null;
  const points: BasketIndexPoint[] = dates.map((date) => {
    const missing = missingOn(date);
    const benchmarkClose = benchmark.get(date);
    const benchmarkValue =
      benchmarkBase === null || benchmarkClose === undefined
        ? null
        : (benchmarkClose / benchmarkBase) * input.baseValue;
    // A member without a base price cannot be valued; never drop it silently.
    const unpriced = members.some(
      (member) => basePrice(member.symbol) === null
    );
    if (base === null || missing.length > 0 || unpriced) {
      return {
        date,
        value: null,
        benchmark: benchmarkValue,
        stale: true,
        missing,
      };
    }
    let ratio = 0;
    for (const member of members) {
      ratio +=
        (member.weight * (member.map.get(date) as number)) /
        (basePrice(member.symbol) as number);
    }
    return {
      date,
      value: ratio * input.baseValue,
      benchmark: benchmarkValue,
      stale: false,
      missing,
    };
  });

  const valued = points.filter((point) => point.value !== null);
  const last = valued.at(-1);
  // The session just before the latest value; a stale one gives no day change.
  const previous =
    last === undefined ? undefined : points[points.indexOf(last) - 1];
  const lastDateOverall = dates.at(-1);
  const staleSymbols = members
    .filter((member) => member.lastDate !== lastDateOverall)
    .map((member) => member.symbol);

  const latest =
    last === undefined || last.value === null
      ? null
      : {
          date: last.date,
          value: last.value,
          changePct: (last.value / input.baseValue - 1) * 100,
          dayChangePct:
            previous === undefined || previous.value === null
              ? null
              : (last.value / previous.value - 1) * 100,
          benchmark: last.benchmark,
        };

  const contributions: BasketMemberContribution[] = members.map((member) => {
    const price = basePrice(member.symbol);
    const lastPrice =
      member.lastDate === null
        ? null
        : (member.map.get(member.lastDate) as number);
    const valuedPrice =
      latest === null ? null : (member.map.get(latest.date) as number);
    return {
      symbol: member.symbol,
      weight: member.weight,
      basePrice: price,
      lastPrice,
      lastDate: member.lastDate,
      returnPct:
        price !== null && lastPrice !== null
          ? (lastPrice / price - 1) * 100
          : null,
      contribution:
        price !== null && valuedPrice !== null
          ? member.weight * (valuedPrice / price - 1) * input.baseValue
          : null,
      stale: staleSymbols.includes(member.symbol),
    };
  });

  return {
    baseState,
    base,
    newlyFixedBase,
    points,
    latest,
    staleSymbols,
    members: contributions,
  };
};
