import { z } from "zod";

// Yahoo chart parser of the research screen: the quote with the identity fields of the
// instrument (type, currency, time zone, regular session) and the daily bars.
// Research only: no order path. A malformed answer never throws; it gives a null quote and no bars.

export interface ResearchScreenQuote {
  currency: string | null;
  instrumentType: string | null;
  price: number | null;
  quoteAt: Date | null;
  sessionEnd: Date | null;
  sessionStart: Date | null;
  timeZone: string | null;
}

export interface ResearchScreenBar {
  c: number;
  date: string;
  h: number;
  l: number;
  o: number;
}

export interface ResearchScreenChart {
  bars: ResearchScreenBar[];
  quote: ResearchScreenQuote | null;
}

/** Largest count of seconds that a Date can hold. */
const MAX_EPOCH_SECONDS = 8_640_000_000_000;

const finite = z.number().finite();
const epochSeconds = finite.min(0).max(MAX_EPOCH_SECONDS);
const instant = epochSeconds
  .transform((seconds) => new Date(seconds * 1000))
  .nullable()
  .catch(null);
const label = z.string().trim().min(1).max(64).nullable().catch(null);
const column = z.array(z.unknown()).catch([]);

const SessionSchema = z
  .looseObject({
    regular: z.looseObject({ end: instant, start: instant }),
  })
  .transform((period) => period.regular)
  .catch({ end: null, start: null });

const MetaSchema = z
  .looseObject({
    currency: label,
    currentTradingPeriod: SessionSchema,
    exchangeTimezoneName: label,
    instrumentType: label,
    regularMarketPrice: finite.positive().nullable().catch(null),
    regularMarketTime: instant,
  })
  .nullable()
  .catch(null);

const ColumnsSchema = z.looseObject({
  close: column,
  high: column,
  low: column,
  open: column,
});

const IndicatorsSchema = z
  .looseObject({ quote: z.tuple([ColumnsSchema], z.unknown()) })
  .transform((indicators) => indicators.quote[0])
  .catch({ close: [], high: [], low: [], open: [] });

const ChartSchema = z.looseObject({
  chart: z.looseObject({
    result: z.tuple(
      [
        z.looseObject({
          indicators: IndicatorsSchema,
          meta: MetaSchema,
          timestamp: column,
        }),
      ],
      z.unknown()
    ),
  }),
});

const BarSchema = z.object({
  c: finite,
  h: finite,
  l: finite,
  o: finite,
  t: epochSeconds,
});

const dateFormat = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  });

/** Calendar-date formatter of the zone; UTC when the zone is missing or not accepted by Intl. */
const zoneDateFormat = (timeZone: string | null): Intl.DateTimeFormat => {
  try {
    return dateFormat(timeZone ?? "UTC");
  } catch {
    return dateFormat("UTC");
  }
};

export const researchScreenChartUrl = (providerSymbol: string): string =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}?range=1y&interval=1d&includePrePost=false`;

export const parseResearchScreenChart = (
  json: unknown
): ResearchScreenChart => {
  const parsed = ChartSchema.safeParse(json);
  if (!parsed.success) {
    return { bars: [], quote: null };
  }
  const [result] = parsed.data.chart.result;
  const { indicators, meta, timestamp } = result;
  const quote: ResearchScreenQuote | null =
    meta === null
      ? null
      : {
          currency: meta.currency,
          instrumentType: meta.instrumentType,
          price: meta.regularMarketPrice,
          quoteAt: meta.regularMarketTime,
          sessionEnd: meta.currentTradingPeriod.end,
          sessionStart: meta.currentTradingPeriod.start,
          timeZone: meta.exchangeTimezoneName,
        };
  const format = zoneDateFormat(quote === null ? null : quote.timeZone);
  const bars: ResearchScreenBar[] = [];
  const seen = new Set<string>();
  timestamp.forEach((t, index) => {
    const bar = BarSchema.safeParse({
      c: indicators.close[index],
      h: indicators.high[index],
      l: indicators.low[index],
      o: indicators.open[index],
      t,
    });
    if (!bar.success) {
      return;
    }
    const date = format.format(new Date(bar.data.t * 1000));
    if (seen.has(date)) {
      return;
    }
    seen.add(date);
    bars.push({
      c: bar.data.c,
      date,
      h: bar.data.h,
      l: bar.data.l,
      o: bar.data.o,
    });
  });
  return { bars, quote };
};
